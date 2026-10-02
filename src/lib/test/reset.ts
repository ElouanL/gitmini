// Reset the base singletons to zero between two tests (stores, event bus, registers, transport).
import { resetEventBus } from '../ipc/events';
import { updates } from '../updates/global.svelte';
import { lifecycle } from '../lifecycle.svelte';
import { setTransport } from '../ipc/transport';
import { resetDialogRegistry } from '../dialogs/registry';
import { dialogStack } from '../dialogs/stack.svelte';
import { resetErrorHandlers } from '../errors/handle';
import { resetActions } from '../actions/registry';
import { resetMenus } from '../menus/registry';
import { resetPanels } from '../panels/registry';
import { resetPopovers } from '../popovers/registry';
import { app } from '../stores/app.svelte';
import { github } from '../stores/github.svelte';
import { graph } from '../stores/graph.svelte';
import { op } from '../stores/op.svelte';
import { refs } from '../stores/refs.svelte';
import { repo } from '../stores/repo.svelte';
import { status } from '../stores/status.svelte';
import { toast } from '../stores/toast.svelte';
import { ui } from '../stores/ui.svelte';
import { undo } from '../stores/undo.svelte';

/** `keepRegistrations`: Keeps records (actions, menus, dialogs, panels) filled by `register-core` / `register-domains`. */
export function resetAll(opts: { keepRegistrations?: boolean } = {}): void {
  updates.stop();
  lifecycle.updating = false;
  setTransport(null);
  resetEventBus();
  resetErrorHandlers();
  dialogStack.closeAll();
  if (!opts.keepRegistrations) {
    resetDialogRegistry();
    resetActions();
    resetMenus();
    resetPanels();
    resetPopovers();
  }
  repo.reset();
  repo.info = null;
  repo.missing = false;
  repo.openError = null;
  repo.opening = false;
  repo.attempted = false;
  repo.recents = [];
  graph.reset();
  status.reset();
  refs.reset();
  op.reset();
  undo.reset();
  ui.resetForRepo();
  github.reset();
  toast.clear();
  app.detachThemeListener();
  app.info = null;
  app.bootError = null;
  app.ready = false;
}
