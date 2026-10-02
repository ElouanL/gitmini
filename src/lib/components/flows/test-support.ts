// A stream component test aids: false backend + repository "open" + dialog host.
// (Not imported by the production code.)
import { whenIdle } from '$lib/activity';
import { installErrorRouting } from '$lib/errors';
import { createFakeTransport, type FakeTransport, type Handler } from '$lib/test/fake-transport';
import { makeLogPage, makeRefs, makeRepoInfo, makeStatus, makeUndo } from '$lib/test/fixtures';
import { repo } from '$lib/stores/repo.svelte';
import type { RepoInfo } from '$lib/ipc/types';

export const oid = (c: string): string => c.repeat(40).slice(0, 40);

/** Installs a false transport with the basic readings, opens a repository fake (id 1) and waits for the end of the loadings. */
export async function openTestRepo(handlers: Record<string, Handler> = {}, info: Partial<RepoInfo> = {}): Promise<FakeTransport> {
  installErrorRouting();
  const fake = createFakeTransport({
    log_page: () => makeLogPage(),
    refs_list: () => makeRefs(),
    remote_list: () => [],
    stash_list: () => [],
    status_get: () => makeStatus({ files: [] }),
    undo_peek: () => makeUndo(false),
    ...handlers,
  }).install();
  repo.adopt(makeRepoInfo(info));
  await whenIdle();
  return fake;
}
