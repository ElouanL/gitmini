import { activeSession, type Session } from '../stores/session.svelte';
import { repo } from '../stores/repo.svelte';
// Registre de dialogues : un domaine enregistre un composant (ou un chargeur paresseux, voir lazy.svelte.ts) sous un identifiant
// (`branch-create-dialog`...), any code opens it by `openDialog(id, props)` and gets a promise of the result.
// Hosted by `DialogHost` (components/dialogs-base). Specialized dialogues are provided by their domains.
import type { Component } from 'svelte';
import { beginActivity } from '../activity';
import { t } from '../../i18n/index';
import { toLazy, type AnyComponent, type Loadable, type LazyComponent } from '../lazy.svelte';
import { toast } from '../stores/toast.svelte';
import { dialogStack } from './stack.svelte';

/** Props that `DialogHost` injects into each dialog, in addition to those passed to `openDialog`. */
export interface DialogProps<R = unknown> {
  /** Close the dialog; `result` becomes the value of the promise of `openDialog` (`undefined` = cancelled). */
  close: (result?: R) => void;
}

const registry = new Map<string, LazyComponent>();

type DialogComponent<P extends DialogProps<never>> = Component<P>;
type DialogSource<P extends DialogProps<never>> =
  | DialogComponent<P>
  | (() => Promise<DialogComponent<P> | { default: DialogComponent<P> }>)
  | LazyComponent;

/**
 * Saves (or replace) a dialog: a lazy component, or load ` => import('./X.svelte')` (separate chink,
 * Downloaded at first opening). Returns the function that removes it.
 */
export function registerDialog<P extends DialogProps<never>>(id: string, source: DialogSource<P>): () => void {
  const entry = toLazy(source as Loadable);
  registry.set(id, entry);
  return () => {
    if (registry.get(id) === entry) registry.delete(id);
  };
}

export function hasDialog(id: string): boolean {
  return registry.has(id);
}

export function listDialogs(): string[] {
  return [...registry.keys()];
}

/** Download the chunk from a dialog in advance (over the button, time dead). No effect if already loaded. */
export function preloadDialog(id: string): Promise<void> {
  return registry.get(id)?.load().then(() => undefined) ?? Promise.resolve();
}

/**
 * Opens a dialog and returns a promise of its result (`close(result)`), `undefined` if it is closed without result
 * (Escape, Cancel). An unregistered ID, or a chunk that does not load, displays an error toast and resolves to
 * `undefined`. An already loaded dialog opens synchronously.
 */
export function openDialog<R = unknown>(id: string, props: Record<string, unknown> = {}, owner: Session = activeSession.current): Promise<R | undefined> {
  if (owner.closed) return Promise.resolve(undefined);
  const gen = owner.gen;
  const entry = registry.get(id);
  if (!entry) {
    console.error(`[gitmini] dialogue « ${id} » not registered`);
    toast.error(t('dialog.unavailable', { id }));
    return Promise.resolve(undefined);
  }
  return new Promise<R | undefined>((resolve) => {
    const push = (component: AnyComponent): void => {
      if (!owner.isCurrent(gen)) { resolve(undefined); return; }
      const show = () => dialogStack.push({ id, component, props, resolve: resolve as (r: unknown) => void });
      if (owner.repoId !== null && owner !== activeSession.current) {
        owner.attention = true;
        const cancel = () => { toast.dismiss(notification); resolve(undefined); };
        const notification = toast.info(t('tabs.attention'), { title: owner.info?.name, timeoutMs: null,
          actions: [{ testid: 'toast-view-repo-btn', label: t('tabs.view'), run: () => {
            if (!repo.activate(owner)) return;
            owner.cancellations.delete(cancel);
            toast.dismiss(notification);
            show();
          } }],
        });
        owner.cancellations.add(cancel);
      } else show();
    };
    if (entry.component) {
      push(entry.component);
      return;
    }
    const end = beginActivity('dialog-load');
    void entry
      .load()
      .then((component) => {
        if (component) push(component);
        else {
          toast.error(t('dialog.loadFailed', { id }));
          resolve(undefined);
        }
      })
      .finally(end);
  });
}

/** Close all dialogs (change of repository). */
export function closeAllDialogs(): void {
  dialogStack.closeAll();
}

/** Reset the register to zero (tests). */
export function resetDialogRegistry(): void {
  registry.clear();
  dialogStack.closeAll();
}
