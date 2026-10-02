// `<id>.<fixture>.setup.ts` (, step 2): prepares the initial state of a scenario with the CLI git (branch, hook,
// mock GitHub, `origin` pointed to the smart HTTP of the mock...) before the launch of the application.
//
//   // tests/e2e/specs/rb-01.divergent.setup.ts
//   import type { SetupFn } from '../helpers';
//   export const setup: SetupFn = async (fx) => { fx.git('switch', 'feature'); };
//
// `setup` (named export, or default export) returns the choice: nothing; an object of environment variables
// additional (`{ GITMINI_GITHUB_API_BASE: … }`, `{ PATH: … }`); or `{ env?, args?, cleanup?, mock? }`.

import { pathToFileURL } from 'node:url';
import { type GithubMock, liveMocks } from '../../support/github-mock/index.mjs';
import { setupFileFor } from './spec-name';
import type { CleanupFn, SetupContext, SetupFn, SetupResult, Session, SpecInfo } from './types';

export interface AppliedSetup {
  env: Record<string, string>;
  args?: string[];
  cleanups: CleanupFn[];
  mocks: GithubMock[];
}

function isEnvRecord(value: unknown): value is Record<string, string> {
  return typeof value === 'object' && value !== null && Object.values(value).every((v) => typeof v === 'string');
}

/** Runs the `spec` setup if it exists. The GitHub mocks started during the setup are recorded for the household. */
export async function runSetup(spec: SpecInfo | null, session: Session, ctx: SetupContext): Promise<AppliedSetup> {
  const applied: AppliedSetup = { env: {}, cleanups: [], mocks: [] };
  if (!spec) return applied;
  const file = setupFileFor(spec);
  if (!file) return applied;

  const before = new Set<GithubMock>(liveMocks());
  const mod = (await import(pathToFileURL(file).href)) as { setup?: SetupFn; default?: SetupFn };
  const fn = mod.setup ?? mod.default;
  if (typeof fn !== 'function') throw new Error(`${file} must export a \`setup(fx, ctx)\` function (named export or default)`);

  const result: SetupResult | void = await fn(session.fx, ctx);
  if (result && typeof result === 'object') {
    if (isEnvRecord(result)) {
      applied.env = result;
    } else {
      const structured = result as Exclude<SetupResult, Record<string, string>>;
      applied.env = structured.env ?? {};
      if (structured.args) applied.args = structured.args;
      if (structured.cleanup) applied.cleanups.push(structured.cleanup);
      if (structured.mock) applied.mocks.push(structured.mock);
    }
  }
  for (const mock of liveMocks()) {
    if (!before.has(mock) && !applied.mocks.includes(mock)) applied.mocks.push(mock);
  }
  return applied;
}
