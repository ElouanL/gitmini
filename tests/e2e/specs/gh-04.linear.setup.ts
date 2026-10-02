// GH-04: GitHub mock (authorization for first poll); scenario makes 401 answer /user/rest after connection.
import type { SetupFn } from '../helpers';
import { startGithubMock } from './flows-b-support';

export const setup: SetupFn = async (fx) => {
  const mock = await startGithubMock(fx, { 'octo-test/alpha': fx.repo }, { tokenSequence: ['success'] });
  return { env: mock.env(), mock };
};
