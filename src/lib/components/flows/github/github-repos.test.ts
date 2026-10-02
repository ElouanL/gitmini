import { describe, expect, it } from 'vitest';
import type { GithubRepo } from '$lib/ipc/types';
import { filterRepos, loadAllRepos, ownerOf, repoUrl, shortNameOf, MAX_REPO_PAGES } from './github-repos';

const repo = (fullName: string, description: string | null = null): GithubRepo => ({
  fullName, cloneUrl: `https://h/${fullName}.git`, sshUrl: `git@h:${fullName}.git`, private: false, fork: false, description,
  updatedAt: '2026-01-01T00:00:00Z', defaultBranch: 'main',
});
const ALL = [repo('octo-test/alpha', 'First app'), repo('octo-test/beta', 'Secret thing'), repo('org/gamma')];

describe('filterRepos', () => {
  it("Local filter insensitive to the case on fullName and description", () => {
    expect(filterRepos(ALL, 'ALPHA').map((r) => r.fullName)).toEqual(['octo-test/alpha']);
    expect(filterRepos(ALL, 'secret').map((r) => r.fullName)).toEqual(['octo-test/beta']);
    expect(filterRepos(ALL, 'org/').map((r) => r.fullName)).toEqual(['org/gamma']);
    expect(filterRepos(ALL, 'octo-test')).toHaveLength(2);
    expect(filterRepos(ALL, '  ')).toHaveLength(3);
    expect(filterRepos(ALL, 'zzz')).toEqual([]);
  });
  it("Helpers with name and d URL", () => {
    expect(ownerOf('octo-test/alpha')).toBe('octo-test');
    expect(shortNameOf('octo-test/alpha')).toBe('alpha');
    expect(repoUrl(ALL[0]!, 'https')).toBe('https://h/octo-test/alpha.git');
    expect(repoUrl(ALL[0]!, 'ssh')).toBe('git@h:octo-test/alpha.git');
  });
});

describe('loadAllRepos', () => {
  it("load the pages as long as hasMore and display the first one as soon as it is received", async () => {
    const seen: { n: number; more: boolean }[] = [];
    const pages = [{ repos: [ALL[0]!], hasMore: true }, { repos: [ALL[1]!], hasMore: true }, { repos: [ALL[2]!], hasMore: false }];
    const calls: number[] = [];
    const all = await loadAllRepos({
      fetchPage: async (p) => {
        calls.push(p);
        return pages[p - 1]!;
      },
      onPage: (r, more) => seen.push({ n: r.length, more }),
      cancelled: () => false,
    });
    expect(calls).toEqual([1, 2, 3]);
    expect(seen).toEqual([{ n: 1, more: true }, { n: 2, more: true }, { n: 3, more: false }]);
    expect(all).toHaveLength(3);
  });
  it('10 pages au plus', async () => {
    const calls: number[] = [];
    await loadAllRepos({ fetchPage: async (p) => (calls.push(p), { repos: [], hasMore: true }), onPage: () => {}, cancelled: () => false });
    expect(calls).toHaveLength(MAX_REPO_PAGES);
  });
  it("cancellation: more page, page received is discarded", async () => {
    let stop = false;
    const seen: number[] = [];
    await loadAllRepos({
      fetchPage: async () => {
        stop = true;
        return { repos: [ALL[0]!], hasMore: true };
      },
      onPage: (r) => seen.push(r.length),
      cancelled: () => stop,
    });
    expect(seen).toEqual([]);
  });
  it("a page error is spread (picker chooses logged-out or error)", async () => {
    await expect(loadAllRepos({ fetchPage: async () => { throw new Error('boom'); }, onPage: () => {}, cancelled: () => false })).rejects.toThrow('boom');
  });
});
