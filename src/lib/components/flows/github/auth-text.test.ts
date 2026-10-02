import { describe, expect, it } from 'vitest';
import '$lib/register-core';
import type { RemoteInfo } from '$lib/ipc/types';
import { authDetails, authMessage, derivedAuthMessage, hostOfUrl, offersGithubLogin, remoteFor, slugOfUrl } from './auth-text';

const origin = (over: Partial<RemoteInfo> = {}): RemoteInfo => ({
  name: 'origin', fetchUrl: 'https://github.com/octo-test/alpha.git', pushUrl: 'https://github.com/octo-test/alpha.git', isGithub: true, githubSlug: 'octo-test/alpha', ...over,
});
const err = (details: Record<string, unknown>) => ({ details });

describe('auth-text', () => {
  it('hostOfUrl / slugOfUrl : https, ssh://, scp-like', () => {
    expect(hostOfUrl('https://github.com/o/r.git')).toBe('github.com');
    expect(hostOfUrl('git@github.com:o/r.git')).toBe('github.com');
    expect(hostOfUrl('ssh://git@example.org:2222/o/r')).toBe('example.org:2222');
    expect(hostOfUrl('/tmp/x.git')).toBeNull();
    expect(slugOfUrl('https://github.com/octo-test/alpha.git')).toBe('octo-test/alpha');
    expect(slugOfUrl('git@github.com:octo-test/alpha.git')).toBe('octo-test/alpha');
    expect(slugOfUrl('/tmp/x.git')).toBeNull();
  });

  it("authDetails: Keeps only known and typed fields", () => {
    expect(authDetails(err({ remote: 'origin', url: 'u', host: 'h', reason: 'forbidden', github: true, oauthError: 'x', junk: 1 }))).toEqual({
      remote: 'origin', url: 'u', host: 'h', reason: 'forbidden', github: true, oauthError: 'x',
    });
    expect(authDetails(err({ reason: 'inconnu', github: 'oui' }))).toEqual({});
    expect(authDetails({ details: undefined })).toEqual({});
  });

  it("remoteFor : by name, otherwise by URL", () => {
    const remotes = [origin(), origin({ name: 'fork', fetchUrl: 'https://x/y.git', pushUrl: 'https://x/y.git', isGithub: false })];
    expect(remoteFor({ remote: 'fork' }, remotes)?.name).toBe('fork');
    expect(remoteFor({ url: 'https://github.com/octo-test/alpha.git' }, remotes)?.name).toBe('origin');
    expect(remoteFor({}, remotes)).toBeNull();
  });

  it("the message of the backend is authentic; the text derived from the details is only a fold", () => {
    expect(authMessage({ message: "Backend text.", details: { reason: 'forbidden' } }, [])).toBe("Backend text.");
    expect(authMessage({ message: '  ', details: { github: true } }, [])).toBe("Your GitHub session has expired.");
  });

  it("texts derived from 10 §Cas error (reply)", () => {
    const remotes = [origin()];
    expect(derivedAuthMessage(err({ remote: 'origin', url: 'https://github.com/octo-test/alpha.git' }), remotes)).toBe("Connection to GitHub required to access octo-test/alpha.");
    expect(derivedAuthMessage(err({ reason: 'credentials', host: 'git.example.org', url: 'https://git.example.org/o/r.git' }), [])).toBe(
      "Authentication rejected by git.example.org. Configure a Git credential helper (e.g. Git Credential Manager).",
    );
    expect(derivedAuthMessage(err({ reason: 'forbidden', remote: 'origin' }), remotes)).toBe("Access denied to octo-test/alpha: check your rights.");
    expect(derivedAuthMessage(err({ reason: 'publickey', host: 'github.com' }), [])).toBe("SSH key refused by github.com. Check that your key is loaded (\"ssh-add\").");
    expect(derivedAuthMessage(err({ reason: 'host-key', host: 'git.example.org' }), [])).toContain("\"ssh -T git@git.example.org\"");
    expect(derivedAuthMessage(err({ github: true }), [])).toBe("Your GitHub session has expired.");
    expect(derivedAuthMessage(err({ reason: 'oauth', oauthError: 'device_flow_disabled' }), [])).toBe("GitHub refused the connection (device_flow_disabled).");
  });

  it("github-login-btn : HTTPS on the host GitHub only", () => {
    const gh = origin();
    expect(offersGithubLogin(authDetails(err({ remote: 'origin' })), gh)).toBe(true);
    expect(offersGithubLogin(authDetails(err({ github: true })), null)).toBe(true);
    expect(offersGithubLogin(authDetails(err({ url: 'https://github.com/o/r.git' })), null)).toBe(true);
    // Test GitHub host (e2e base): recognized by the `isGithub` remote.
    expect(offersGithubLogin(authDetails(err({ remote: 'origin' })), origin({ fetchUrl: 'http://127.0.0.1:5000/octo-test/alpha.git' }))).toBe(true);
    // Other host, SSH, refused key, SSH host unknown: no button.
    expect(offersGithubLogin(authDetails(err({ url: 'https://git.example.org/o/r.git', host: 'git.example.org' })), null)).toBe(false);
    expect(offersGithubLogin(authDetails(err({ reason: 'publickey', host: 'github.com' })), gh)).toBe(false);
    expect(offersGithubLogin(authDetails(err({ reason: 'host-key', host: 'github.com' })), gh)).toBe(false);
    expect(offersGithubLogin(authDetails(err({ url: 'git@github.com:o/r.git' })), null)).toBe(false);
  });
});
