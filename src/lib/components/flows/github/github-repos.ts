// List of repositories GitHub (10 §GitHub: API): local filter and paginated loading. Pure logic, tested (github-repos.test.ts).
import type { GithubRepo } from '$lib/ipc/types';

export const REPOS_PER_PAGE = 100;
/** "The picker loads the pages as long as `hasMore`, up to 10 pages." */
export const MAX_REPO_PAGES = 10;

/** Local filter, case-insensitive, on `fullName` and `description` (10 §UI: `github-repos-search-input`). */
export function filterRepos(repos: readonly GithubRepo[], query: string): GithubRepo[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [...repos];
  return repos.filter((r) => r.fullName.toLowerCase().includes(q) || (r.description ?? '').toLowerCase().includes(q));
}

/** Owner of a `owner/repo`. */
export function ownerOf(fullName: string): string {
  return fullName.split('/')[0] ?? fullName;
}

/** Nom court d'un `owner/repo`. */
export function shortNameOf(fullName: string): string {
  return fullName.split('/').slice(1).join('/') || fullName;
}

/** URL clone/remote addition according to the chosen protocol. */
export function repoUrl(repo: Pick<GithubRepo, 'cloneUrl' | 'sshUrl'>, protocol: 'https' | 'ssh'): string {
  return protocol === 'ssh' ? repo.sshUrl : repo.cloneUrl;
}

export interface PageSource {
  fetchPage(page: number): Promise<{ repos: GithubRepo[]; hasMore: boolean }>;
  /** Called to each page received with TOUS known restitories (the first page appears as soon as it is received). */
  onPage(repos: GithubRepo[], more: boolean): void;
  cancelled(): boolean;
}

/** Loads pages as long as `hasMore` (10 at most); stops as soon as `cancelled` is true. Proposes a page error. */
export async function loadAllRepos(src: PageSource, maxPages = MAX_REPO_PAGES): Promise<GithubRepo[]> {
  let all: GithubRepo[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const res = await src.fetchPage(page);
    if (src.cancelled()) return all;
    all = [...all, ...res.repos];
    const more = res.hasMore && page < maxPages;
    src.onPage(all, more);
    if (!more) break;
  }
  return all;
}
