# Frontend

Svelte 5 runes, strict TypeScript and Vite. The project uses small internal UI components and lazy domain views. See [architecture](../docs/architecture.md) and [contributing](../CONTRIBUTING.md).

```sh
pnpm dev
pnpm check
pnpm lint
pnpm test
pnpm build
```

Vite listens on port 1420. Append `?mock=1` to use demo data, or run the [development bridge](../crates/gitmini-bridge/README.md) for real Git behavior in a browser.

## Extension points

Named actions power the command palette, shortcuts, toolbar and menus. Domains register actions, dialogs and panels in their `register.ts` files. Async repository operations capture the owning session; avoid accessing another tab's mutable state after an await. New backend calls belong in `lib/ipc`; generated IPC types come from Rust.

Add English messages to `i18n/<domain>.en.ts`. Catalogs load automatically through `i18n/index.ts`; use `t` for interpolation and `tp` for plural messages. Tests load exactly the same English catalog as production.

GitHub account sign-in is disabled by default. Enable it with `VITE_GITMINI_GITHUB_LOGIN=1 pnpm dev` or `VITE_GITMINI_GITHUB_LOGIN=1 pnpm build`. E2E builds enable the flag explicitly; production builds do not.

The gzip size budget for the production frontend is checked by `pnpm size`. Test-only fonts and bridge hooks must remain outside production bundles.
