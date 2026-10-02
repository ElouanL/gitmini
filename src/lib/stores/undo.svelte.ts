// Store `undo` (, ) : `UndoStatus`, reread at the opening and at each `repo:changed` (fall 50 ms).
import { commands } from '../ipc/commands';
import type { UndoEntry, UndoStatus } from '../ipc/types';
import { reportError } from '../errors/report';
import { t } from '../../i18n/index';
import { createDebouncer } from './schedule';
import { runWrite } from './run-write';
import { scopedStore, type Session } from './session.svelte';
import { toast } from './toast.svelte';

export class UndoStore {
  constructor(readonly owner: Session) {}
  status = $state.raw<UndoStatus | null>(null);

  readonly #debounce = createDebouncer(async () => {
    await this.peekNow();
  }, 50);

  /** `undo_peek` with 50 ms drop (called each `repo:changed`). */
  peekSoon(): void {
    this.#debounce.call();
  }

  /** `undo_peek` immediate (opening repository, before displaying a cancel toast). */
  async peekNow(): Promise<UndoStatus | null> {
    this.#debounce.cancel();
    const repoId = this.owner.repoId;
    if (repoId === null) return null;
    const gen = this.owner.gen;
    try {
      const s = await commands.undoPeek({ repoId });
      if (this.owner.isCurrent(gen)) this.status = s;
      return s;
    } catch (e) {
      if (!this.owner.isCurrent(gen)) return null;
      reportError(e, { repoId: this.owner.repoId, command: 'undo_peek', quiet: true });
      return null;
    }
  }

  get available(): boolean {
    return this.status?.available ?? false;
  }
  get entry(): UndoEntry | null {
    return this.status?.entry ?? null;
  }

  /** `toolbar-undo-btn` Infobulle: `entry.label` if available, otherwise the text of the pattern (11 "In error case"). */
  get tooltip(): string {
    const s = this.status;
    if (!s) return t('undo.reason.empty');
    if (s.available && s.entry) return s.entry.label;
    return this.reasonText(s);
  }

  reasonText(s: UndoStatus | { reason: string | null; entry: UndoEntry | null }): string {
    const reason = s.reason ?? 'empty';
    const entry = s.entry;
    const branch = entry?.refName?.replace(/^refs\/heads\//, '') ?? '';
    if (reason === 'exists') return t(entry?.kind === 'stash-drop' ? 'undo.reason.exists.stash' : 'undo.reason.exists.branch', { branch });
    return t(`undo.reason.${reason}`, { branch });
  }

  /**
   * Runs `undo_last` for the given input (without dialog: `undo-confirm-dialog` calls it after confirmation,
   * `toast-undo-btn` directement). Renvoie `true` si l'annulation a eu lieu.
   */
  async perform(entry: UndoEntry, expectedHead: string | null = this.status?.head ?? null): Promise<boolean> {
    const repoId = this.owner.repoId;
    if (repoId === null) return false;
    const res = await runWrite(
      t('undo.running'),
      () => commands.undoLast({ repoId, entryId: entry.id, expectedHead }),
      { owner: this.owner, command: 'undo_last' },
    );
    if (res.ok) toast.success(t('undo.done', { label: entry.label }));
    return res.ok;
  }

  /**
   * Displays a 10 s `toast[data-kind=undo]` with `toast-undo-btn` after a cancelable operation ("hand-based feature"...).
   * Relink `undo_peek` first: the input of undo captured by the button is that of the operation that just finished
   * (backend refuses otherwise, `STALE { what: "undo" }`). Without available entry, a simple success toast.
   */
  async toastUndoable(message: string): Promise<void> {
    const s = await this.peekNow();
    const entry = s?.entry;
    if (!s || !s.available || !entry) {
      toast.success(message);
      return;
    }
    const expectedHead = s.head;
    toast.undo(message, {
      testid: 'toast-undo-btn',
      label: t('undo.action'),
      run: async () => {
        await this.perform(entry, expectedHead);
      },
    });
  }

  reset(): void {
    this.#debounce.cancel();
    this.status = null;
  }
}

const binding = scopedStore('undo', (owner) => new UndoStore(owner));
export const undo = binding.current;
export const undoFor = binding.for;
