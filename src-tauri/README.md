# Desktop application

This crate hosts `gitmini-core` in Tauri. It owns native dialogs, restricted IPC permissions, logging, WebView startup and the desktop updater. See [architecture](../docs/architecture.md).

```sh
just dev
just build
```

Install the platform's Tauri prerequisites and Tauri CLI 2. `cargo tauri build` embeds `dist/` through the `custom-protocol` feature. The `e2e` feature allows test-only configuration and the frontend test bridge; do not use it for production releases.

## Commands and permissions

`src/ipc/mod.rs` registers command handlers. `commands.txt` drives Tauri's generated command permissions and must match the registry and `capabilities/default.json`. Run `node scripts/check-commands.mjs` after changes. Shared core types are generated with `just gen-types`.

## Release configuration

macOS initially uses ad hoc signing. Windows installers have no Authenticode signature. Signed updater packages use `TAURI_SIGNING_PRIVATE_KEY`; the embedded public key and HTTPS endpoint come from the release configuration. See [release setup](../docs/releases.md).

`VITE_GITMINI_GITHUB_LOGIN` is off by default. When explicitly enabled for a production build, supply `GITMINI_GITHUB_CLIENT_ID` at compilation. `GITMINI_REQUIRE_CLIENT_ID=1` makes that requirement explicit; it does not apply while the login flag is disabled. GitHub E2E tests use their local mock instead of the production OAuth service.
