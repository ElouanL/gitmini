# Architecture

The Rust workspace contains three packages:

- `gitmini-core`: repository state, reads, serialized Git writes, operation tracking, caches and GitHub integration.
- `gitmini`: the Tauri desktop application, restricted IPC permissions, native dialogs, logging and updates.
- `gitmini-bridge`: a loopback HTTP/SSE development host for the same core. It enables browser testing without a native WebView.

The frontend is Svelte 5 with TypeScript and Vite. Repository tabs own separate sessions and stores. Async work captures its session and generation so a late response cannot update another tab. Shared UI state includes application settings, toasts, the GitHub account and the desktop updater.

## Git operations

Reads use `gix` and caches. Writes use the Git CLI through the core write runner, which owns locking, cancellation, process isolation and operation state. Git subprocesses use predictable locale and noninteractive credential behavior. Destructive operations use the existing confirmation and recovery flows. Content thrown away by a discard or a conflict resolution is first stored as unreachable blobs and listed in `<git_dir>/gitmini/discarded.jsonl`, from where `discard_restore` writes it back. `file_log` and `file_blame` are `gix` reads: `file_log` walks the commits that changed a path with git's default history simplification (and follows renames, the cursor of its pages being the walk's frontier, so the backend keeps no state); `file_blame` annotates a file at one commit with `gix::Repository::blame_file`. In a shallow repository both read the commits listed in `shallow` as roots, as git does (the blame runs over an object database that hides their parents), and `commit_details` and the commit diffs do the same. `merge_preview` is the dry run of a merge: it asks `git merge-tree --write-tree` (git 2.38 or newer) what merging two commits would do, so refs, index and worktree stay untouched; the only things written are unreachable objects, which `git gc` prunes.

## IPC

`src-tauri/src/ipc/mod.rs` registers desktop commands. `src-tauri/commands.txt` declares the corresponding Tauri permissions; `capabilities/default.json` grants them explicitly. `scripts/check-commands.mjs` checks their agreement. Shared core commands are dispatched separately by the development bridge; desktop updater commands are not exposed through it.

Rust types are exported with Specta into `src/lib/ipc/types.ts`. Run `just gen-types` after changing them. Frontend invocations and event subscriptions live in `src/lib/ipc`.

## UI and messages

Actions, menus, dialogs and panels use small registries. Feature domains register their behavior; larger views load lazily. All application-authored UI messages use the English catalogs through `src/i18n/index.ts`. Backend errors contain stable codes and details plus an English display message.

`src/lib/feature-flags.ts` reads compile-time flags. `VITE_GITMINI_GITHUB_LOGIN=1` enables the GitHub account UI; it is off otherwise. Test builds enable it explicitly when exercising the GitHub flows.

## Updates

The desktop Rust backend owns updater downloads, signature verification and installation. The frontend controller waits for safe application state before restarting. Production release configuration embeds the public key and HTTPS endpoint; development, E2E and package-manager installations disable automatic updates where appropriate.
