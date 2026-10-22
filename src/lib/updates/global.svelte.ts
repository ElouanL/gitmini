import { app } from '../stores/app.svelte';
import { repo } from '../stores/repo.svelte';
import { opFor } from '../stores/op.svelte';
import { statusFor } from '../stores/status.svelte';
import { activeSession } from '../stores/session.svelte';
import { handleRepoChanged } from '../stores/wiring';
import { commitFormFor } from '../components/commit-form/form-state.svelte';
import { lifecycle } from '../lifecycle.svelte';
import { updaterApi, updaterAvailable, disabledStatus } from '../ipc/updater';
import { UpdateController, initialView, type UpdateView } from './controller';
import { t } from '../../i18n/index';

/**
 * The restart is the user's choice, so only what it would destroy blocks it: a running operation, a conflict or rebase
 * to finish, a commit message being written, a repository being opened. Open dialogs and menus do not.
 */
export function safeToUpdate(): boolean {
  if (!app.ready || repo.opening || repo.restoring) return false;
  const sessions = [...repo.tabs];
  if (!sessions.includes(activeSession.current)) sessions.push(activeSession.current);
  return sessions.every((owner) => {
    const op = opFor(owner);
    return !op.busy && !op.state && !commitFormFor(owner).hasPendingDraft;
  });
}

class Updates {
  view = $state.raw<UpdateView>(initialView());
  readonly controller = new UpdateController(updaterApi, {
    automatic: () => app.get('updates.auto'),
    safe: safeToUpdate,
    flush: async () => { await app.flush(); },
    pause: () => {
      lifecycle.updating = true;
      for (const owner of repo.tabs) statusFor(owner).deactivate();
      return () => {
        lifecycle.updating = false;
        statusFor(activeSession.current).activate();
        for (const owner of repo.tabs) {
          if (owner.repoId !== null) handleRepoChanged({ repoId: owner.repoId, kinds: ['refs', 'head', 'index', 'worktree', 'stash'] });
        }
      };
    },
  }, (view) => { this.view = view; });

  start(): void {
    this.stop();
    if (!updaterAvailable(app.info?.e2e)) {
      this.view = { ...this.view, status: disabledStatus(app.info?.e2e ? 'test' : 'development') };
      return;
    }
    this.controller.start();
  }

  stop(): void { this.controller.stop(); }

  check(): Promise<void> { return this.controller.check(true); }
  update(): Promise<void> { return this.controller.update(); }
  refresh(): Promise<void> { return this.controller.refreshStatus(); }
  defer(): void { this.controller.defer(); }

  get message(): string {
    const { status, blocked } = this.view;
    if (status.phase === 'disabled') return t(`updates.disabled.${status.reason ?? 'unconfigured'}`);
    if (status.phase === 'error') return t('updates.error', { message: status.error?.message ?? '' });
    const text = t(`updates.${status.phase}`, { version: status.version ?? '' });
    return blocked ? `${text} ${t('updates.blocked')}` : text;
  }

  /** The Update button applies when a new version is known and nothing is already being done about it. */
  get canUpdate(): boolean {
    const { status, installing } = this.view;
    return !installing && (status.phase === 'available' || status.phase === 'ready' || (status.phase === 'error' && this.view.failed));
  }
}

export const updates = new Updates();
