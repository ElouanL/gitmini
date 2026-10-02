# Contributing

Bug reports, documentation fixes and focused pull requests are welcome. Use English for project documentation, comments, tests and user-facing messages.

## Setup

Follow the development instructions in the [README](README.md). Use the workspace Rust toolchain and the pnpm version declared in `package.json`. Linux dependencies can be installed with `bash scripts/ci-install-linux-deps.sh build`; macOS needs Xcode Command Line Tools. Windows builds need the Tauri prerequisites, Git and a Bash/Python environment for the fixture scripts.

## Making changes

Keep each change focused and explain the problem, resulting behavior and verification in the pull request. Preserve tests for Unicode paths, unusual Git histories, interrupted operations and multiple repository tabs.

- Put UI messages in `src/i18n/*.en.ts`; use `t` or `tp` from `$i18n/index`.
- Send frontend backend calls through `src/lib/ipc`.
- Use the existing Git write runner for repository mutations; do not write through `gix`.
- Change Rust IPC types at their source and run `just gen-types`. Do not hand-edit the generated TypeScript file.
- Keep test-only hooks out of production builds. GitHub sign-in remains disabled by default.

## Validation

Run the checks relevant to your change, then `just lint` before submitting. Run `pnpm test` for frontend changes and `just test` for Rust changes. Run the relevant E2E scenarios for changes to Git operations or interaction flows. See [testing](docs/testing.md) for fixture generation, browser testing and native WebView coverage.

If a fixture's commits or trees change, regenerate its manifest and review the changed OIDs and snapshots. Do not update snapshots merely to hide a regression.

## Reporting problems

Include the gitmini version, operating system, Git version, steps to reproduce and expected/actual behavior. Use a disposable repository when providing a reproduction. Remove credentials and private repository data from logs.

Report security issues privately using the repository's **Security → Report a vulnerability** page; see [SECURITY.md](SECURITY.md).
