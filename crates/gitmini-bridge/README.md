# Development bridge

A loopback-only HTTP/SSE host for `gitmini-core`. It serves the built frontend and real Git commands in a browser, allowing local development and browser E2E tests on macOS as well as Linux and Windows.

```sh
pnpm build
cargo build -p gitmini-bridge
scripts/dev-web.sh /absolute/path/to/repository
```

Open `http://127.0.0.1:1430`. The first positional argument is an optional repository path. Use `--port 0` for an available port; the bridge prints its actual URL. `--static-dir` selects the frontend directory and `--config-dir` selects an isolated settings directory. Run `gitmini-bridge --help` for details.

The bridge exposes `POST /__gitmini/invoke/<command>`, `GET /__gitmini/events` and `GET /__gitmini/health`. Requests are subject to the bridge's origin and session checks. It binds only to loopback because it can access Git repositories and the filesystem. It does not expose desktop updater commands and is not a production server.

The bridge always enables core test configuration. `scripts/dev-web.sh` defaults to an in-memory GitHub keyring (`GITMINI_TEST_MODE=1`). Other test variables include `GITMINI_GITHUB_API_BASE`, `GITMINI_GITHUB_OAUTH_BASE`, `GITMINI_OPEN_URL_LOG` and `GITMINI_WATCH_DEBOUNCE_MS`. Use the [E2E harness](../../tests/e2e/README.md) for isolated per-test settings and repositories.
