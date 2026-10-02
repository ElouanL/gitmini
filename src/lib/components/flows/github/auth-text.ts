// Text and decisions of `auth-required-dialog` (10 §Cas of error, `AUTH_REQUIRED`). Pure logic, tested (auth-text.test.ts).
import { t } from '$i18n/index';
import type { AppError, RemoteInfo } from '$lib/ipc/types';

export type AuthReason = 'credentials' | 'forbidden' | 'host-key' | 'publickey' | 'oauth';

export interface AuthDetails {
  remote?: string;
  url?: string;
  host?: string;
  reason?: AuthReason;
  github?: boolean;
  oauthError?: string;
}

const REASONS: readonly string[] = ['credentials', 'forbidden', 'host-key', 'publickey', 'oauth'];

export function authDetails(error: Pick<AppError, 'details'>): AuthDetails {
  const d = (error.details ?? {}) as Record<string, unknown>;
  const str = (k: string): string | undefined => (typeof d[k] === 'string' && d[k] !== '' ? (d[k] as string) : undefined);
  const reason = str('reason');
  return {
    ...(str('remote') ? { remote: str('remote')! } : {}),
    ...(str('url') ? { url: str('url')! } : {}),
    ...(str('host') ? { host: str('host')! } : {}),
    ...(reason && REASONS.includes(reason) ? { reason: reason as AuthReason } : {}),
    ...(d.github === true ? { github: true } : {}),
    ...(str('oauthError') ? { oauthError: str('oauthError')! } : {}),
  };
}

/** Host of a remote URL (`https://h/o/r.git`, `ssh://git@h/o/r`, `git@h:o/r.git`). */
export function hostOfUrl(url: string): string | null {
  const scp = /^[\w.-]+@([^:/]+):/u.exec(url);
  if (scp) return scp[1] ?? null;
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

/** `owner/repo` of a URL remote GitHub, without `.git`. */
export function slugOfUrl(url: string): string | null {
  const scp = /^[\w.-]+@[^:/]+:(.+)$/u.exec(url);
  let path = scp ? (scp[1] ?? '') : '';
  if (!scp) {
    try {
      path = new URL(url).pathname;
    } catch {
      return null;
    }
  }
  const parts = path.replace(/^\/+/, '').replace(/\.git$/u, '').split('/').filter(Boolean);
  return parts.length >= 2 ? parts.slice(0, 2).join('/') : null;
}

/** Remote concerned by the error (by its name, if not its URL). */
export function remoteFor(d: AuthDetails, remotes: readonly RemoteInfo[]): RemoteInfo | null {
  if (d.remote) {
    const r = remotes.find((x) => x.name === d.remote);
    if (r) return r;
  }
  if (d.url) return remotes.find((x) => x.fetchUrl === d.url || x.pushUrl === d.url) ?? null;
  return null;
}

/** The failure is the host GitHub: backend indicator, `isGithub` recognized remote, or URL on `github.com`. */
export function isGithubTarget(d: AuthDetails, remote: RemoteInfo | null): boolean {
  if (d.github === true || remote?.isGithub === true) return true;
  const host = d.host ?? (d.url ? hostOfUrl(d.url) : null);
  return host === 'github.com';
}

/** `github-login-btn`: only for HTTPS failure on the host GitHub (not for an unknown SSH key or SSH host). */
export function offersGithubLogin(d: AuthDetails, remote: RemoteInfo | null): boolean {
  if (d.reason === 'publickey' || d.reason === 'host-key') return false;
  const url = d.url ?? remote?.fetchUrl ?? '';
  if (/^(ssh:|git@)/u.test(url)) return false;
  return isGithubTarget(d, remote);
}

/**
 * Message from the dialog. Backend already writes the text of 10 §Cas error in `AppError.message` ("Connect to GitHub required to access to
 * octo-test/alpha.", "SSH key refused by github.com...": it is true. The text derived from the `details` serves as a fold (empty message).
 */
export function authMessage(error: Pick<AppError, 'details'> & { message?: string }, remotes: readonly RemoteInfo[]): string {
  const message = error.message?.trim();
  if (message) return message;
  return derivedAuthMessage(error, remotes);
}

export function derivedAuthMessage(error: Pick<AppError, 'details'>, remotes: readonly RemoteInfo[]): string {
  const d = authDetails(error);
  const remote = remoteFor(d, remotes);
  const url = d.url ?? remote?.fetchUrl ?? null;
  const host = d.host ?? (url ? hostOfUrl(url) : null) ?? t('auth.fallbackHost');
  const slug = remote?.githubSlug ?? (url ? slugOfUrl(url) : null);
  const target = slug ?? url ?? t('auth.fallbackTarget');
  switch (d.reason) {
    case 'forbidden':
      return t('auth.forbidden', { target });
    case 'publickey':
      return t('auth.publickey', { host });
    case 'host-key':
      return t('auth.hostKey', { host });
    case 'oauth':
      return d.oauthError ? t('auth.oauth', { code: d.oauthError }) : t('auth.oauth.unknown');
    default:
      break;
  }
  if (isGithubTarget(d, remote)) {
    // Without remote or URL: 401 of the API GitHub (token deleted); otherwise, a git command on a repository GitHub without token.
    return d.url || d.remote || remote ? t('auth.githubRequired', { target }) : t('auth.githubSession');
  }
  return t('auth.credentials', { host });
}
