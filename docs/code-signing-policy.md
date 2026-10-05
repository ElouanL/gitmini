# Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org).

> **Status:** gitmini has applied for SignPath Foundation code signing. Until the application is approved and the signing workflow is live, Windows installers are published **unsigned**; see the [README](../README.md#install). Remove this note when the first signed release ships.

gitmini is open source software licensed under [GPL-3.0-only](../LICENSE). Its source code is public at <https://github.com/ElouanL/gitmini>, and every release can be downloaded for free from the [Releases page](https://github.com/ElouanL/gitmini/releases).

## What is signed

| Artifact | Platform | Signed with |
| --- | --- | --- |
| `gitmini_<version>_x64-setup.exe` (NSIS installer, per-user, no administrator rights) | Windows x64 | Authenticode, SignPath Foundation certificate |

Nothing else is signed with the SignPath Foundation certificate. In particular:

- macOS builds use an ad hoc signature and are not notarized.
- Linux packages are published with `SHA256SUMS` and are not Authenticode-signed.
- Automatic updates are authenticated by a separate, project-owned Tauri (Minisign) key. That key is unrelated to the SignPath certificate. For Windows, the update signature is computed over the final installer **after** it has been signed by SignPath, so the installer users download and the one the updater verifies are the same file.

Only binaries built from this repository are signed. No third-party or pre-built binaries are submitted. The SignPath artifact configuration ([`.signpath/artifact-configuration.xml`](../.signpath/artifact-configuration.xml)) accepts only an installer named for the release and enforces the product name `gitmini` and a product version equal to the release tag without its leading `v`.

## How a signed release is built

1. A maintainer pushes a `vX.Y.Z` tag. The workspace and npm versions must match the tag; the `release` workflow refuses to run otherwise (`scripts/updater-release.mjs check`).
2. [`.github/workflows/release.yml`](../.github/workflows/release.yml) builds the installers on GitHub-hosted runners from that tag's source, with no manual build step and no locally built binaries.
3. The Windows build uploads the unsigned installer as a GitHub Actions artifact, and the workflow submits it to SignPath through the official SignPath GitHub Action. SignPath verifies the origin (repository, commit and workflow run) of the artifact through its GitHub trusted build system integration, so only an artifact built by this repository's workflow can be signed.
4. An approver manually approves each signing request in SignPath (see below). The signed installer is returned to the workflow.
5. The workflow checks that the returned installer has a valid, timestamped Authenticode signature, re-signs it for the updater and replaces the installer and its update manifest entries in the **draft** release. It then verifies the platform matrix, signatures, asset URLs and SHA256 checksums (`scripts/updater-release.mjs verify`).
6. A maintainer runs the installation and update smoke tests in [`docs/releases.md`](releases.md) and publishes the draft manually.

The signing private key is held by SignPath and is never available to this project or its CI.

## Team roles

| Role | Who | Responsibility |
| --- | --- | --- |
| Committers and reviewers | [@ElouanL](https://github.com/ElouanL) | Write and review changes. Pull requests from other contributors are merged only by a maintainer. |
| Approvers | [@ElouanL](https://github.com/ElouanL) | Approve each SignPath signing request. |

gitmini currently has a single maintainer. When more maintainers join, this table will be updated and approval will be separated from authorship where possible. An approver must approve a request only if all of these hold:

- The request comes from the `release` workflow run for the tag being released.
- The tag matches the intended version and points to a commit on the project's default branch.
- The workflow run completed its verification steps successfully.

Unexpected, unreferenced or repeated signing requests must be rejected.

## Privacy policy

gitmini has no telemetry, analytics or crash reporting. It does not collect, store remotely or sell personal data, and it does not upload repository contents, file paths, commit data or usage statistics to the project or to third parties. Logs and crash files stay on your computer.

gitmini accesses the network only in these cases:

- **Git operations.** Fetch, pull, push and clone run through the Git command-line client against the remotes **you** configure. Any credentials are handled by Git, SSH or your credential helper, not by gitmini.
- **Update checks.** In release builds, gitmini requests a static update manifest (`latest.json`) over HTTPS from the project's GitHub Releases. The request is the standard one any HTTPS client sends (for example your IP address, visible to GitHub as the host); gitmini adds no account identifier and no repository data. You control this under **Settings → Updates**: clear **Download and install updates automatically** to stop automatic checks and downloads. When it is off, the manual **Check for updates** button is the only thing that contacts the update server. Update packages are verified against the project's public key before installation.

GitHub account sign-in is currently disabled and sends nothing.

gitmini can be uninstalled at any time from **Windows Settings → Apps** (installed for the current user) or by deleting the application on other platforms.

## Reporting a problem

Report suspected misuse of this signing policy, a suspicious signed binary or a security vulnerability privately through **Security → Report a vulnerability** on the [repository](https://github.com/ElouanL/gitmini/security), as described in [SECURITY.md](../SECURITY.md).
