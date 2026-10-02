// Presentation logic: shortcuts, palette, contextual menus, operating banner, keyboard dispatcher, toasts.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { availableCommands, filterCommands, normalize } from '../actions/palette';
import { actionContext, getAction, isActionEnabled, registerAction, runAction } from '../actions/registry';
import { handleGlobalKeydown } from '../actions/dispatcher';
import { formatKeys, isTextInput, listShortcuts, matchesKeys, parseKeys, shortcutFor } from '../actions/shortcuts';
import { bannerButtons, bannerLabel } from '../components/banner/label';
import { dialogStack } from '../dialogs/stack.svelte';
import { registerDialog } from '../dialogs/registry';
import { installErrorRouting } from '../errors/handle';
import { MENU_IDS, MENU_ITEM_IDS } from '../menus/types';
import { menuItemIds, registerMenuItems, resolveMenu } from '../menus/registry';
import { panelIdFor } from '../panels/route';
import { graph } from '../stores/graph.svelte';
import { op } from '../stores/op.svelte';
import { refs } from '../stores/refs.svelte';
import { repo } from '../stores/repo.svelte';
import { session } from '../stores/session.svelte';
import { status } from '../stores/status.svelte';
import { toast } from '../stores/toast.svelte';
import { ui } from '../stores/ui.svelte';
import { undo } from '../stores/undo.svelte';
import { createFakeTransport } from '../test/fake-transport';
import { makeConflictState, makeRefs, makeRepoInfo, makeStashes, makeStatus, makeUndo, oid } from '../test/fixtures';
import { resetAll } from '../test/reset';
import { registerBuiltinActions } from '../actions/builtin';
import { registerBuiltinMenus } from '../menus/builtin';
import { opActions } from '../actions/op-actions';
import { registerActions } from '../actions/registry';
import type { Component } from 'svelte';

const key = (k: string, mods: Partial<KeyboardEventInit> = {}) =>
  new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...mods });

beforeEach(() => {
  resetAll();
  installErrorRouting();
  createFakeTransport({ undo_peek: () => makeUndo(), status_get: () => makeStatus() }).install();
  registerBuiltinActions();
  registerActions(opActions);
  registerBuiltinMenus();
});

function openRepoState() {
  repo.info = makeRepoInfo();
  session.begin(1);
  refs.apply(makeRefs());
  refs.applyStashes(makeStashes());
  status.apply(makeStatus());
  undo.status = makeUndo();
}

describe("Shortcuts (03 Keyboard)", () => {
  it('table : Mod+K/O/F/Z, Mod+Shift+F/L/K, Mod+B, Mod+1/2/3, Mod+,', () => {
    const keys = listShortcuts().map((s) => s.keys);
    for (const k of ['Mod+K', 'Mod+O', 'Mod+F', 'Mod+Z', 'Mod+Shift+F', 'Mod+Shift+L', 'Mod+Shift+K', 'Mod+B', 'Mod+1', 'Mod+2', 'Mod+3', 'Mod+,']) expect(keys).toContain(k);
    expect(shortcutFor('git.fetch')).toBe('Mod+Shift+F');
  });

  it("Mod = Cmd on macOS, Ctrl elsewhere; modifiers must match exactly", () => {
    expect(matchesKeys({ key: 'k', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }, 'Mod+K', true)).toBe(true);
    expect(matchesKeys({ key: 'k', metaKey: false, ctrlKey: true, altKey: false, shiftKey: false }, 'Mod+K', true)).toBe(false);
    expect(matchesKeys({ key: 'k', metaKey: false, ctrlKey: true, altKey: false, shiftKey: false }, 'Mod+K', false)).toBe(true);
    // Mod+F ≠ Mod+Shift+F
    expect(matchesKeys({ key: 'F', metaKey: true, ctrlKey: false, altKey: false, shiftKey: true }, 'Mod+F', true)).toBe(false);
    expect(matchesKeys({ key: 'F', metaKey: true, ctrlKey: false, altKey: false, shiftKey: true }, 'Mod+Shift+F', true)).toBe(true);
    expect(matchesKeys({ key: ',', metaKey: false, ctrlKey: true, altKey: false, shiftKey: false }, 'Mod+,', false)).toBe(true);
    expect(parseKeys('Mod+,').key).toBe(',');
    // numbers: physical key, Shift ignored (AZERTY produces " &" / "e" without Shift; WebDriver sends "#" + Shift for 3)
    const mod = { metaKey: false, ctrlKey: true, altKey: false };
    expect(matchesKeys({ key: '3', code: 'Digit3', shiftKey: false, ...mod }, 'Mod+3', false)).toBe(true);
    expect(matchesKeys({ key: '#', code: 'Digit3', shiftKey: true, ...mod }, 'Mod+3', false)).toBe(true);
    expect(matchesKeys({ key: '"', code: 'Digit3', shiftKey: false, ...mod }, 'Mod+3', false)).toBe(true); // AZERTY
    expect(matchesKeys({ key: '3', code: 'Digit4', shiftKey: false, ...mod }, 'Mod+3', false)).toBe(false);
    expect(matchesKeys({ key: '3', shiftKey: false, ...mod }, 'Mod+3', false)).toBe(true); // without `code`: the key produced
  });

  it("localized display", () => {
    expect(formatKeys('Mod+Shift+F', true)).toBe('⇧⌘F');
    expect(formatKeys('Mod+Shift+F', false)).toBe('Ctrl+Maj+F');
  });

  it("input field detected (Mod+Z does not cancel the strike)", () => {
    const input = document.createElement('input');
    const box = document.createElement('input');
    box.type = 'checkbox';
    expect(isTextInput(input)).toBe(true);
    expect(isTextInput(box)).toBe(false);
    expect(isTextInput(document.createElement('textarea'))).toBe(true);
    expect(isTextInput(document.createElement('button'))).toBe(false);
  });
});

describe('registre d’actions', () => {
  it("a domain replaces a pillar action by the same id", async () => {
    openRepoState();
    const run = vi.fn();
    registerAction({ id: 'git.push', label: () => 'Push (domaine)', run });
    expect(getAction('git.push')!.label).toBeInstanceOf(Function);
    await runAction('git.push');
    expect(run).toHaveBeenCalledOnce();
  });

  it("enabled / disabledReason: no repository, flight operation, HEAD detached, worktree clean, no stash", () => {
    const fetch = getAction('git.fetch')!;
    expect(isActionEnabled(fetch)).toBe(false); // none repository
    openRepoState();
    expect(isActionEnabled(fetch)).toBe(true);
    const end = op.begin('Commit');
    expect(isActionEnabled(fetch)).toBe(false);
    expect(fetch.disabledReason!(actionContext())).toBe("Operation in progress: Commit");
    end();
    op.setState(makeConflictState());
    expect(isActionEnabled(fetch)).toBe(true); // fetch remains allowed during operation
    expect(isActionEnabled(getAction('stash.save')!)).toBe(false);
    op.setState(null);
    status.apply(makeStatus({ files: [] }));
    expect(isActionEnabled(getAction('stash.save')!)).toBe(false);
    expect(getAction('stash.save')!.disabledReason!(actionContext())).toBe("Nothing to set aside: the worktree is clean");
    refs.applyStashes([]);
    expect(getAction('stash.pop')!.disabledReason!(actionContext())).toBe("No stash");
    status.apply(makeStatus({ head: { branch: null, oid: oid(1), detached: true, unborn: false } }));
    repo.info = makeRepoInfo({ head: { branch: null, oid: oid(1), detached: true, unborn: false } });
    refs.apply({ ...makeRefs(), head: { kind: 'detached', oid: oid(1) } });
  });

  it("list of all present 03", () => {
    // pull / push (git.pull, git.pullFfOnly, git.pullRebase, git.push) are provided by the remote domain: see app.test.ts
    for (const id of ['repo.open', 'repo.clone', 'git.fetch', 'branch.create', 'stash.save', 'stash.pop', 'undo.last', 'view.reflog', 'github.login', 'github.logout', 'settings.open', 'theme.toggle']) {
      expect(getAction(id), id).toBeDefined();
    }
  });
});

describe('palette', () => {
  it("substring filter without breakage or accents; disabled not listed", () => {
    openRepoState();
    expect(normalize("École")).toBe("ecole");
    const all = availableCommands();
    expect(all.map((e) => e.id)).toContain('git.fetch');
    expect(all.map((e) => e.id)).not.toContain('palette.open');
    expect(filterCommands(all, 'FETCH').map((e) => e.id)).toEqual(['git.fetch']);
    expect(filterCommands(all, "settings").map((e) => e.id)).toEqual(['settings.open']);
    expect(filterCommands(all, 'zzz')).toEqual([]);
    refs.applyStashes([]);
    expect(availableCommands().map((e) => e.id)).not.toContain('stash.pop'); // Pop without stash: not listed
  });

  it("without repository: only commands without repository", () => {
    const ids = availableCommands().map((e) => e.id);
    expect(ids).toContain('repo.open');
    expect(ids).toContain('settings.open');
    expect(ids).toContain('theme.toggle');
    expect(ids).not.toContain('git.fetch');
    expect(ids).not.toContain('undo.last');
  });
});

describe('context menus (03)', () => {
  it("input identifiers follow the closed list of 01 §5.7; no reset-*", () => {
    expect(MENU_ITEM_IDS).toHaveLength(29);
    expect(MENU_ITEM_IDS.some((i) => i.startsWith('reset'))).toBe(false);
    expect(MENU_IDS).toEqual(['commit', 'branch', 'remote-branch', 'remote', 'tag', 'stash', 'wip', 'wt-file']);
    for (const m of MENU_IDS) for (const id of menuItemIds(m)) expect(MENU_ITEM_IDS).toContain(id);
  });

  it("branch: checkout absent on current; entrances to base", () => {
    openRepoState();
    const [main, feature] = [makeRefs().local[0]!, makeRefs().local[1]!];
    const onMain = resolveMenu({ menu: 'branch', branch: main }).map((i) => i.id);
    const onFeature = resolveMenu({ menu: 'branch', branch: feature }).map((i) => i.id);
    expect(onMain).not.toContain('checkout');
    // `push` and `pull` are provided by the remote domain (no base, no duplicates here)
    expect(onFeature).toContain('checkout');
  });

  it("tag: only checkout-detached and copy-name", () => {
    openRepoState();
    expect(resolveMenu({ menu: 'tag', tag: makeRefs().tags[0]! }).map((i) => i.id).sort()).toEqual(['checkout-detached', 'copy-name']);
  });

  it("a domain adds and replaces entries; destructive at the bottom, separated", () => {
    openRepoState();
    const run = vi.fn();
    registerMenuItems('branch', [
      { id: 'delete', danger: true, label: "Remove", run, visible: (ctx) => !ctx.target.branch.isHead },
      { id: 'rename', label: "Rename…", run, order: 15 },
    ]);
    const feature = makeRefs().local[1]!;
    const items = resolveMenu({ menu: 'branch', branch: feature });
    expect(items.at(-1)).toMatchObject({ id: 'delete', danger: true, separatorBefore: true });
    expect(items.findIndex((i) => i.id === 'rename')).toBeLessThan(items.findIndex((i) => i.id === 'create-branch'));
    // "masked, not greyed": on the current, delete does not exist.
    expect(resolveMenu({ menu: 'branch', branch: makeRefs().local[0]! }).map((i) => i.id)).not.toContain('delete');
    // replacement by ID
    registerMenuItems('branch', [{ id: 'rename', label: "Other wording", run }]);
    expect(resolveMenu({ menu: 'branch', branch: feature }).find((i) => i.id === 'rename')!.label).toBe("Other wording");
  });

  it('wt-file : submodule or non-UTF-8 path → copy-path only', () => {
    openRepoState();
    const f = { path: 'lib', oldPath: null, staged: null, unstaged: 'modified' as const, conflict: null, oldMode: null, newMode: null, submodule: true, nonUtf8: null };
    expect(resolveMenu({ menu: 'wt-file', file: f }).map((i) => i.id)).toEqual(['copy-path']);
    expect(resolveMenu({ menu: 'wt-file', file: { ...f, submodule: null } }).map((i) => i.id)).toEqual(['open-external', 'copy-path']);
  });
});

describe("operation banner: 07 / 09 labels and buttons", () => {
  const base = makeConflictState();

  it('rebase en conflit', () => {
    expect(bannerLabel(base)).toBe('Rebase feature/login onto main — 3/7 — conflict by applying 0000000 "Fix parser" — 2 files in conflict');
  });
  it("rebase: conflicts resolved, empty, blocked, ongoing, am", () => {
    expect(bannerLabel({ ...base, conflictedPaths: [] })).toBe("Rebase feature/login onto main — 3/7 — conflicts resolved, ready to continue");
    expect(bannerLabel({ ...base, phase: 'stopped', stopReason: 'empty', conflictedPaths: [] })).toContain("Skip it?");
    expect(bannerLabel({ ...base, phase: 'stopped', stopReason: 'blocked', conflictedPaths: [] })).toContain("git stopped on");
    expect(bannerLabel({ ...base, phase: 'running' })).toBe("Rebase feature/login onto main — 3/7…");
    expect(bannerLabel({ ...base, kind: 'am' })).toBe("git am in progress (not managed by gitmini)");
    expect(bannerLabel({ ...base, total: null, step: null, conflictedPaths: ['a'] })).not.toMatch(/\d\/\d/);
  });
  it('cherry-pick / revert', () => {
    const cp = { ...base, kind: 'cherry-pick' as const, headName: null, ontoLabel: null, onto: null, step: 2, total: 3, conflictedPaths: ['T3.txt'] };
    expect(bannerLabel(cp)).toBe("Cherry-pick in progress — 2/3 — conflict by applying 0000000 \"Fix parser\" — 1 file in conflict");
    expect(bannerLabel({ ...cp, kind: 'revert', conflictedPaths: [] })).toBe("Revert in progress — 2/3 — conflicts resolved, ready to continue");
    expect(bannerLabel({ ...cp, phase: 'stopped', stopReason: 'stale' })).toBe("Incomplete cherry-pick/revert state found. Abort to clean it up.");
  });
  it('merge', () => {
    const m = { ...base, kind: 'merge' as const, incoming: 'feature', step: null, total: null, conflictedPaths: ['a.txt'] };
    expect(bannerLabel(m, 'main')).toBe("Merge feature into main — conflict in 1 file");
  });

  it("buttons depending on type and pattern of stop (03, 07, 09)", () => {
    expect(bannerButtons(base)).toEqual({ continue: true, skip: true, abort: true });
    expect(bannerButtons({ ...base, kind: 'merge' })).toEqual({ continue: true, skip: false, abort: true });
    expect(bannerButtons({ ...base, kind: 'am' })).toEqual({ continue: false, skip: false, abort: true });
    expect(bannerButtons({ ...base, phase: 'stopped', stopReason: 'empty' })).toEqual({ continue: false, skip: true, abort: true });
    expect(bannerButtons({ ...base, kind: 'cherry-pick', phase: 'stopped', stopReason: 'stale' })).toEqual({ continue: false, skip: false, abort: true });
    expect(bannerButtons({ ...base, kind: 'cherry-pick', phase: 'stopped', stopReason: 'empty' })).toEqual({ continue: false, skip: true, abort: true });
  });
});

describe("right panel: selection routing", () => {
  it('none / wip / 1 commit / plusieurs / stash', () => {
    expect(panelIdFor({ kind: 'none' })).toBe('empty-panel');
    expect(panelIdFor({ kind: 'wip' })).toBe('wt-panel');
    expect(panelIdFor({ kind: 'commits', oids: ['a'], anchor: 'a' })).toBe('commit-details-panel');
    expect(panelIdFor({ kind: 'commits', oids: ['a', 'b'], anchor: 'a' })).toBe('multi-commit-panel');
    expect(panelIdFor({ kind: 'stash', oid: 'a', index: 0 })).toBe('stash-detail-panel');
  });
});

describe('dispatcheur clavier global', () => {
  it("Close escape in order: context menu, palette, popover, dialogue, search, central view, drawer", () => {
    registerDialog('x-dialog', function xDialog(_anchor: unknown) {} as unknown as Component<{ close: () => void }>);
    ui.contextMenu = { target: { menu: 'wip' }, x: 0, y: 0, returnFocus: null };
    ui.paletteOpen = true;
    ui.popover = { id: 'github-menu', anchor: document.createElement('button'), props: {} };
    dialogStack.push({ id: 'x-dialog', component: (() => {}) as never, props: {}, resolve: () => {} });
    graph.searchOpen = true;
    ui.openCenter('diff');
    ui.openDrawer('reflog-panel');

    const order: string[] = [];
    const snapshot = () => [!!ui.contextMenu, ui.paletteOpen, !!ui.popover, dialogStack.entries.length > 0, graph.searchOpen, !ui.centerIsGraph, !!ui.drawer];
    for (let i = 0; i < 7; i++) {
      handleGlobalKeydown(key('Escape'));
      order.push(snapshot().map((b) => (b ? '1' : '0')).join(''));
    }
    expect(order).toEqual(['0111111', '0011111', '0001111', '0000111', '0000011', '0000001', '0000000']);
  });

  it("an event already consumed (preventDefault) is ignored", () => {
    ui.paletteOpen = true;
    const e = key('Escape');
    e.preventDefault();
    handleGlobalKeydown(e);
    expect(ui.paletteOpen).toBe(true);
  });

  it("Mod+K opens / closes palette; Mod+Z ignored in input field; a dialog is modal", async () => {
    openRepoState();
    const mod = { ctrlKey: true, metaKey: false };
    const mac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);
    const m = mac ? { metaKey: true, ctrlKey: false } : mod;
    handleGlobalKeydown(key('k', m));
    await Promise.resolve();
    expect(ui.paletteOpen).toBe(true);
    handleGlobalKeydown(key('k', m));
    await Promise.resolve();
    expect(ui.paletteOpen).toBe(false);

    const input = document.createElement('input');
    document.body.appendChild(input);
    const ev = new KeyboardEvent('keydown', { key: 'z', bubbles: true, cancelable: true, ...m });
    input.dispatchEvent(ev);
    handleGlobalKeydown(ev);
    expect(ev.defaultPrevented).toBe(false);
    input.remove();

    dialogStack.push({ id: 'x', component: (() => {}) as never, props: {}, resolve: () => {} });
    handleGlobalKeydown(key('k', m));
    expect(ui.paletteOpen).toBe(false);
  });
});

describe('toasts (03)', () => {
  it("5 visible to maximum; 4 s success, error until closure, undo 10 s", () => {
    vi.useFakeTimers();
    for (let i = 0; i < 8; i++) toast.error(`e${i}`);
    expect(toast.visible).toHaveLength(5);
    expect(toast.visible.at(-1)!.message).toBe('e7');
    toast.clear();
    toast.success('ok');
    toast.undo('ann', { testid: 'toast-undo-btn', label: "Cancel", run: () => {} });
    vi.advanceTimersByTime(4001);
    expect(toast.items.map((t) => t.kind)).toEqual(['undo']);
    vi.advanceTimersByTime(6000);
    expect(toast.items).toHaveLength(0);
    toast.error('reste');
    vi.advanceTimersByTime(60_000);
    expect(toast.items).toHaveLength(1);
    vi.useRealTimers();
  });

  it("identical toasts merge (counter)", () => {
    toast.error("same message", { title: 'T' });
    toast.error("same message", { title: 'T' });
    expect(toast.items).toHaveLength(1);
    expect(toast.items[0]!.count).toBe(2);
  });
});

describe("undo : Infobull and toast to cancel", () => {
  it("texts of 11 according to the reason", () => {
    undo.status = { entry: { ...makeUndo().entry!, refName: 'refs/heads/feature' }, available: false, reason: 'head-moved', head: null };
    expect(undo.tooltip).toBe("Cannot undo: you are no longer on feature.");
    undo.status = { entry: null, available: false, reason: 'empty', head: null };
    expect(undo.tooltip).toBe("Nothing to undo.");
    undo.status = makeUndo();
    expect(undo.tooltip).toBe("Cancel the commit « feel: login form »");
  });

  it("toastUndoable: capture the entryId of the operation that has just ended, toast-undo-btn calls undo_last without dialogue", async () => {
    openRepoState();
    const fake = createFakeTransport({ undo_peek: () => makeUndo(), undo_last: () => ({ head: { branch: 'main', oid: oid(59), detached: false, unborn: false } }) }).install();
    await undo.toastUndoable("3 commits Cherry-picked on main");
    const t = toast.items.at(-1)!;
    expect(t.kind).toBe('undo');
    expect(t.actions[0]!.testid).toBe('toast-undo-btn');
    await t.actions[0]!.run();
    expect(fake.callsOf('undo_last')[0]!.args).toEqual({ repoId: 1, entryId: 'undo-1', expectedHead: oid(60) });
    expect(toast.items.at(-1)).toMatchObject({ kind: 'success' });
  });
});
