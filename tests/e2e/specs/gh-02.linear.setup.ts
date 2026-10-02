// GH-02: Mock GitHub (authorization for first poll) which publishes octo-test/alpha (clone bare de la fixture) on its smart HTTP.
import type { SetupFn } from '../helpers';
import { startGithubMock } from './flows-b-support';

export const setup: SetupFn = async (fx) => {
  const mock = await startGithubMock(fx, { 'octo-test/alpha': fx.repo }, { tokenSequence: ['success'] });
  return { env: mock.env(), mock };
};
