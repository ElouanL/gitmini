// Merge dry run (`merge_preview`): the verdict sentences, the loader that ignores obsolete answers, the note, and the
// note under the merge entry of the menu shown after dropping a branch.
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerAction } from '$lib/actions/registry';
import DropMenu from '$lib/components/graph/DropMenu.svelte';
import { dnd } from '$lib/components/graph/dnd.svelte';
import type { MergeConflict, MergePreview } from '$lib/ipc/types';
import { resetAll } from '$lib/test/reset';
import { openTestRepo, oid } from '../flows/test-support';
import { MergePreviewLoader, readyPreview, type PreviewState } from './loader.svelte';
import MergePreviewNote from './MergePreviewNote.svelte';
import { blocksMerge, conflictKindLabel, hiddenConflicts, previewSummary, previewTone } from './preview';

const file = (path: string, kind: MergeConflict['kind'] = 'content'): MergeConflict => ({ path, kind });

const pv = (over: Partial<MergePreview> = {}): MergePreview => ({
  kind: 'clean', head: oid('a'), target: oid('b'), conflicts: [], conflictTotal: 0, ...over,
});

const ready = (over: Partial<MergePreview> = {}): PreviewState => ({ status: 'ready', preview: pv(over) });

beforeEach(() => {
  resetAll({ keepRegistrations: true });
});

describe('verdict of a preview', () => {
  it('has a sentence and a tone for each kind', () => {
    expect(previewSummary(pv({ kind: 'up-to-date' }))).toBe('Already up to date: nothing to merge.');
    expect(previewSummary(pv({ kind: 'fast-forward' }))).toBe('Fast-forward: no merge commit, so no conflicts.');
    expect(previewSummary(pv({ kind: 'clean' }))).toBe('No conflicts expected.');
    expect(previewSummary(pv({ kind: 'unrelated' }))).toBe('These branches share no history: git refuses to merge them.');
    expect(previewSummary(pv({ kind: 'unsupported' }))).toBe('The conflict preview needs git 2.38 or newer.');
    expect(
      (['up-to-date', 'fast-forward', 'clean', 'conflicts', 'unrelated', 'unsupported'] as const).map((kind) => previewTone(pv({ kind }))),
    ).toEqual(['info', 'ok', 'ok', 'warn', 'error', 'info']);
  });

  it('counts the conflicted files, singular and plural', () => {
    expect(previewSummary(pv({ kind: 'conflicts', conflicts: [file('a')], conflictTotal: 1 }))).toBe('1 file would conflict');
    expect(previewSummary(pv({ kind: 'conflicts', conflicts: [file('a'), file('b')], conflictTotal: 2 }))).toBe('2 files would conflict');
    expect(previewSummary(pv({ kind: 'conflicts' }))).toBe('The merge would conflict.');
  });

  it('counts the files beyond the capped list', () => {
    expect(hiddenConflicts(pv({ kind: 'conflicts', conflicts: [file('a'), file('b')], conflictTotal: 2 }))).toBe(0);
    expect(hiddenConflicts(pv({ kind: 'conflicts', conflicts: [file('a'), file('b')], conflictTotal: 230 }))).toBe(228);
  });

  it('labels each kind of conflict', () => {
    expect(conflictKindLabel('content')).toBe('changed on both sides');
    expect(conflictKindLabel('add-add')).toBe('added on both sides');
    expect(conflictKindLabel('modify-delete')).toBe('modified on one side, deleted on the other');
    expect(conflictKindLabel('other')).toBe('conflict');
  });

  it('only unrelated histories stop the merge', () => {
    expect(blocksMerge(null)).toBe(false);
    expect(blocksMerge(pv({ kind: 'conflicts' }))).toBe(false);
    expect(blocksMerge(pv({ kind: 'unsupported' }))).toBe(false);
    expect(blocksMerge(pv({ kind: 'unrelated' }))).toBe(true);
  });
});

describe('MergePreviewLoader', () => {
  it('goes from loading to ready, and calls the backend with the branch to merge', async () => {
    const fake = await openTestRepo({ merge_preview: () => pv({ kind: 'conflicts', conflicts: [file('a.txt')], conflictTotal: 1 }) });
    const loader = new MergePreviewLoader();
    expect(loader.state).toEqual({ status: 'idle' });
    const p = loader.load(1, 'feature');
    expect(loader.state).toEqual({ status: 'loading' });
    await p;
    expect(readyPreview(loader.state)?.kind).toBe('conflicts');
    expect(fake.callsOf('merge_preview')[0]!.args).toEqual({ repoId: 1, ref: 'feature' });
  });

  it('ignores an answer that arrives after a newer request', async () => {
    const release: Array<() => void> = [];
    await openTestRepo({
      merge_preview: (a) =>
        new Promise((resolve) => {
          release.push(() => resolve(pv({ kind: a.ref === 'old' ? 'conflicts' : 'clean', conflictTotal: a.ref === 'old' ? 1 : 0 })));
        }),
    });
    const loader = new MergePreviewLoader();
    const first = loader.load(1, 'old');
    const second = loader.load(1, 'new');
    release[1]!();
    await second;
    expect(readyPreview(loader.state)?.kind).toBe('clean');
    release[0]!();
    await first;
    expect(readyPreview(loader.state)?.kind).toBe('clean');
  });

  it('forgets what is in flight on reset', async () => {
    let release = (): void => undefined;
    await openTestRepo({ merge_preview: () => new Promise((resolve) => { release = () => resolve(pv()); }) });
    const loader = new MergePreviewLoader();
    const p = loader.load(1, 'feature');
    loader.reset();
    release();
    await p;
    expect(loader.state).toEqual({ status: 'idle' });
  });

  it('turns a failure into a state, not an error', async () => {
    await openTestRepo({
      merge_preview: () => {
        throw { code: 'NOT_FOUND', message: 'gone', details: { what: 'ref' } };
      },
    });
    const loader = new MergePreviewLoader();
    await loader.load(1, 'feature');
    expect(loader.state).toEqual({ status: 'failed' });
    expect(readyPreview(loader.state)).toBeNull();
  });
});

describe('MergePreviewNote', () => {
  const note = (value: PreviewState, compact = false) => render(MergePreviewNote, { value, testid: 'mp', compact });

  it('shows nothing while idle', () => {
    note({ status: 'idle' });
    expect(screen.queryByTestId('mp')).toBeNull();
  });

  it('says it is checking, and when it could not', () => {
    const { unmount } = note({ status: 'loading' });
    expect(screen.getByTestId('mp')).toHaveAttribute('data-state', 'loading');
    expect(screen.getByTestId('mp')).toHaveTextContent('Checking for conflicts...');
    unmount();
    note({ status: 'failed' });
    expect(screen.getByTestId('mp')).toHaveAttribute('data-state', 'failed');
    expect(screen.getByTestId('mp')).toHaveTextContent('Could not check for conflicts.');
  });

  it('a clean merge is one reassuring line', () => {
    note(ready({ kind: 'clean' }));
    const el = screen.getByTestId('mp');
    expect(el).toHaveAttribute('data-kind', 'clean');
    expect(el).toHaveAttribute('data-tone', 'ok');
    expect(el).toHaveAttribute('role', 'status');
    expect(screen.getByTestId('mp-summary')).toHaveTextContent('No conflicts expected.');
    expect(screen.queryAllByTestId('mp-file')).toHaveLength(0);
  });

  it('lists the conflicted files with how each conflicts, and the ones beyond the list', () => {
    note(ready({
      kind: 'conflicts', conflictTotal: 202,
      conflicts: [file('src/a.ts'), file('b.txt', 'modify-delete')],
    }));
    expect(screen.getByTestId('mp')).toHaveAttribute('data-tone', 'warn');
    expect(screen.getByTestId('mp-summary')).toHaveTextContent('202 files would conflict');
    const rows = screen.getAllByTestId('mp-file');
    expect(rows.map((r) => r.getAttribute('data-path'))).toEqual(['src/a.ts', 'b.txt']);
    expect(rows[0]).toHaveTextContent('changed on both sides');
    expect(rows[1]).toHaveAttribute('data-kind', 'modify-delete');
    expect(rows[1]).toHaveTextContent('modified on one side, deleted on the other');
    expect(screen.getByTestId('mp-more')).toHaveTextContent('...and 200 more files');
    expect(screen.getByLabelText('Files that would conflict')).toHaveAttribute('tabindex', '0');
  });

  it('compact keeps the verdict only', () => {
    note(ready({ kind: 'conflicts', conflictTotal: 1, conflicts: [file('a.txt')] }), true);
    expect(screen.getByTestId('mp-summary')).toHaveTextContent('1 file would conflict');
    expect(screen.queryAllByTestId('mp-file')).toHaveLength(0);
  });
});

describe('under the merge entry of the drop menu', () => {
  const src = { fullRef: 'refs/heads/feature', kind: 'local' as const, name: 'feature' };
  const dst = { fullRef: 'refs/heads/main', kind: 'local' as const, name: 'main' };
  const head = { branch: 'main', detached: false };

  afterEach(() => {
    dnd.close();
  });

  it('asks what merging the dragged branch would do, and shows the answer', async () => {
    const fake = await openTestRepo({ merge_preview: () => pv({ kind: 'conflicts', conflicts: [file('a.txt')], conflictTotal: 1 }) });
    registerAction({ id: 'drag.merge', label: 'Merge', run: () => undefined });
    render(DropMenu);
    dnd.open(src, dst, 10, 10, head);
    await tick();
    await waitFor(() => expect(screen.getByTestId('graph-drop-menu-preview')).toHaveAttribute('data-kind', 'conflicts'));
    expect(screen.getByTestId('graph-drop-menu-preview-summary')).toHaveTextContent('1 file would conflict');
    expect(fake.callsOf('merge_preview')).toHaveLength(1);
    expect(fake.callsOf('merge_preview')[0]!.args).toEqual({ repoId: 1, ref: 'feature' });
    // Compact: the files are for the merge dialog.
    expect(screen.queryAllByTestId('graph-drop-menu-preview-file')).toHaveLength(0);
    // The merge entry is described by the verdict, for screen readers.
    expect(screen.getByTestId('graph-drop-menu-item-merge')).toHaveAttribute('aria-describedby', 'graph-drop-menu-preview');
    expect(document.getElementById('graph-drop-menu-preview')).toBe(screen.getByTestId('graph-drop-menu-preview'));
    // The live region is not an item of the menu: a menu holds items only. The note sits next to it, in the same box.
    const menu = screen.getByRole('menu');
    expect(menu.querySelector('[role="status"]')).toBeNull();
    expect(menu).toContainElement(screen.getByTestId('graph-drop-menu-item-merge'));
    expect(screen.getByTestId('graph-drop-menu')).toContainElement(screen.getByTestId('graph-drop-menu-preview'));
  });

  it('a failed preview does not get in the way of the merge entry', async () => {
    await openTestRepo();
    registerAction({ id: 'drag.merge', label: 'Merge', run: () => undefined });
    render(DropMenu);
    dnd.open(src, dst, 10, 10, head);
    await waitFor(() => expect(screen.getByTestId('graph-drop-menu-preview')).toHaveAttribute('data-state', 'failed'));
    expect(screen.getByTestId('graph-drop-menu-item-merge')).toBeEnabled();
  });

  it('does not ask when the menu has no merge entry, and forgets the answer when it closes', async () => {
    const fake = await openTestRepo({ merge_preview: () => pv() });
    registerAction({ id: 'drag.merge', label: 'Merge', run: () => undefined });
    render(DropMenu);
    // A remote branch dropped on a branch that is not the current one: no merge entry.
    dnd.open({ fullRef: 'refs/remotes/origin/x', kind: 'remote', name: 'origin/x' }, { ...dst, name: 'other', fullRef: 'refs/heads/other' }, 10, 10, head);
    await tick();
    expect(screen.queryByTestId('graph-drop-menu-preview')).toBeNull();
    expect(fake.callsOf('merge_preview')).toHaveLength(0);
    dnd.close();
    await tick();

    dnd.open(src, dst, 10, 10, head);
    expect(await screen.findByTestId('graph-drop-menu-preview-summary')).toHaveTextContent('No conflicts expected.');
    await fireEvent.click(screen.getByTestId('graph-drop-menu-item-cancel'));
    await tick();
    expect(screen.queryByTestId('graph-drop-menu-preview')).toBeNull();

    // Opened again, the old answer is not shown while the new one loads.
    dnd.open(src, dst, 10, 10, head);
    await tick();
    expect(fake.callsOf('merge_preview')).toHaveLength(2);
  });
});
