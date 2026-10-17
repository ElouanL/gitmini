# gitmini

A small, fast desktop Git client built with Tauri, Svelte and Rust. Git reads use `gix`; repository changes run through the Git CLI.

## Features

- Commit graph, history search and diffs.
- Staging, commits, branches, merges, rebase, cherry-pick, revert and branch reset.
- Line-by-line staging: stage, unstage or discard only the selected lines of a hunk (click the gutter, Shift+click for a range).
- Readable diffs: the words that changed inside a line are highlighted, and the number of context lines (1 to 25, default 3) is adjustable from the diff header, Settings or the palette.
- One-click conflict resolution: take ours or theirs from the file list or the conflict diff.
- Merge preview: see whether a merge would conflict, and in which files, before starting it, in the merge dialog and after dropping one branch onto another (needs git 2.38 or newer).
- Discarded work is kept: restore a file, hunk or conflict side you threw away from the Discarded tab of the reflog panel (kept as Git objects, for about two weeks).
- File history and blame: the commits that changed a file (across renames) with what each one changed, and every line of the file annotated with the commit behind it; open them from a diff, a file's context menu or the palette.
- Stashes, remotes, fetch, pull and push.
- Tags: create lightweight or annotated tags on any commit, push one to a remote, delete one on a remote (after a confirmation), delete locally with undo.
- Optional background fetch (Settings, off by default) with a Pull toast when your branch falls behind.
- Sidebar with branch and tag folders by prefix and a live filter.
- Command palette (Cmd/Ctrl+K) with fuzzy search and the commands you ran last on top; type `@` to jump to a branch or tag (Cmd/Ctrl+Enter checks it out), `#` to find a commit by subject or sha, `/` to switch between repositories.
- Multiple repository tabs and recovery tools for supported operations.
- Automatic updates in configured release builds.

GitHub account sign-in is currently disabled. Cloning and configuring remotes by URL remain available; SSH and Git credential helpers can provide authentication.

## Install

Download an installer from this repository's **Releases** page: DMG for macOS (Apple Silicon or Intel), `-setup.exe` for Windows, or AppImage/DEB for Linux. Git 2.30 or newer must be installed and available in `PATH`.

The initial macOS builds use an ad hoc signature and are not notarized. After the first launch attempt, authorize the application in **System Settings → Privacy & Security → Open Anyway**. The Windows installer installs for the current user only and needs no administrator rights, but it initially has no Authenticode signature: SmartScreen may show "Windows protected your PC" (**More info → Run anyway**). Check the release's `SHA256SUMS` before installing. See the [code signing policy](docs/code-signing-policy.md).

Automatic updates use a separate cryptographic signature. They are supported by the macOS, Windows and Linux AppImage builds; DEB installations are updated manually or through a package manager.

## Develop

Prerequisites: Git ≥ 2.30, Rust stable (minimum 1.88), Node.js 24 or newer, pnpm 10.6.1, Python 3, Bash and [just](https://just.systems). Install the platform's Tauri build dependencies and Tauri CLI 2:

```sh
cargo install tauri-cli --locked --version '^2'
pnpm install --frozen-lockfile
pnpm --dir tests/e2e install --frozen-lockfile
just dev
```

For the frontend with demo data, run `pnpm dev` and open `http://localhost:1420/?mock=1`. To use the real backend in a browser, see the [development bridge](crates/gitmini-bridge/README.md).

```sh
pnpm check          # Frontend types
pnpm lint           # Frontend and script lint
pnpm test           # Frontend tests
just test           # Rust tests and doctests (requires cargo-nextest)
just lint           # Full repository checks (requires cargo-deny)
just build          # Desktop installers
```

See [CONTRIBUTING.md](CONTRIBUTING.md), [architecture](docs/architecture.md), [testing](docs/testing.md) and [releases](docs/releases.md).

## License

Copyright (c) 2026 gitmini contributors. Licensed under [GNU GPL version 3 only](LICENSE) (`GPL-3.0-only`). Third-party dependencies retain their own licenses. See [NOTICE](NOTICE) for bundled third-party assets. The software is provided without warranty; the full terms are in `LICENSE`.
