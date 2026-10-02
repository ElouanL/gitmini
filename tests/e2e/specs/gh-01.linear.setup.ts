// GH-01: GitHub mock with the default Device Flow sequence (authorization_pending ×2 and then succeed).
import type { SetupFn } from '../helpers';
import { startGithubMock } from './flows-b-support';

export const setup: SetupFn = async (fx) => {
  const mock = await startGithubMock(fx);
  return { env: mock.env(), mock };
};
