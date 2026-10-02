# Releases

Release builds are produced from an existing `vX.Y.Z` tag. The workspace and root npm package versions must match the tag. The first version is `v0.1.0`.

## Signing policy

macOS uses an ad hoc signature (`bundle.macOS.signingIdentity = "-"`), without a paid Apple account or notarization. Test both Apple Silicon and Intel packages where available. The first launch needs explicit authorization in **System Settings → Privacy & Security**.

Windows MSI packages initially have no Authenticode signature. Linux packages include SHA256 checksums. Updater packages on every supported platform are signed with the same persistent Tauri key; this signature authenticates updates independently of operating-system code signing.

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

By default, the workflow uses `https://github.com/${GITHUB_REPOSITORY}/releases/latest/download/latest.json`. GitHub sign-in is disabled and does not require an OAuth client ID. No Apple, Windows or GPG signing secrets are required.

The release workflow requires the updater key and public-key configuration. Ordinary local development and installer builds may leave the updater unconfigured.

## Build and verify

Push the existing version tag or dispatch the `release` workflow with its name. The workflow creates a **draft**, builds macOS ARM64/x64 DMGs and updater archives, Windows x64 MSI, and Linux x64 AppImage/DEB. It verifies the platform matrix, package signatures, signed versions, asset URLs and SHA256 checksums. Failed jobs leave the release unpublished.

Run these smoke tests before publishing:

- Download from the draft and verify `SHA256SUMS`.
- Install the macOS ad hoc build, authorize its first launch and open a disposable repository.
- Exercise history, staging, commit, fetch and a second repository tab.
- Test an update between two different versions signed with the same updater key through a controlled HTTPS test endpoint. Confirm installation/restart succeeds and repository data and saved settings remain intact.
- Confirm a modified update package is rejected. Test available Windows and Linux packages too.

The existing updater unit/integration tests cover malformed manifests, incorrect keys, altered packages, signed-version mismatches and unsafe restart states; they complement actual installation testing.

## Publish

Publish the verified draft manually in GitHub Releases and mark it as **Latest**. This exposes `latest.json` at the stable endpoint. Keep release notes in English and disclose the initial platform signing policy. Attach the matching tag's source and retain all updater packages and `.sig` files.

When preparing an intermediate test release, use an explicit HTTPS test endpoint rather than replacing the stable production manifest. A draft or prerelease does not become the repository's public latest release.

## Future signing

Developer ID/notarization on macOS and a Windows signing provider can be added later without changing the Tauri updater key. They are intentionally not prerequisites for the initial release.
