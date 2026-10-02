// GH-06 — Open PR (, 10). Fixture: linear, origin GitHub, app launched without GITMINI_GITHUB_* (github.com is host, no request).
import { currentSession, readOpenedUrls } from '../helpers';
import { appReady, chooseContextItem, rightClick, until } from '../../support/ui';

it("GH-06 — Open PR", async () => {
  const session = currentSession();
  await appReady();

  await rightClick('sidebar-branch-item', { ref: 'refs/heads/feature' });
  await chooseContextItem('open-pr');

  await until(() => readOpenedUrls(session).includes('https://github.com/octo-test/alpha/compare/feature?expand=1'), {
    message: 'GITMINI_OPEN_URL_LOG devrait contenir l’URL « compare » de feature',
  });
});
