# Releases

Release builds are produced from an existing `vX.Y.Z` tag. The workspace and root npm package versions must match the tag. The first version is `v0.1.0`.

The tag must point to a commit of `master` whose `ci` check succeeded: the `prepare` job refuses any other tag before anything is built. Merge the release pull request, wait for `ci` to pass on `master`, then tag that commit. Every job then builds the commit resolved by `prepare`, even if the tag is moved during the run.

## Signing policy

macOS uses an ad hoc signature (`bundle.macOS.signingIdentity = "-"`), without a paid Apple account or notarization. Test both Apple Silicon and Intel packages where available. The first launch needs explicit authorization in **System Settings → Privacy & Security**.

The Windows installer is an NSIS `-setup.exe` configured with `installMode = "currentUser"`: it installs under `%LOCALAPPDATA%\Programs`, needs no administrator rights, and its updates do not need elevation either. It initially has no Authenticode signature. Updater packages on every supported platform are signed with the same persistent Tauri key; this signature authenticates updates independently of operating-system code signing.

## One-time updater setup

Generate a key outside the repository:

```sh
node scripts/setup-updater-key.mjs
```

The helper refuses to overwrite an existing key and prints only the public key and file location. Keep a private backup of the key and password. Reuse the same key for future releases: generating a different key would break updates for installed versions.

Configure GitHub Actions:

| Kind | Name | Value |
| --- | --- | --- |
| `release` environment secret | `TAURI_SIGNING_PRIVATE_KEY` | Contents of the private key file |
| `release` environment secret | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password chosen during generation |
| Variable | `GITMINI_UPDATER_PUBKEY` | Contents of the public `.pub` file |
| Optional variable | `GITMINI_UPDATER_ENDPOINT` | Custom HTTPS update endpoint |

### The `release` environment

Only the `sign-updater` job reads the private key. The build jobs run third-party npm and Cargo code (`pnpm install`, Vite, build scripts), so they sign the updater artifacts with a throwaway key generated for the run; `sign-updater` installs no npm package, signs every updater artifact again with the release key and replaces the signatures in the draft and in `latest.json`. A signature left over from the build fails that job and the `assets` verification.

Create the environment once, in **Settings → Environments → New environment**, named `release`:

1. Add the two `TAURI_SIGNING_PRIVATE_KEY*` secrets above as environment secrets, then delete any repository secrets of the same names, which every job could read.
2. Enable **Required reviewers** and add the maintainers allowed to approve a release. The `sign-updater` job then waits for an approval after the builds.
3. Under **Deployment branches and tags**, choose **Selected branches and tags** and add the tag rule `v*` and the branch rule `master` (a manual dispatch runs on the branch it is started from), so that no other ref can reach the key.

The workflow cannot create or check these protections: until the reviewers are set, `sign-updater` runs without waiting.

By default, the workflow uses `https://github.com/${GITHUB_REPOSITORY}/releases/latest/download/latest.json`. GitHub sign-in is disabled and does not require an OAuth client ID. No Apple or GPG signing secrets are required, and Windows signing is optional (see [Windows signing with SignPath](#windows-signing-with-signpath)).

The release workflow requires the updater key and public-key configuration. Ordinary local development and installer builds may leave the updater unconfigured.

## Build and verify

Push the existing version tag or dispatch the `release` workflow with its name. The workflow creates a **draft**, builds macOS ARM64/x64 DMGs and updater archives and the Windows x64 NSIS installer (Linux builds are paused). It verifies the platform matrix, package signatures, signed versions, asset URLs and SHA256 checksums. Failed jobs leave the release unpublished. When SignPath is configured, the `sign-windows` job also replaces the Windows installer with its Authenticode-signed version before the updater signatures are computed. The `sign-updater` job waits for the `release` environment approval: review the run (tag, commit, build logs) before approving it.

Run these smoke tests before publishing:

- Download from the draft and verify `SHA256SUMS`.
- Install the macOS ad hoc build, authorize its first launch and open a disposable repository.
- Exercise history, staging, commit, fetch and a second repository tab.
- Test an update between two different versions signed with the same updater key through a controlled HTTPS test endpoint. Confirm installation/restart succeeds and repository data and saved settings remain intact.
- Confirm a modified update package is rejected. Test the Windows package too.
- On Windows, install from a standard (non-administrator) account: there must be no UAC prompt, and an update between two versions must also run without one.

The existing updater unit/integration tests cover malformed manifests, incorrect keys, altered packages, signed-version mismatches and unsafe restart states; they complement actual installation testing.

## Windows signing with SignPath

The `sign-windows` job runs only when the repository variable `SIGNPATH_ORGANIZATION_ID` is set; otherwise the unsigned installer is published as is and the `ready` job summary says so. It is meant for the free SignPath Foundation program described in the [code signing policy](code-signing-policy.md).

After SignPath approves the project, create a project, a signing policy and an artifact configuration in SignPath, paste [`.signpath/artifact-configuration.xml`](../.signpath/artifact-configuration.xml) as the artifact configuration, add the **GitHub.com** trusted build system to the project and install the SignPath GitHub App on the repository. Then configure GitHub Actions:

| Kind | Name | Value |
| --- | --- | --- |
| Secret | `SIGNPATH_API_TOKEN` | API token of a SignPath user allowed to submit to the signing policy |
| Variable | `SIGNPATH_ORGANIZATION_ID` | SignPath organization ID (enables the job) |
| Variable | `SIGNPATH_PROJECT_SLUG` | SignPath project slug |
| Variable | `SIGNPATH_SIGNING_POLICY_SLUG` | Signing policy used for releases |
| Variable | `SIGNPATH_ARTIFACT_CONFIGURATION_SLUG` | Slug of the pasted artifact configuration |

For each release the workflow:

1. Uploads the unsigned installer from the Windows build as the `unsigned-windows-installer` artifact, so SignPath can verify that it comes from this workflow run.
2. Submits it to SignPath and waits up to two hours for the manual approval described in the code signing policy.
3. Verifies that the returned installer has a valid, timestamped Authenticode signature.
4. Replaces the installer in the draft. Its updater signature is computed afterwards by `sign-updater`, because it covers the installer's bytes.

The `assets` job then verifies the final manifest and signatures exactly as for an unsigned release. If a step fails, re-run the failed jobs: the sign job starts again from the unsigned artifact.

## Pinned tools

The release depends on exact versions, updated deliberately rather than picked up by a new run:

- **Actions** are pinned by commit SHA, with the version in a trailing comment. Dependabot (`.github/dependabot.yml`) proposes updates weekly, a week after their release; check the upstream changes before merging. `dtolnay/rust-toolchain` has no releases and is pinned to a commit of its `master` branch.
- **Rust**: `rust-toolchain.toml` pins the toolchain. When raising it, update `RUST_TOOLCHAIN` in the three workflows too; the `lint` job of `ci` fails if they differ. The `msrv` job checks the workspace with the oldest supported version, the `rust-version` of `Cargo.toml`.
- **Tauri CLI**: `TAURI_CLI_VERSION` in the three workflows (also checked by `lint`). Prefer a version published at least two weeks earlier.

## Publish

Publish the verified draft manually in GitHub Releases and mark it as **Latest**. This exposes `latest.json` at the stable endpoint. Keep release notes in English and disclose the initial platform signing policy. Attach the matching tag's source and retain all updater packages and `.sig` files.

When preparing an intermediate test release, use an explicit HTTPS test endpoint rather than replacing the stable production manifest. A draft or prerelease does not become the repository's public latest release.

## Future signing

Windows signing through SignPath Foundation is wired in the workflow but needs the approved SignPath project above. Developer ID/notarization on macOS and a Windows signing provider can be added later without changing the Tauri updater key. They are intentionally not prerequisites for the initial release.
