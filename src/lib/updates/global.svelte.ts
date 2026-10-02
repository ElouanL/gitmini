import { isIdle } from '../activity';
import { app } from '../stores/app.svelte';
import { repo } from '../stores/repo.svelte';
import { opFor } from '../stores/op.svelte';
import { statusFor } from '../stores/status.svelte';
import { activeSession } from '../stores/session.svelte';
import { uiFor } from '../stores/ui.svelte';
import { handleRepoChanged } from '../stores/wiring';
import { dialogStack } from '../dialogs/stack.svelte';
import { commitFormFor } from '../components/commit-form/form-state.svelte';
import { lifecycle } from '../lifecycle.svelte';
import { disabledStatus, updaterApi, updaterAvailable } from '../ipc/updater';
import { UpdateController, type UpdateView } from './controller';
import { t } from '../../i18n/index';

export function safeToRestart(): boolean {
  if (!app.ready || repo.opening || repo.restoring || dialogStack.top || !isIdle()
    || document.visibilityState === 'hidden') return false;
  const sessions = [...repo.tabs];
  if (!sessions.includes(activeSession.current)) sessions.push(activeSession.current);
  return sessions.every((owner) => {
    const op = opFor(owner);
    const ui = uiFor(owner);
    return !op.busy && !op.state && !commitFormFor(owner).hasPendingDraft
      && !ui.paletteOpen && !ui.contextMenu && !ui.popover;
  });
}

class Updates {
  view = $state.raw<UpdateView>({ status: disabledStatus(), countdown: null, deferred: false, installing: false });
  readonly controller = new UpdateController(updaterApi, {
    automatic: () => app.get('updates.auto'),
    safe: safeToRestart,
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
    for (const event of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'input', 'focus', 'visibilitychange']) {
      window.addEventListener(event, this.interact, { capture: true, passive: true });
    }
    this.controller.start();
  }

  stop(): void {
    this.controller.stop();
    for (const event of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'input', 'focus', 'visibilitychange']) {
      window.removeEventListener(event, this.interact, true);
    }
  }

  readonly interact = (): void => { this.controller.interact(); };
  check(): Promise<void> { return this.controller.check(true); }
  refresh(): Promise<void> { return this.controller.refreshStatus(); }
  defer(): void { this.controller.defer(); }

  get message(): string {
    const { status, countdown, deferred } = this.view;
    if (status.phase === 'disabled') return t(`updates.disabled.${status.reason ?? 'unconfigured'}`);
    if (countdown !== null) return t('updates.countdown', { seconds: countdown });
    if (status.phase === 'ready' && deferred) return t('updates.deferred');
    if (status.phase === 'error') return t('updates.error', { message: status.error?.message ?? '' });
    return t(`updates.${status.phase}`, { version: status.version ?? '' });
  }
}

export const updates = new Updates();
