// GH-07: GitHub (first-pollution authorization) mock that publishes octo-test/alpha (the fetch that follows the addition of the remote connects to it).
import type { SetupFn } from '../helpers';
import { startGithubMock } from './flows-b-support';

export const setup: SetupFn = async (fx) => {
  const mock = await startGithubMock(fx, { 'octo-test/alpha': fx.repo }, { tokenSequence: ['success'] });
  return { env: mock.env(), mock };
};
