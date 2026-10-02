// Store `github`: `GithubStatus`. Never read on startup (: no calls GitHub, no keyring):
// `ensureLoaded` is only called at the opening of the GitHub menu or a feed that needs it.
import { commands } from '../ipc/commands';
import { featureFlags } from '../feature-flags';
import type { GithubStatus } from '../ipc/types';
import { reportError } from '../errors/report';

class GithubStore {
  status = $state.raw<GithubStatus | null>(null);
  #loading: Promise<void> | null = null;

  get loggedIn(): boolean {
    return this.status?.loggedIn ?? false;
  }
  get login(): string | null {
    return this.status?.login ?? null;
  }

  async refresh(): Promise<void> {
    if (!featureFlags.githubLogin) return;
    try {
      this.status = await commands.githubStatus();
    } catch (e) {
      reportError(e, { command: 'github_status', quiet: true });
    }
  }

  /** Loads the status only once (the GitHub menu calls it at its opening). */
  ensureLoaded(): Promise<void> {
    if (!featureFlags.githubLogin || this.status) return Promise.resolve();
    this.#loading ??= this.refresh().finally(() => {
      this.#loading = null;
    });
    return this.#loading;
  }

  /** The connection stream (`github-login-dialog`) calls this after `github_login_poll` → `success`. */
  setLoggedIn(login: string | null): void {
    this.status = { loggedIn: true, login };
  }

  /** `AUTH_REQUIRED { github: true }` (token deleted by backend) or disconnection. */
  setLoggedOut(): void {
    this.status = { loggedIn: false, login: null };
  }

  async logout(): Promise<void> {
    try {
      await commands.githubLogout();
      this.setLoggedOut();
    } catch (e) {
      reportError(e, { command: 'github_logout' });
    }
  }

  reset(): void {
    this.status = null;
  }
}

export const github = new GithubStore();
