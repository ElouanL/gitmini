# Releases

Release builds are produced from an existing `vX.Y.Z` tag. The workspace and root npm package versions must match the tag. The first version is `v0.1.0`.

## Signing policy

macOS uses an ad hoc signature (`bundle.macOS.signingIdentity = "-"`), without a paid Apple account or notarization. Test both Apple Silicon and Intel packages where available. The first launch needs explicit authorization in **System Settings → Privacy & Security**.

The Windows installer is an NSIS `-setup.exe` configured with `installMode = "currentUser"`: it installs under `%LOCALAPPDATA%\Programs`, needs no administrator rights, and its updates do not need elevation either. It initially has no Authenticode signature. Linux packages include SHA256 checksums. Updater packages on every supported platform are signed with the same persistent Tauri key; this signature authenticates updates independently of operating-system code signing.

## One-time updater setup

Generate a key outside the repository:

```sh
node scripts/setup-updater-key.mjs
```

The helper refuses to overwrite an existing key and prints only the public key and file location. Keep a private backup of the key and password. Reuse the same key for future releases: generating a different key would break updates for installed versions.

Configure GitHub Actions:

| Kind | Name | Value |
| --- | --- | --- |
| Secret | `TAURI_SIGNING_PRIVATE_KEY` | Contents of the private key file |
| Secret | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password chosen during generation |
| Variable | `GITMINI_UPDATER_PUBKEY` | Contents of the public `.pub` file |
| Optional variable | `GITMINI_UPDATER_ENDPOINT` | Custom HTTPS update endpoint |

By default, the workflow uses `https://github.com/${GITHUB_REPOSITORY}/releases/latest/download/latest.json`. GitHub sign-in is disabled and does not require an OAuth client ID. No Apple or GPG signing secrets are required, and Windows signing is optional (see [Windows signing with SignPath](#windows-signing-with-signpath)).

The release workflow requires the updater key and public-key configuration. Ordinary local development and installer builds may leave the updater unconfigured.

## Build and verify

Push the existing version tag or dispatch the `release` workflow with its name. The workflow creates a **draft**, builds macOS ARM64/x64 DMGs and updater archives, Windows x64 NSIS installer, and Linux x64 AppImage/DEB. It verifies the platform matrix, package signatures, signed versions, asset URLs and SHA256 checksums. Failed jobs leave the release unpublished. When SignPath is configured, the `sign-windows` job also replaces the Windows installer with its Authenticode-signed version before the checks run.

Run these smoke tests before publishing:

- Download from the draft and verify `SHA256SUMS`.
- Install the macOS ad hoc build, authorize its first launch and open a disposable repository.
- Exercise history, staging, commit, fetch and a second repository tab.
- Test an update between two different versions signed with the same updater key through a controlled HTTPS test endpoint. Confirm installation/restart succeeds and repository data and saved settings remain intact.
- Confirm a modified update package is rejected. Test available Windows and Linux packages too.
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
4. Signs it again with the Tauri updater key (`--app-version` bound to the release), because the updater signature covers the installer's bytes, and replaces the installer, its `.sig` and the matching `latest.json` entries in the draft (`scripts/updater-release.mjs resign`).

The `assets` job then verifies the final manifest and signatures exactly as for an unsigned release. If a step fails, re-run the failed jobs: the sign job starts again from the unsigned artifact.

## Publish

Publish the verified draft manually in GitHub Releases and mark it as **Latest**. This exposes `latest.json` at the stable endpoint. Keep release notes in English and disclose the initial platform signing policy. Attach the matching tag's source and retain all updater packages and `.sig` files.

When preparing an intermediate test release, use an explicit HTTPS test endpoint rather than replacing the stable production manifest. A draft or prerelease does not become the repository's public latest release.

## Future signing

Windows signing through SignPath Foundation is wired in the workflow but needs the approved SignPath project above. Developer ID/notarization on macOS and a Windows signing provider can be added later without changing the Tauri updater key. They are intentionally not prerequisites for the initial release.
