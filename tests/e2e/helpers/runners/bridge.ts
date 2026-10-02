// Browser Runner: Chrome (chromedriver managed by WebdriverIO) on the `gitmini-bridge` Development Bridge
// (crates/gitmini-bridge, see its README). The bridge hosts `gitmini-core` (even 64 commands, same 3 events) and serves
// `dist/`; it is launched with the full session environment, as tauri-driver does for the Tauri binary.
// This is the way to run the suite locally under macOS (no WKWebView driver). What the bridge does not reproduce:
// CSP and `freezePrototype` of Tauri, abilities, native dialogue (README of the bridge).

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { bridgeBinary, distDir } from '../paths';
import { pollUntil, waitForHttp } from '../ports';
import { type Spawned, spawnLogged, stopProcess } from '../proc';
import type { AppRunner, Session } from '../types';

const LISTENING = /gitmini-bridge listening on (http:\/\/127\.0\.0\.1:\d+)/;

export class BridgeRunner implements AppRunner {
  readonly mode = 'web' as const;
  private bridge: Spawned | undefined;
  private logs: string[] = [];

  async start(session: Session): Promise<{ capabilities: Record<string, unknown>; url: string }> {
    const binary = bridgeBinary();
    if (!existsSync(binary)) {
      throw new Error(`gitmini-bridge not found : ${binary}\nbuild it : cargo build -p gitmini-bridge (or set GITMINI_BRIDGE_BINARY)`);
    }
    const dist = distDir();
    if (!existsSync(join(dist, 'index.html'))) {
      throw new Error(`frontend absent : ${join(dist, 'index.html')}\nbuild it : pnpm build (or set GITMINI_DIST_DIR)`);
    }

    // `--port 0`: free port chosen by the bridge, read on its first line of stdout (no running on a "free" port)
    const args = [...session.args, '--port', '0', '--static-dir', dist, '--config-dir', session.configDir];
    const logFile = join(session.logsDir, `gitmini-bridge-${Date.now()}.log`);
    this.logs.push(logFile);
    const found: { url: string | null } = { url: null };
    let buffer = '';
    this.bridge = spawnLogged(binary, args, {
      env: session.env,
      logFile,
      role: 'gitmini-bridge',
      onStdout: (chunk) => {
        buffer += chunk;
        const m = LISTENING.exec(buffer);
        if (m && !found.url) found.url = m[1] as string;
      },
    });
    const bridge = this.bridge;
    await pollUntil(() => found.url !== null, {
      timeout: 20_000,
      label: 'gitmini-bridge',
      abortIf: () => (bridge.hasExited() ? `gitmini-bridge stopped (see ${logFile})` : null),
    });
    const url = found.url as string;
    await waitForHttp(`${url}/__gitmini/health`, { timeout: 10_000 });
    return { capabilities: {}, url };
  }

  async stop(): Promise<void> {
    await stopProcess(this.bridge, 5000); // SIGTERM: the bridge closes the repositories and removes its temporary folder
    this.bridge = undefined;
  }

  logFiles(): string[] {
    return [...this.logs];
  }
}
