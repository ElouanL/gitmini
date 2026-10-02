// RM-08 (same setup as RM-06): origin pointed to the smart HTTP of the GitHub mock (hold on git-upload-pack posed by the scenario, once connected).
import type { SetupFn } from '../helpers';
import { startGithubMock } from './flows-b-support';

export const setup: SetupFn = async (fx) => {
  const mock = await startGithubMock(fx, { 'octo-test/alpha': fx.origin }, { tokenSequence: ['success'] });
  fx.git('remote', 'set-url', 'origin', mock.cloneUrl('octo-test/alpha'));
  return { env: mock.env(), mock };
};
