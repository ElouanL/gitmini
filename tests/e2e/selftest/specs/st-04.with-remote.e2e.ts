// Self-test of harness (ST-04): setup.ts, mock GitHub (approx., masked journal, credential inline), settings.json prepared,
// Mock artifacts. `origin` points to the smart HTTP of the mock.
import { readFileSync } from 'node:fs';
import { expect } from '@wdio/globals';
import { git } from '../../../support/git-state';
import { currentMock, currentSession, gitAsync } from '../../helpers';
import { appReady } from '../../../support/ui';

describe("ST-04 — setup.ts and mock GitHub", () => {
  it("ST-04 — the setup plugs in the mock, the newspaper hides the token", async () => {
    const session = currentSession();
    const mock = currentMock();
    await appReady();

    expect(session.env.GITMINI_GITHUB_API_BASE).toBe(mock.apiBase);
    expect(session.env.GITMINI_GITHUB_OAUTH_BASE).toBe(mock.oauthBase);
    expect(JSON.parse(readFileSync(session.settingsPath, 'utf8'))).toEqual({ theme: 'dark' });
    expect(git(session.repo, 'remote', 'get-url', 'origin')).toBe(mock.cloneUrl('octo-test/alpha'));
    expect(mock.calls()).toEqual([]);

    // the same path as in production: credential inline scoped on the base, token in GITMINI_GH_TOKEN
    const base = mock.oauthBase;
    const helper = `!f() { if test "$1" = get; then echo username=x-access-token; echo "password=$GITMINI_GH_TOKEN"; fi; }; f`;
    // (git ASYNCHRONE: the mock rotates in this process, a synchronous git would prevent it from responding)
    const ls = await gitAsync(session.repo, ['-c', `credential.${base}.helper=`, '-c', `credential.${base}.helper=${helper}`, 'ls-remote', 'origin'], {
      env: session.env,
      extraEnv: { GITMINI_GH_TOKEN: 'gho_test' },
    });
    expect(ls.status).toBe(0);
    expect(ls.stdout).toBe(''); // bare vide
    const calls = mock.calls();
    expect(calls.length).toBeGreaterThan(0);
    // git tries first without identifiers (401), then with: the journal only keeps the schema and login
    expect(calls[0]?.auth).toBeNull();
    expect(calls.some((c) => c.auth?.scheme === 'Basic' && c.auth.login === 'x-access-token' && c.status === 200)).toBe(true);
    expect(calls.every((c) => c.auth === null || c.auth.scheme === 'Basic')).toBe(true);
    expect(JSON.stringify(calls)).not.toContain('gho_test');
  });
});
