// UI-10: the repository SHA-256 is passed as an argument (fix `sha256`). Additional repositories, opened since recent:
// - reftable (`git init --ref-format=reftable`, git >= 2.45: otherwise the variant is explicitly skipped, ) ;
// - unknown extension (`extensions.gitminitest`), written in the config without go through git (it would then refuse to work there).
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { SetupFn } from '../helpers';
import { gitVersion } from '../../support/fixture';
import { recentEntry, writeSettings } from './ui-support';

export const setup: SetupFn = async (fx, ctx) => {
  const recent: ReturnType<typeof recentEntry>[] = [];

  const [major, minor] = gitVersion();
  if (major > 2 || (major === 2 && minor >= 45)) {
    const reftable = join(fx.tmp, 'reftable-repo');
    mkdirSync(reftable, { recursive: true });
    fx.gitIn(reftable, 'init', '-q', '--ref-format=reftable');
    fx.gitIn(reftable, 'commit', '-q', '--allow-empty', '-m', 'reftable: premier commit');
    recent.push(recentEntry(reftable, 'reftable-repo'));
  }

  const extension = join(fx.tmp, 'extension-repo');
  mkdirSync(extension, { recursive: true });
  fx.gitIn(extension, 'init', '-q');
  fx.gitIn(extension, 'commit', '-q', '--allow-empty', '-m', 'extension: premier commit');
  appendFileSync(join(extension, '.git', 'config'), '[core]\n\trepositoryformatversion = 1\n[extensions]\n\tgitminitest = true\n');
  recent.push(recentEntry(extension, 'extension-repo'));

  writeSettings(ctx.settingsPath, { recent });
};
