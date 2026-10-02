import { describe, expect, it } from 'vitest';
import '$lib/register-core';
import type { BranchInfo, RemoteInfo } from '$lib/ipc/types';
import {
  decidePush, defaultPushRemote, defaultRemoteName, forcePushMessage, githubRemoteFor, joinPath, remoteBranchProblem,
  remoteNameProblem, remoteRemoveMessage, remoteTrackingCount, remoteUrlProblem, repoNameFromUrl, upstreamBranchName,
} from './remote-logic';

const remote = (name: string, isGithub = false): RemoteInfo => ({ name, fetchUrl: `u/${name}`, pushUrl: `u/${name}`, isGithub, githubSlug: null });
const branch = (name: string, up: { ahead: number | null; behind: number | null; ref?: string; remote?: string; gone?: boolean } | null): Pick<BranchInfo, 'name' | 'upstream'> => ({
  name,
  upstream: up && { ref: up.ref ?? `origin/${name}`, remote: up.remote ?? 'origin', ahead: up.ahead, behind: up.behind, gone: up.gone ?? false },
});

describe("validation of remote", () => {
  it("Remote name: ref component, without \"/\" or \" -\" initial", () => {
    expect(remoteNameProblem('origin')).toBeNull();
    expect(remoteNameProblem('upstream-2')).toBeNull();
    expect(remoteNameProblem('')).toBe('empty');
    expect(remoteNameProblem('-evil')).toBe('leading-dash');
    expect(remoteNameProblem('a/b')).toBe('slash');
    for (const bad of ['a b', 'a~b', 'a^b', 'a:b', 'a?b', 'a*b', 'a[b', 'a\\b', 'a..b', 'a@{b', '.a', 'a.', 'a.lock', '@', 'a\tb']) {
      expect(remoteNameProblem(bad), bad).toBe('invalid');
    }
  });
  it("URL: not empty, never \" -\" initial", () => {
    expect(remoteUrlProblem('https://github.com/o/r.git')).toBeNull();
    expect(remoteUrlProblem('/tmp/bare.git')).toBeNull();
    expect(remoteUrlProblem('  ')).toBe('empty');
    expect(remoteUrlProblem('--upload-pack=evil')).toBe('leading-dash');
  });
  it("default name: origin if it is free, otherwise the fold", () => {
    expect(defaultRemoteName([])).toBe('origin');
    expect(defaultRemoteName(['origin'])).toBe('');
    expect(defaultRemoteName(['origin'], 'octo-test')).toBe('octo-test');
  });
  it("name of repository of a clone URL", () => {
    expect(repoNameFromUrl('https://github.com/octo-test/alpha.git')).toBe('alpha');
    expect(repoNameFromUrl('git@github.com:octo-test/alpha.git')).toBe('alpha');
    expect(repoNameFromUrl('http://127.0.0.1:5000/octo-test/alpha.git/')).toBe('alpha');
    expect(repoNameFromUrl('/tmp/x/bare.git')).toBe('bare');
    expect(repoNameFromUrl('')).toBe('');
  });
  it("joinPath : separator of the parent folder", () => {
    expect(joinPath('/home/u/dev', 'alpha')).toBe('/home/u/dev/alpha');
    expect(joinPath('/home/u/dev/', 'alpha')).toBe('/home/u/dev/alpha');
    expect(joinPath('C:\\Users\\u', 'alpha')).toBe('C:\\Users\\u\\alpha');
    expect(joinPath('/home/u', '')).toBe('/home/u');
  });
  it("remote branch entered in push-dialog", () => {
    expect(remoteBranchProblem('feature/x')).toBeNull();
    expect(remoteBranchProblem(' ')).toBe('empty');
    expect(remoteBranchProblem('-x')).toBe('invalid');
    expect(remoteBranchProblem('a b')).toBe('invalid');
  });
});

describe('decidePush : table de 10 §Push', () => {
  const remotes = [remote('origin')];
  it("HEAD detached without designated branch", () => {
    expect(decidePush({ branch: null, remotes })).toEqual({ kind: 'detached' });
  });
  it("no remote → remote-add-dialog", () => {
    expect(decidePush({ branch: branch('main', null), remotes: [] })).toEqual({ kind: 'no-remote' });
  });
  it("not d的upstream → push-dialog pre-filled (origin, otherwise the first remote)", () => {
    expect(decidePush({ branch: branch('feature', null), remotes })).toEqual({ kind: 'dialog', remote: 'origin' });
    expect(decidePush({ branch: branch('feature', null), remotes: [remote('up'), remote('other')] })).toEqual({ kind: 'dialog', remote: 'up' });
    expect(defaultPushRemote([])).toBeNull();
  });
  it("behind = 0 or null → push direct, without dialogue, removesBranch from the upstream", () => {
    expect(decidePush({ branch: branch('main', { ahead: 2, behind: 0 }), remotes })).toEqual({ kind: 'direct', remote: 'origin', remoteBranch: 'main', upToDate: false });
    expect(decidePush({ branch: branch('main', { ahead: null, behind: null }), remotes })).toMatchObject({ kind: 'direct', upToDate: false });
    expect(decidePush({ branch: branch('main', { ahead: 0, behind: 0 }), remotes })).toMatchObject({ kind: 'direct', upToDate: true });
  });
  it("removeBranch may differ from the local name (upstream origin/dev)", () => {
    expect(decidePush({ branch: branch('main', { ahead: 1, behind: 0, ref: 'origin/dev' }), remotes })).toMatchObject({ remoteBranch: 'dev' });
    expect(upstreamBranchName({ ref: 'origin/feature/x', remote: 'origin' }, 'x')).toBe('feature/x');
    expect(upstreamBranchName({ ref: 'weird', remote: 'origin' }, 'fallback')).toBe('fallback');
  });
  it("behind > 0 and ahead > 0 → UN only confirm force-push, N = behind", () => {
    expect(decidePush({ branch: branch('topic', { ahead: 1, behind: 3 }), remotes })).toEqual({
      kind: 'force', remote: 'origin', remoteBranch: 'topic', ref: 'origin/topic', replaced: 3,
    });
  });
  it("behind > 0 and ahead = 0 → no push, \"make a Pull\"", () => {
    expect(decidePush({ branch: branch('main', { ahead: 0, behind: 2 }), remotes })).toEqual({ kind: 'behind', ref: 'origin/main' });
  });
});

describe("derived texts", () => {
  it("PushMessage: singular and plural", () => {
    expect(forcePushMessage('origin/feature', 1)).toBe(
      "Rewrite origin/feature? 1 commit present on the server will be replaced. If you have not rewritten the branch, cancel and make a Pull.",
    );
    expect(forcePushMessage('origin/feature', 4)).toContain("4 commits present on the server will be replaced");
  });
  it("remoteTrackingCount and removeRemoveMessage (text of )", () => {
    const remoteBranches = Array.from({ length: 12 }, (_, i) => ({ remote: 'origin', name: `b${i}`, fullRef: `refs/remotes/origin/b${i}`, oid: 'x' }));
    const snap = { remote: [...remoteBranches, { remote: 'other', name: 'z', fullRef: 'refs/remotes/other/z', oid: 'x' }] };
    expect(remoteTrackingCount(snap, 'origin')).toBe(12);
    expect(remoteTrackingCount(snap, 'other')).toBe(1);
    expect(remoteTrackingCount(null, 'origin')).toBe(0);
    expect(remoteRemoveMessage('upstream', 12)).toBe("Remove the upstream remote and its 12 tracking branches?");
    expect(remoteRemoveMessage('upstream', 1)).toBe("Delete the upstream remote and its tracking branch?");
    expect(remoteRemoveMessage('upstream', 0)).toBe("Remove the upstream Remote?");
  });
  it("githubRemoteFor: remote from the upstream, otherwise origin", () => {
    const remotes = [remote('origin', true), remote('fork', false), remote('gh2', true)];
    expect(githubRemoteFor(branch('a', null), remotes)).toBe('origin');
    expect(githubRemoteFor(branch('a', { ahead: 0, behind: 0, remote: 'gh2', ref: 'gh2/a' }), remotes)).toBe('gh2');
    expect(githubRemoteFor(branch('a', { ahead: 0, behind: 0, remote: 'fork', ref: 'fork/a' }), remotes)).toBeNull();
    expect(githubRemoteFor(branch('a', null), [remote('origin', false)])).toBeNull();
  });
});
