import { describe, expect, it } from 'vitest';
import { publishRemoteName, repoNameProblem, suggestRepoName } from './publish';

describe('github publish logic', () => {
  it('validates repository names like the backend', () => {
    expect(repoNameProblem('')).toBe('empty');
    expect(repoNameProblem('  ')).toBe('empty');
    for (const ok of ['a', 'my-repo', 'x.y_z']) expect(repoNameProblem(ok)).toBeNull();
    for (const bad of ['.', '..', 'a b', 'é', 'a/b', 'x'.repeat(101)]) expect(repoNameProblem(bad)).toBe('invalid');
  });

  it('suggests a name from the folder', () => {
    expect(suggestRepoName('My App')).toBe('My-App');
    expect(suggestRepoName('  été 2026 ')).toBe('t-2026');
    expect(suggestRepoName('..')).toBe('');
  });

  it('picks a free remote name', () => {
    expect(publishRemoteName([])).toBe('origin');
    expect(publishRemoteName(['origin'])).toBe('github');
    expect(publishRemoteName(['origin', 'github', 'github-2'])).toBe('github-3');
  });
});
