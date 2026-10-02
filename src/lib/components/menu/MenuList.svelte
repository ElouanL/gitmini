<script lang="ts" module>
  export interface MenuListItem {
    key: string;
    label: string;
    testid: string;
    disabled?: boolean;
    danger?: boolean;
    separatorBefore?: boolean;
    hint?: string;
    onselect: () => void;
  }
</script>

<script lang="ts">
  // Accessible menu list (role=menu): ↑/▼, Start/End, Entry, Escape (via `onclose`). Used by ContextMenu and dropdowns.
  import { onMount } from 'svelte';

  interface Props {
    items: MenuListItem[];
    testid?: string;
    attrs?: Record<string, string | undefined>;
    label?: string;
    autofocus?: boolean;
    onclose: () => void;
  }

  let { items, testid, attrs = {}, label, autofocus = true, onclose }: Props = $props();
  let root: HTMLDivElement;

  const buttons = () => [...root.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')];

  onMount(() => {
    if (autofocus) buttons()[0]?.focus({ preventScroll: true });
  });

  function onkeydown(e: KeyboardEvent): void {
    const list = buttons();
    if (list.length === 0) return;
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    let next: number | null = null;
    if (e.key === 'ArrowDown') next = i < 0 ? 0 : (i + 1) % list.length;
    else if (e.key === 'ArrowUp') next = i <= 0 ? list.length - 1 : i - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = list.length - 1;
    else if (e.key === 'Tab') {
      e.preventDefault();
      onclose();
      return;
    }
    if (next !== null) {
      e.preventDefault();
      e.stopPropagation();
      list[next]?.focus({ preventScroll: true });
    }
  }
</script>

<div bind:this={root} class="menu" role="menu" aria-label={label} data-testid={testid} {...attrs} {onkeydown}>
  {#each items as item (item.key)}
    {#if item.separatorBefore}<div class="sep" role="separator"></div>{/if}
    <button
      type="button"
      role="menuitem"
      class="item"
      class:danger={item.danger}
      data-testid={item.testid}
      disabled={item.disabled}
      onclick={() => item.onselect()}
    >
      <span class="label">{item.label}</span>
      {#if item.hint}<span class="hint">{item.hint}</span>{/if}
    </button>
  {/each}
</div>

<style>
  .menu {
    min-width: 200px;
    max-width: 360px;
    padding: 4px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
  }
  .item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    width: 100%;
    height: 28px;
    padding: 0 10px;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    text-align: left;
    color: var(--fg);
  }
  .item:hover:not(:disabled),
  .item:focus-visible {
    background: var(--row-hover);
    box-shadow: none;
  }
  .item:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  .item:disabled {
    color: var(--fg-muted);
    opacity: 0.6;
  }
  .item.danger {
    color: var(--danger);
  }
  .label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .hint {
    color: var(--fg-muted);
    font-size: 11px;
  }
  .sep {
    height: 1px;
    margin: 4px 2px;
    background: var(--border);
  }
</style>
