<script lang="ts">
  import { captureStores } from '$lib/stores/context';
  const { op } = captureStores();
  // `checkout-dirty-dialog` (06 "Checkout"): opened by `handleError` on `DIRTY_WORKTREE` of a `branch_checkout` or a
  // `branch_create { checkout: true }` (props `{ error, command, retry, data }`). "Stash and switch" restarts the
  // control with `autoStash: { reapply }` (one backend side lock); there is no "toss and toss".
  import { t } from '$i18n/index';
  import DialogShell from '$lib/components/dialogs-base/DialogShell.svelte';
  import type { DialogProps } from '$lib/dialogs/registry';
  import type { CheckoutTarget } from '$lib/ipc/commands';
  import type { AppError } from '$lib/ipc/types';

  import { asCheckoutTarget, checkoutTargetLabel, checkoutWithAutoStash, createWithAutoStash, type CreateArgs } from './ops';

  interface Props extends DialogProps<boolean> {
    error?: AppError;
    command?: string;
    retry?: () => unknown;
    data?: Record<string, unknown>;
  }

  let { error, command, data, close }: Props = $props();

  const paths = $derived(
    Array.isArray(error?.details?.paths) ? (error.details.paths as unknown[]).filter((p): p is string => typeof p === 'string') : [],
  );
  const target: CheckoutTarget | null = $derived(asCheckoutTarget(data?.target));
  const create: CreateArgs | null = $derived.by(() => {
    const c = data?.create as { name?: unknown; startPoint?: unknown } | undefined;
    if (command !== 'branch_create' || !c || typeof c.name !== 'string') return null;
    return { name: c.name, startPoint: typeof c.startPoint === 'string' ? c.startPoint : null };
  });
  const targetLabel = $derived(
    create ? t('branches.checkout.target.branch', { name: create.name }) : target ? checkoutTargetLabel(target) : '',
  );

  let reapply = $state(true);
  let busy = $state(false);

  async function stashAndSwitch(): Promise<void> {
    if (busy) return;
    busy = true;
    const ok = create
      ? await createWithAutoStash(create, reapply)
      : target
        ? await checkoutWithAutoStash(target, reapply)
        : false;
    busy = false;
    if (ok) close(true);
  }
</script>

<DialogShell testid="checkout-dirty-dialog" title={t('branches.checkoutDirty.title')} onclose={() => close()} onsubmit={() => void stashAndSwitch()}>
  <p class="message">{t('branches.checkoutDirty.message', { target: targetLabel })}</p>
  {#if paths.length > 0}
    <ul class="files mono" data-testid="checkout-dirty-files">
      {#each paths as p (p)}
        <li class="truncate" title={p}>{p}</li>
      {/each}
    </ul>
  {:else}
    <p class="muted" data-testid="checkout-dirty-files">{t('branches.checkoutDirty.noFiles')}</p>
  {/if}
  <label class="checkbox">
    <input type="checkbox" data-testid="checkout-dirty-reapply-toggle" bind:checked={reapply} />
    <span>{t('branches.checkoutDirty.reapply')}</span>
  </label>

  {#snippet footer()}
    <button type="button" class="btn" data-testid="checkout-dirty-cancel-btn" onclick={() => close()}>
      {t('branches.checkoutDirty.cancel')}
    </button>
    <button
      type="button"
      class="btn btn-primary"
      data-autofocus
      data-testid="checkout-dirty-stash-btn"
      disabled={busy || op.busy || (!create && !target)}
      onclick={() => void stashAndSwitch()}
    >
      {t('branches.checkoutDirty.stash')}
    </button>
  {/snippet}
</DialogShell>

<style>
  .message {
    margin: 8px 0;
  }
  .files {
    max-height: 160px;
    margin: 0 0 12px;
    padding: 6px 8px;
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-elev);
    font-size: 12px;
  }
</style>
