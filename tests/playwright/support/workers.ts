/** Number of simultaneous Playwright workers (`GITMINI_E2E_WORKERS`, default 1, at most 16): each has its own bridges, repositories and browser contexts. */
export function workerCount(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.GITMINI_E2E_WORKERS ?? 1);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, 16) : 1;
}
