// Runner `tauri-driver` (Linux: WebKitWebDriver; Windows: msedgedriver): and §4.4.
//
// `tauri-driver` is launched with session environment (HOME fixture, GITMINI_*...): the application, that the
// native driver launches to create WebDriver session, in inherit. `[repo]` argument goes through
// `'tauri:options': { application, args }`. `browser.reloadSession` therefore restarts the binary with the same
// environment and the same argument; to change environment: `restartApp({ env })`.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { appBinary, tauriDriverBinary } from '../paths';
import { freePort, waitForPort } from '../ports';
import { type Spawned, spawnLogged, stopProcess } from '../proc';
import type { AppRunner, Mode, Session } from '../types';

export const MACOS_MESSAGE = "Native e2e is unavailable on macOS (no WKWebView driver). Use 'just e2e-docker'.";

export function assertTauriPlatform(platform: NodeJS.Platform = process.platform): void {
  if (platform === 'darwin') {
    throw new Error(`${MACOS_MESSAGE}\nBrowser alternative (development bridge, Chrome) : pnpm --dir tests/e2e run wdio:web`);
  }
}

export class TauriRunner implements AppRunner {
  readonly mode: Mode;
  private driver: Spawned | undefined;
  private ports: { port: number; nativePort: number } | undefined;
  private logs: string[] = [];

  constructor(
    mode: 'tauri' | 'perf' = 'tauri',
    private readonly platform: NodeJS.Platform = process.platform,
  ) {
    this.mode = mode;
  }

  async start(session: Session): Promise<{ capabilities: Record<string, unknown> }> {
    assertTauriPlatform(this.platform);
    const binary = appBinary(this.mode);
    if (!existsSync(binary)) {
      throw new Error(
        `application binary not found : ${binary}\n` +
          (this.mode === 'perf'
            ? 'build it : cargo tauri build --features e2e --no-bundle -- --profile release-perf'
            : "build it: cargo tauri build --debug --features e2e --no-bundle (or 'just e2e'), or set GITMINI_BINARY"),
      );
    }
    // the ports remain the same throughout the worker's life: WDIO keeps them in `browser.options`
    this.ports ??= { port: await freePort(), nativePort: await freePort() };
    const { port, nativePort } = this.ports;

    const args = ['--port', String(port), '--native-port', String(nativePort)];
    if (process.env.GITMINI_NATIVE_DRIVER) args.push('--native-driver', process.env.GITMINI_NATIVE_DRIVER);
    const logFile = join(session.logsDir, `tauri-driver-${Date.now()}.log`);
    this.logs.push(logFile);
    this.driver = spawnLogged(tauriDriverBinary(), args, { env: session.env, logFile, role: 'tauri-driver' });
    await waitForPort(port, {
      timeout: 15_000,
      label: 'tauri-driver',
      abortIf: () => (this.driver?.hasExited() ? `tauri-driver stopped (see ${logFile})` : null),
    });

    return {
      capabilities: {
        hostname: '127.0.0.1',
        port,
        // No BiDi negotiation (webSocketUrl): tauri-driver / WebKitWebDriver does not, and `reloadSession(caps)`
        // repart de ces capabilities
        'wdio:enforceWebDriverClassic': true,
        'tauri:options': { application: binary, args: session.args },
      },
    };
  }

  async stop(): Promise<void> {
    await stopProcess(this.driver);
    this.driver = undefined;
  }

  logFiles(): string[] {
    return [...this.logs];
  }
}
