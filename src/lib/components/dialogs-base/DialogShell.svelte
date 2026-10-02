<script lang="ts">
  // Cover of all dialogues: background, focus trapped, Tab / Shift+Tab cycle, Input that confirms (outside multi-line field),
  // initial focus (`[data-autofocus]`, if not the first field), repository of the focus when closed.
  // Escape is managed globally (src/lib/actions/dispatcher.ts): it closes the dialogue above.
  import { getContext, onMount, type Snippet } from 'svelte';
  import { dialogStack } from '$lib/dialogs/stack.svelte';
  import { t } from '$i18n/index';

  interface Props {
    /** `data-testid` of the dialog (`branch-create-dialog`...). */
    testid: string;
    title: string;
    /** Destructive action: Red button on the calling side, background not clickable. */
    danger?: boolean;
    /** Largeur en px. */
    width?: number;
    /** Closes the dialogue without result (cross, bottom, escape). */
    onclose: () => void;
    /** Entry into a simple field: confirms. */
    onsubmit?: () => void;
    /** Additional `data-*` attributes on the root (`data-action`, `data-kind`, `data-state`...). */
    attrs?: Record<string, string | undefined>;
    dismissOnBackdrop?: boolean;
    children: Snippet;
    footer?: Snippet;
  }

  let { testid, title, danger = false, width = 440, onclose, onsubmit, attrs = {}, dismissOnBackdrop, children, footer }: Props = $props();

  const dlg = getContext<{ key: number } | undefined>('gitmini-dialog');
  const titleId = `dlg-title-${Math.random().toString(36).slice(2, 9)}`;
  let root: HTMLDivElement;

  const FOCUSABLE =
    'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  function focusables(): HTMLElement[] {
    return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => {
      if (el.hidden) return false;
      const cs = getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden';
    });
  }

  onMount(() => {
    const previous = document.activeElement as HTMLElement | null;
    const initial = root.querySelector<HTMLElement>('[data-autofocus]') ?? focusables().find((el) => el.dataset.dialogClose === undefined) ?? root;
    initial.focus({ preventScroll: true });
    return () => {
      // After removing `inert` on the rest of the interface (same rendering cycle).
      queueMicrotask(() => {
        if (previous && previous.isConnected) previous.focus({ preventScroll: true });
      });
    };
  });

  const isTop = () => !dlg || dialogStack.top?.key === dlg.key;

  function onkeydown(e: KeyboardEvent): void {
    if (!isTop()) return;
    if (e.key === 'Tab') {
      const list = focusables();
      if (list.length === 0) {
        e.preventDefault();
        return;
      }
      const first = list[0]!;
      const last = list[list.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === root)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
      return;
    }
    if (e.key === 'Enter' && onsubmit && !e.isComposing && !e.defaultPrevented) {
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === 'TEXTAREA' || tag === 'BUTTON' || tag === 'A' || tag === 'SELECT') return;
      e.preventDefault();
      onsubmit();
    }
  }

  const backdropCloses = $derived(dismissOnBackdrop ?? !danger);
</script>

<div
  class="backdrop"
  role="presentation"
  onpointerdown={(e) => {
    if (e.target === e.currentTarget && backdropCloses) onclose();
  }}
>
  <div
    bind:this={root}
    class="dialog"
    class:danger
    role="dialog"
    aria-modal="true"
    aria-labelledby={titleId}
    tabindex="-1"
    style:width="{width}px"
    data-testid={testid}
    {...attrs}
    {onkeydown}
  >
    <header>
      <h2 id={titleId}>{title}</h2>
      <button type="button" class="icon-btn close" aria-label={t('dialog.close')} data-dialog-close onclick={onclose}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
      </button>
    </header>
    <div class="body">{@render children()}</div>
    {#if footer}
      <footer>{@render footer()}</footer>
    {/if}
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: var(--z-dialog);
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 12vh;
    background: var(--overlay);
  }
  .dialog {
    max-width: calc(100vw - 32px);
    max-height: 80vh;
    display: flex;
    flex-direction: column;
    background: var(--bg);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
  }
  .dialog.danger {
    border-top: 3px solid var(--danger);
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 12px 8px 4px 16px;
  }
  h2 {
    font-size: 15px;
  }
  .body {
    padding: 8px 16px 12px;
    overflow: auto;
  }
  footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 10px 16px 14px;
    border-top: 1px solid var(--border);
  }
</style>
