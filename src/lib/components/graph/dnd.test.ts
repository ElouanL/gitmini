// Branch slider and dropper by Pointer Events (RB-01, BR-09 graph side): source = graph label or sidebar element,
// phantom, highlighted target, Escape, repository menu and `drag.*` actions of the registry.
import { fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerAction } from '$lib/actions/registry';
import { createFakeTransport } from '$lib/test/fake-transport';
import { resetAll } from '$lib/test/reset';
import { graph } from '$lib/stores/graph.svelte';
import { op } from '$lib/stores/op.svelte';
import { refs } from '$lib/stores/refs.svelte';
import { makeRefs } from '$lib/test/fixtures';
import { ui } from '$lib/stores/ui.svelte';
import { dnd } from './dnd.svelte';
import { installBranchDnd } from './dnd-controller';
import DropMenu from './DropMenu.svelte';

let off: () => void;
let hit: Element | null = null;

function label(ref: string, kind = "local", testid = 'graph-ref-label'): HTMLElement {
  const el = document.createElement('span');
  el.setAttribute('data-testid', testid);
  el.setAttribute('data-ref', ref);
  el.setAttribute('data-ref-kind', kind);
  return el;
}

function ptr(type: string, el: Element, x: number, y: number, init: PointerEventInit = {}): Promise<boolean> {
  return fireEvent(el, new (typeof PointerEvent !== 'undefined' ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true, button: 0, ...init } as PointerEventInit));
}

beforeEach(() => {
  resetAll({ keepRegistrations: true });
  createFakeTransport({}).install();
  document.body.innerHTML = '';
  hit = null;
  (document as unknown as { elementFromPoint: () => Element | null }).elementFromPoint = () => hit;
  off = installBranchDnd(document);
  refs.apply(makeRefs());
});
afterEach(async () => {
  off();
  dnd.close();
  document.documentElement.classList.remove('gr-dragging');
  await new Promise((r) => setTimeout(r, 1)); // lets the `click` absorption that follows a slide expire
});

describe("drag one label to another", () => {
  it("starts after 4 px: ghost, highlighted target (data-drop-target), repository → graph-drop-menu", async () => {
    const viewport = document.createElement('div');
    viewport.setAttribute('data-testid', 'graph-viewport');
    const feature = label('refs/heads/feature');
    const main = label('refs/heads/main');
    viewport.append(feature, main);
    document.body.append(viewport);

    await ptr('pointerdown', feature, 100, 100);
    await ptr('pointermove', feature, 102, 101);
    expect(document.querySelector('[data-testid="graph-drag-ghost"]')).toBeNull(); // below threshold
    await ptr('pointermove', feature, 120, 110);
    const ghost = document.querySelector('[data-testid="graph-drag-ghost"]');
    expect(ghost?.textContent).toBe('feature');
    expect(document.documentElement.classList.contains('gr-dragging')).toBe(true);

    hit = main;
    await ptr('pointermove', main, 200, 120);
    expect(main.getAttribute('data-drop-target')).toBe('true');
    hit = feature; // source overview: not a target
    await ptr('pointermove', feature, 130, 110);
    expect(main.hasAttribute('data-drop-target')).toBe(false);
    expect(feature.hasAttribute('data-drop-target')).toBe(false);
    hit = main;
    await ptr('pointermove', main, 200, 120);
    await ptr('pointerup', main, 200, 120);

    expect(dnd.menu).toMatchObject({ src: { name: 'feature' }, dst: { name: 'main' }, x: 200, y: 120 });
    expect(dnd.menu?.options).toEqual({ rebase: true, merge: true, none: false }); // hand is the current branch (makeRefs)
    expect(document.querySelector('[data-testid="graph-drag-ghost"]')).toBeNull();
    expect(document.documentElement.classList.contains('gr-dragging')).toBe(false);
    expect(main.hasAttribute('data-drop-target')).toBe(false);
  });

  it("a sidebar source (sidebar-branch-item, sidebar-remote-branch-item) works without cooperation", async () => {
    const item = label('refs/remotes/origin/feature/login', 'remote', 'sidebar-remote-branch-item');
    const target = label('refs/heads/topic', "local", 'sidebar-branch-item');
    document.body.append(item, target);
    await ptr('pointerdown', item, 10, 10);
    await ptr('pointermove', item, 40, 10);
    hit = target;
    await ptr('pointermove', target, 60, 10);
    expect(target.getAttribute('data-drop-target')).toBe('true');
    await ptr('pointerup', target, 60, 10);
    expect(dnd.menu).toMatchObject({ src: { fullRef: 'refs/remotes/origin/feature/login', kind: 'remote' }, dst: { name: 'topic' } });
    // remote src, local dst but not current branch: no action possible
    expect(dnd.menu?.options).toEqual({ rebase: false, merge: false, none: true });
  });

  it("repository off target or Escape during drag: no effect", async () => {
    const feature = label('refs/heads/feature');
    document.body.append(feature);
    await ptr('pointerdown', feature, 0, 0);
    await ptr('pointermove', feature, 50, 0);
    hit = null;
    await ptr('pointerup', feature, 50, 0);
    expect(dnd.menu).toBeNull();
    expect(document.querySelector('[data-testid="graph-drag-ghost"]')).toBeNull();

    await ptr('pointerdown', feature, 0, 0);
    await ptr('pointermove', feature, 50, 0);
    expect(document.querySelector('[data-testid="graph-drag-ghost"]')).not.toBeNull();
    await fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.querySelector('[data-testid="graph-drag-ghost"]')).toBeNull();
    hit = label('refs/heads/main');
    await ptr('pointerup', feature, 80, 0);
    expect(dnd.menu).toBeNull();
  });

  it("a tag or HEAD are not a source; a simple click is not a drag", async () => {
    const tag = label('refs/tags/v1', 'tag');
    const head = label('HEAD', 'head');
    const branch = label('refs/heads/x');
    document.body.append(tag, head, branch);
    for (const el of [tag, head]) {
      await ptr('pointerdown', el, 0, 0);
      await ptr('pointermove', el, 80, 0);
      expect(document.querySelector('[data-testid="graph-drag-ghost"]')).toBeNull();
      await ptr('pointerup', el, 80, 0);
    }
    await ptr('pointerdown', branch, 0, 0);
    await ptr('pointerup', branch, 1, 0);
    expect(document.querySelector('[data-testid="graph-drag-ghost"]')).toBeNull();
    expect(dnd.menu).toBeNull();
  });

  it("does not start during flight writing or during state-of-the-art operations", async () => {
    const feature = label('refs/heads/feature');
    document.body.append(feature);
    const end = op.begin('Commit');
    await ptr('pointerdown', feature, 0, 0);
    await ptr('pointermove', feature, 50, 0);
    expect(document.querySelector('[data-testid="graph-drag-ghost"]')).toBeNull();
    end();
    op.setState({ kind: 'rebase', phase: 'conflict', stopReason: null, headName: null, onto: null, step: 1, total: 2, stoppedAt: null, conflictedPaths: [], autostash: false } as never);
    await ptr('pointerdown', feature, 0, 0);
    await ptr('pointermove', feature, 50, 0);
    expect(document.querySelector('[data-testid="graph-drag-ghost"]')).toBeNull();
  });

  it("the click that follows a drag is absorbed (does not select anything)", async () => {
    const feature = label('refs/heads/feature');
    const main = label('refs/heads/main');
    document.body.append(feature, main);
    const onClick = vi.fn();
    document.body.addEventListener('click', onClick);
    await ptr('pointerdown', feature, 0, 0);
    await ptr('pointermove', feature, 50, 0);
    hit = main;
    await ptr('pointerup', main, 50, 0);
    await fireEvent.click(main);
    expect(onClick).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 5));
    await fireEvent.click(main); // next pass
    expect(onClick).toHaveBeenCalledTimes(1);
    document.body.removeEventListener('click', onClick);
  });

  it("the slide closes the central view (diff) to the repository so that the menu is visible", async () => {
    ui.openCenter('diff', { path: 'a' });
    const feature = label('refs/heads/feature');
    const main = label('refs/heads/main');
    document.body.append(feature, main);
    await ptr('pointerdown', feature, 0, 0);
    await ptr('pointermove', feature, 50, 0);
    hit = main;
    await ptr('pointerup', main, 60, 0);
    expect(ui.centerIsGraph).toBe(true);
  });
});

describe("repository menu (graph-drop-menu)", () => {
  const src = { fullRef: 'refs/heads/feature', kind: "local" as const, name: 'feature' };
  const dst = { fullRef: 'refs/heads/main', kind: "local" as const, name: 'main' };
  const head = { branch: 'main', detached: false };

  it("only \"Cancel\" is active until drag.rebase / drag.merge are recorded", async () => {
    const { getByTestId } = render(DropMenu);
    dnd.open(src, dst, 10, 10, head);
    await tick();
    expect(getByTestId('graph-drop-menu-item-rebase')).toBeDisabled();
    expect(getByTestId('graph-drop-menu-item-merge')).toBeDisabled();
    expect(getByTestId('graph-drop-menu-item-cancel')).toBeEnabled();
    await fireEvent.click(getByTestId('graph-drop-menu-item-cancel'));
    await tick();
    expect(dnd.menu).toBeNull();
  });

  it("Rebase: runAction(\"drag.rebase\") with graph.dragDrop = { src, dst } placed during the action and then removed", async () => {
    const seen: unknown[] = [];
    registerAction({ id: 'drag.rebase', label: "Rebase", run: (ctx) => void seen.push(ctx.graph.dragDrop) });
    registerAction({ id: 'drag.merge', label: "Merge", run: () => undefined });
    const { getByTestId } = render(DropMenu);
    dnd.open(src, dst, 10, 10, head);
    await tick();
    expect(getByTestId('graph-drop-menu-item-rebase')).toBeEnabled();
    await fireEvent.click(getByTestId('graph-drop-menu-item-rebase'));
    await tick();
    expect(seen).toEqual([{ src, dst }]);
    expect(graph.dragDrop).toBeNull();
    expect(dnd.menu).toBeNull();
  });

  it("remote src to a non-current target: graph-drop-menu-empty + Cancel only", async () => {
    const { getByTestId, queryByTestId } = render(DropMenu);
    dnd.open({ fullRef: 'refs/remotes/origin/x', kind: 'remote', name: 'origin/x' }, { ...dst, name: 'other', fullRef: 'refs/heads/other' }, 10, 10, head);
    await tick();
    expect(getByTestId('graph-drop-menu-empty').textContent).toContain('checkout');
    expect(queryByTestId('graph-drop-menu-item-rebase')).toBeNull();
    expect(queryByTestId('graph-drop-menu-item-merge')).toBeNull();
    expect(getByTestId('graph-drop-menu-item-cancel')).toBeInTheDocument();
  });

  it("Escape cancels everything; focus starts on the first active input", async () => {
    registerAction({ id: 'drag.rebase', label: "Rebase", run: () => undefined });
    const { getByTestId } = render(DropMenu);
    dnd.open(src, dst, 10, 10, head);
    await tick();
    await new Promise((r) => setTimeout(r, 0));
    expect(document.activeElement).toBe(getByTestId('graph-drop-menu-item-rebase'));
    await fireEvent.keyDown(window, { key: 'Escape' });
    await tick();
    expect(dnd.menu).toBeNull();
  });
});
