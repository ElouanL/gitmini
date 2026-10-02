// ST-04 setup: a GitHub mock, a repository bare in the mock, `origin` pointed to its smart HTTP, a prepared settings.json.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { startMock } from '../../../support/github-mock/index.mjs';
import type { SetupFn } from '../../helpers';

export const setup: SetupFn = async (fx, ctx) => {
  const mock = await startMock({ reposDir: fx.dir('github') });
  const bare = mock.bareRepoPath('octo-test/alpha');
  mkdirSync(dirname(bare), { recursive: true });
  fx.gitIn(fx.root, 'init', '--bare', '-q', '-b', 'main', bare);
  fx.git('remote', 'set-url', 'origin', mock.cloneUrl('octo-test/alpha'));
  writeFileSync(ctx.settingsPath, `${JSON.stringify({ theme: 'dark' })}\n`);
  return { env: mock.env(), mock };
};
