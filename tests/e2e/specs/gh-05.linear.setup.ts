// GH-05 : mock GitHub (autorisation au premier poll).
import type { SetupFn } from '../helpers';
import { startGithubMock } from './flows-b-support';

export const setup: SetupFn = async (fx) => {
  const mock = await startGithubMock(fx, {}, { tokenSequence: ['success'] });
  return { env: mock.env(), mock };
};
