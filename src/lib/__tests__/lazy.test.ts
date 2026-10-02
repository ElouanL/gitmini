// Lazy loading (initial JS budget, ): dialogs, panels, drawers and popovers accept a ` => import(...)` charger.
import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { whenIdle } from '../activity';
import RightPanel from '../components/layout/RightPanel.svelte';
import PopoverHost from '../components/menu/PopoverHost.svelte';
import { hasDialog, openDialog, preloadDialog, registerDialog } from '../dialogs/registry';
import { dialogStack } from '../dialogs/stack.svelte';
import { lazy, LazyComponent, toLazy } from '../lazy.svelte';
import { getDrawer, getRightPanel, registerDrawer, registerRightPanel, resetPanels } from '../panels/registry';
import { registerPopover } from '../popovers/registry';
import { graph } from '../stores/graph.svelte';
import { toast } from '../stores/toast.svelte';
import { ui } from '../stores/ui.svelte';
import DummyPanel from '../test/DummyPanel.svelte';
import { resetAll } from '../test/reset';

beforeEach(() => resetAll());

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

describe('LazyComponent', () => {
  it("an ordinary component is ready immediately; a function without a parameter is a load", () => {
    expect(toLazy(DummyPanel).status).toBe('ready');
    const l = toLazy(() => Promise.resolve({ default: DummyPanel }));
    expect(l.status).toBe('idle');
    expect(l.component).toBeNull();
  });

  it("load: once only, { default } module or direct component, status reactive", async () => {
    const loader = vi.fn(() => Promise.resolve({ default: DummyPanel }));
    const l = lazy(loader);
    const [a, b] = await Promise.all([l.load(), l.load()]);
    expect(a).toBe(DummyPanel);
    expect(b).toBe(DummyPanel);
    expect(loader).toHaveBeenCalledOnce();
    expect(l.status).toBe('ready');
    expect(await new LazyComponent(() => Promise.resolve(DummyPanel)).load()).toBe(DummyPanel);
  });

  it("failure: status error, null, possible new attempt", async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let n = 0;
    const l = lazy(() => (n++ === 0 ? Promise.reject(new Error('chunk absent')) : Promise.resolve({ default: DummyPanel })));
    expect(await l.load()).toBeNull();
    expect(l.status).toBe('error');
    expect(await l.load()).toBe(DummyPanel);
    expect(l.status).toBe('ready');
    spy.mockRestore();
  });

  it("a charge that does not return a component is an error", async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const l = lazy((() => Promise.resolve({ default: 42 })) as never);
    expect(await l.load()).toBeNull();
    expect(l.status).toBe('error');
    spy.mockRestore();
  });
});

describe('dialogues paresseux', () => {
  it("the chunk is loaded at the opening; opening asynchronous the first time, synchronizes then", async () => {
    const d = deferred<{ default: typeof DummyPanel }>();
    const loader = vi.fn(() => d.promise);
    registerDialog('lazy-dialog', loader as never);
    expect(hasDialog('lazy-dialog')).toBe(true);
    expect(loader).not.toHaveBeenCalled(); // save does not download anything

    const p = openDialog<string>('lazy-dialog', { label: 'x' });
    expect(loader).toHaveBeenCalledOnce();
    expect(dialogStack.entries).toHaveLength(0);
    d.resolve({ default: DummyPanel });
    await whenIdle();
    expect(dialogStack.entries.map((e) => e.id)).toEqual(['lazy-dialog']);
    dialogStack.closeTop('ok');
    expect(await p).toBe('ok');

    void openDialog('lazy-dialog');
    expect(dialogStack.entries).toHaveLength(1); // already loaded: synchronous
    expect(loader).toHaveBeenCalledOnce();
  });

  it("window.__gitmini.idle() is waiting for chunk (followed activity)", async () => {
    const d = deferred<{ default: typeof DummyPanel }>();
    registerDialog('slow-dialog', (() => d.promise) as never);
    void openDialog('slow-dialog');
    let idle = false;
    void whenIdle().then(() => (idle = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(idle).toBe(false);
    d.resolve({ default: DummyPanel });
    await waitFor(() => expect(idle).toBe(true));
    expect(dialogStack.entries).toHaveLength(1);
  });

  it("chunk not found: toast error, promise resolved to undefined, new possible attempt", async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let n = 0;
    registerDialog('flaky-dialog', (() => (n++ === 0 ? Promise.reject(new Error('404')) : Promise.resolve({ default: DummyPanel }))) as never);
    expect(await openDialog('flaky-dialog')).toBeUndefined();
    expect(toast.items.at(-1)).toMatchObject({ kind: 'error', message: "Could not load dialog \"flaky-dialog\"" });
    void openDialog('flaky-dialog');
    await whenIdle();
    expect(dialogStack.entries).toHaveLength(1);
    spy.mockRestore();
  });

  it("preloadDialog download in advance without opening", async () => {
    const loader = vi.fn(() => Promise.resolve({ default: DummyPanel }));
    registerDialog('pre-dialog', loader as never);
    await preloadDialog('pre-dialog');
    expect(loader).toHaveBeenCalledOnce();
    expect(dialogStack.entries).toHaveLength(0);
    void openDialog('pre-dialog');
    expect(dialogStack.entries).toHaveLength(1);
    await preloadDialog('inconnu'); // No effect
  });
});

describe("panels, drawers and lazy popovers", () => {
  beforeEach(() => resetPanels());

  it("Getters return a lazy input, ordinary component or loader", () => {
    registerRightPanel('wt-panel', DummyPanel);
    registerRightPanel('stash-detail-panel', () => Promise.resolve({ default: DummyPanel }));
    registerDrawer('reflog-panel', lazy(() => Promise.resolve({ default: DummyPanel })));
    expect(getRightPanel('wt-panel')!.status).toBe('ready');
    expect(getRightPanel('stash-detail-panel')!.status).toBe('idle');
    expect(getDrawer('reflog-panel')!.status).toBe('idle');
    expect(getRightPanel('empty-panel')).toBeUndefined();
  });

  it("right panel router: Waiting indicator SANS data-testid during loading, then the component", async () => {
    const d = deferred<{ default: typeof DummyPanel }>();
    registerRightPanel('wt-panel', () => d.promise);
    graph.selectWip();
    render(RightPanel);
    expect(await screen.findByRole('status')).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByTestId('wt-panel')).toBeNull(); // no false positives for an e2e test waiting for wt-panel
    expect(screen.queryByTestId('dummy-panel')).toBeNull();
    d.resolve({ default: DummyPanel });
    expect(await screen.findByTestId('dummy-panel')).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it("nothing saved: reserved space carrying the data-testid of the panel", () => {
    graph.selectStash('a'.repeat(40), 0);
    render(RightPanel);
    expect(screen.getByTestId('stash-detail-panel')).toHaveAttribute('data-placeholder', 'true');
  });

  it("failed chunk: message error, never spininfinite", async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    registerRightPanel('wt-panel', () => Promise.reject(new Error('404')));
    graph.selectWip();
    render(RightPanel);
    expect(await screen.findByTestId('wt-panel-error')).toBeInTheDocument();
    spy.mockRestore();
  });

  it("popover lazy: receives { close } and its opening props", async () => {
    registerPopover('lazy-menu', () => Promise.resolve({ default: DummyPanel }));
    render(PopoverHost);
    ui.openPopover('lazy-menu', document.createElement('button'), { label: 'compte' });
    expect(await screen.findByTestId('dummy-panel')).toHaveTextContent('compte');
    await userEvent.click(screen.getByTestId('dummy-close'));
    expect(ui.popover).toBeNull();
  });
});
