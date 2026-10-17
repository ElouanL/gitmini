// Pure logic of `github-publish-dialog`: GitHub repository name (same rule as `github_create_repo`), name suggested from
// the folder, remote name used for the new repository.

const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;

export type RepoNameProblem = 'empty' | 'invalid';

export function repoNameProblem(name: string): RepoNameProblem | null {
  const n = name.trim();
  if (n === '') return 'empty';
  if (n === '.' || n === '..' || !REPO_NAME.test(n)) return 'invalid';
  return null;
}

/** GitHub-compatible name from a folder name: every run of other characters becomes `-` (`My App` → `My-App`). */
export function suggestRepoName(folder: string): string {
  const s = folder.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100);
  return s === '.' || s === '..' ? '' : s;
}

/** `origin` if it is free, otherwise `github`, `github-2`... */
export function publishRemoteName(existing: readonly string[]): string {
  if (!existing.includes('origin')) return 'origin';
  if (!existing.includes('github')) return 'github';
  let i = 2;
  while (existing.includes(`github-${i}`)) i++;
  return `github-${i}`;
}
