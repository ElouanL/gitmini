<script lang="ts">
  import { handleGlobalKeydown } from '$lib/actions/dispatcher';
  import { bootstrap } from '$lib/bootstrap';
  import { lifecycle } from '$lib/lifecycle.svelte';
  import UpdateBanner from '$lib/components/banner/UpdateBanner.svelte';
  import { dialogStack } from '$lib/dialogs/stack.svelte';
  import { app } from '$lib/stores/app.svelte';
  import { repo } from '$lib/stores/repo.svelte';
  import DialogHost from '$lib/components/dialogs-base/DialogHost.svelte';
  import { activeSession } from '$lib/stores/session.svelte';
  import RepoTabs from '$lib/components/toolbar/RepoTabs.svelte';
  import AppShell from '$lib/components/layout/AppShell.svelte';
  import ContextMenu from '$lib/components/menu/ContextMenu.svelte';
  import PopoverHost from '$lib/components/menu/PopoverHost.svelte';
  import Palette from '$lib/components/palette/Palette.svelte';
  import ToastContainer from '$lib/components/toast/ToastContainer.svelte';
  import BootError from '$lib/components/welcome/BootError.svelte';
  import GitErrorScreen from '$lib/components/welcome/GitErrorScreen.svelte';
  import RepoMissingScreen from '$lib/components/welcome/RepoMissingScreen.svelte';
  import Welcome from '$lib/components/welcome/Welcome.svelte';

  // An open dialogue is modal: the rest of the interface becomes inert (focus trapped, no clicks pass).
  const modal = $derived(dialogStack.entries.length > 0);
  // Direct opening (`AppInfo.initialPath`) underway: no open repository or opening error at the moment.
  const opening = $derived(repo.opening || (app.info?.initialPath != null && !repo.openError && !repo.isOpen && !repo.attempted));
</script>

<svelte:window onkeydown={handleGlobalKeydown} onpagehide={() => void app.flush()} onbeforeunload={() => void app.flush()} />

<div class="application">
<UpdateBanner />
<div class="root" inert={modal || lifecycle.updating}>
  {#if app.ready && !app.gitError && !app.bootError}<RepoTabs />{/if}
  <div class="content" id="repo-panel" role={repo.isOpen ? 'tabpanel' : undefined} aria-labelledby={repo.isOpen ? `repo-tab-${repo.id}` : undefined}>
  {#if app.bootError}
    <BootError error={app.bootError} retry={() => void bootstrap()} />
  {:else if !app.ready}
    <div class="splash" aria-busy="true"></div>
  {:else if app.gitError}
    <GitErrorScreen />
  {:else if repo.missing}
    <RepoMissingScreen />
  {:else if repo.isOpen}
    {#key activeSession.current}<AppShell />{/key}
  {:else if opening}
    <!-- `gitmini <path>`: no flash of the host during direct opening of the repository. -->
    <div class="splash" aria-busy="true"></div>
  {:else}
    <Welcome />
  {/if}
  </div>
</div>

</div>

<DialogHost />
<ContextMenu />
<PopoverHost />
<Palette />
<ToastContainer />

<style>
  .root {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .application { height: 100%; display: flex; flex-direction: column; }
  .content { flex: 1; min-height: 0; }
  .splash {
    height: 100%;
    background: var(--bg);
  }
</style>
