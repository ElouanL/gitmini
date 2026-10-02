// GH-03: User refuses permission (access_denied); expired_token and slow_down are covered in U (device-flow.test.ts).
import type { SetupFn } from '../helpers';
import { startGithubMock } from './flows-b-support';

export const setup: SetupFn = async (fx) => {
  const mock = await startGithubMock(fx, {}, { tokenSequence: ['access_denied'] });
  return { env: mock.env(), mock };
};
