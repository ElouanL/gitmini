<script lang="ts">
  // A line of `wt-panel` (05): badge of the type of change, path, buttons visible on the fly-over / focus.
  // `side` : `unstaged` (`wt-unstaged-item`), `staged` (`wt-staged-item`) ou `conflict` (`wt-conflict-item`).
  import type { FileStatus } from '$lib/ipc/types';
  import { contextMenu } from '$lib/actions/context-menu';
  import type { MenuTarget } from '$lib/menus/types';
  import { t, tp } from '$i18n/index';
  import { CHANGE_LETTER, changeOf, isReadonly, rowLabel, type ListSide } from './list-model';
  import RowIcon from './RowIcon.svelte';

  interface Props {
    file: FileStatus;
    side: ListSide;
    index: number;
    /** Ordained from the top of the line to virtualized list; `undefined` = normal stream. */
    top?: number;
    selected: boolean;
    focused: boolean;
    /** The diff of this file is displayed in the central area. */
    open: boolean;
    /** A writing about this file is in flight (the button passes "in progress"). */
    pending: boolean;
    /** Any writing is in flight: the writing buttons are disabled. */
    locked: boolean;
    /** Number of files covered by a button in this line (selection if the line is part of it). */
    targets: number;
    menuTarget: () => MenuTarget | null;
    onselect: (e: MouseEvent) => void;
    onstage?: () => void;
    onunstage?: () => void;
    ondiscard?: () => void;
    onresolve?: () => void;
    onopen?: () => void;
  }

  let { file, side, index, top, selected, focused, open, pending, locked, targets, menuTarget, onselect, onstage, onunstage, ondiscard, onresolve, onopen }: Props = $props();

  const ARROW = ' → ';
  const label = $derived(rowLabel(file, side));
  const change = $derived(changeOf(file, side));
  const readonly = $derived(isReadonly(file));
  const gone = $derived(change === 'deleted');
  const testid = $derived(side === 'conflict' ? 'wt-conflict-item' : side === 'staged' ? 'wt-staged-item' : 'wt-unstaged-item');
  const badge = $derived(side === 'conflict' ? '!' : change ? CHANGE_LETTER[change] : '');
  const badgeTitle = $derived(side === 'conflict' ? t(`wt.conflict.${file.conflict ?? 'both-modified'}`) : change ? t(`wt.change.${change}`) : '');
  const multi = $derived(targets > 1);

  function stop(e: MouseEvent, fn?: () => void): void {
    e.stopPropagation();
    fn?.();
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  class="row"
  class:selected
  class:focused
  class:conflict={side === 'conflict'}
  class:open
  class:virtual={top !== undefined}
  style:transform={top !== undefined ? `translateY(${top}px)` : undefined}
  role="option"
  id="wt-{side}-{index}"
  aria-selected={selected}
  tabindex="-1"
  data-testid={testid}
  data-path={file.path}
  data-change={side === 'conflict' ? undefined : (change ?? undefined)}
  data-conflict-kind={side === 'conflict' ? (file.conflict ?? undefined) : undefined}
  data-submodule={file.submodule ? 'true' : undefined}
  data-readonly={file.nonUtf8 ? 'true' : undefined}
  data-selected={selected ? 'true' : undefined}
  data-pending={pending ? 'true' : undefined}
  title={label.full}
  onclick={onselect}
  use:contextMenu={menuTarget}
>
  <span class="badge" data-kind={side === 'conflict' ? 'conflict' : change} title={badgeTitle}>{badge}</span>
  <span class="name">
    {#if label.oldPath}
      <span class="old">{label.oldPath}</span><span class="arrow">{ARROW}</span><span class="base">{file.path}</span>
    {:else}
      {#if label.dir}<span class="dir">{label.dir}</span>{/if}<span class="base">{label.base}</span>
    {/if}
  </span>
  {#if file.submodule}<span class="flag muted" title={t('wt.readonly.submodule')}>{t('wt.flag.submodule')}</span>{/if}
  {#if file.nonUtf8}<span class="flag muted" title={t('wt.readonly.nonUtf8')}>{t('wt.flag.nonUtf8')}</span>{/if}

  {#if side === 'conflict'}
    <button
      type="button"
      class="resolve"
      tabindex="-1"
      data-testid="wt-conflict-resolve-btn"
      disabled={locked}
      aria-busy={pending || undefined}
      onclick={(e) => stop(e, onresolve)}
    >
      <RowIcon name="check" size={12} />{t('wt.btn.resolve')}
    </button>
  {/if}
  <span class="actions">
    {#if !readonly && !gone}
      <button type="button" class="icon" tabindex="-1" data-testid="wt-open-external-btn" title={t('wt.btn.openExternal')} aria-label={t('wt.btn.openExternal')} onclick={(e) => stop(e, onopen)}>
        <RowIcon name="external" />
      </button>
    {/if}
    {#if side === 'unstaged' && !readonly}
      <button
        type="button"
        class="icon"
        tabindex="-1"
        data-testid="wt-discard-file-btn"
        title={multi ? tp('wt.btn.discardN', targets) : t('wt.btn.discard')}
        aria-label={multi ? tp('wt.btn.discardN', targets) : t('wt.btn.discard')}
        disabled={locked}
        onclick={(e) => stop(e, ondiscard)}
      >
        <RowIcon name="discard" />
      </button>
      <button
        type="button"
        class="icon"
        tabindex="-1"
        data-testid="wt-stage-file-btn"
        title={multi ? tp('wt.btn.stageN', targets) : t('wt.btn.stage')}
        aria-label={multi ? tp('wt.btn.stageN', targets) : t('wt.btn.stage')}
        disabled={locked}
        aria-busy={pending || undefined}
        onclick={(e) => stop(e, onstage)}
      >
        <RowIcon name="stage" />
      </button>
    {/if}
    {#if side === 'staged' && !readonly}
      <button
        type="button"
        class="icon"
        tabindex="-1"
        data-testid="wt-unstage-file-btn"
        title={multi ? tp('wt.btn.unstageN', targets) : t('wt.btn.unstage')}
        aria-label={multi ? tp('wt.btn.unstageN', targets) : t('wt.btn.unstage')}
        disabled={locked}
        aria-busy={pending || undefined}
        onclick={(e) => stop(e, onunstage)}
      >
        <RowIcon name="unstage" />
      </button>
    {/if}
  </span>
</div>

<style>
  .row {
    position: relative;
    display: flex;
    align-items: center;
    gap: 6px;
    height: var(--row-height);
    padding: 0 6px 0 8px;
    cursor: default;
    user-select: none;
    border-left: 2px solid transparent;
  }
  .row.virtual {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
  }
  .row:hover {
    background: var(--row-hover);
  }
  .row.selected {
    background: var(--row-selected);
  }
  .row.open {
    border-left-color: var(--accent);
  }
  /* The "focused" file is highlighted only when the list has the keyboard focus. */
  :global([role='listbox']:focus-within) .row.focused {
    box-shadow: inset 0 0 0 1px var(--accent);
  }
  .badge {
    flex: none;
    width: 18px;
    height: 18px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-sm);
    font: 600 11px/1 var(--font-mono);
    color: var(--bg);
    background: var(--fg-muted);
  }
  .badge[data-kind='added'],
  .badge[data-kind='untracked'] {
    background: var(--success);
  }
  .badge[data-kind='modified'],
  .badge[data-kind='typechange'] {
    background: var(--warn);
  }
  .badge[data-kind='deleted'],
  .badge[data-kind='conflict'] {
    background: var(--danger);
  }
  .badge[data-kind='renamed'],
  .badge[data-kind='copied'] {
    background: var(--accent);
  }
  .name {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dir,
  .old,
  .arrow {
    color: var(--fg-muted);
  }
  .flag {
    flex: none;
    font-size: 11px;
  }
  .actions {
    flex: none;
    display: flex;
    align-items: center;
    gap: 2px;
    /* Viewable "overflight" without `opacity: 0` or `visibility`: buttons remain displayed and clickable for WebDriver
       (a transparent element is not "displayed"), only their path is invisible as long as the line is not over and selected. */
    color: transparent;
  }
  .row:hover .actions,
  .row.focused .actions,
  .row.selected .actions,
  .row:focus-within .actions,
  .row.conflict .actions {
    color: var(--fg);
  }
  .icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    padding: 0;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: inherit;
  }
  .icon:hover:not(:disabled) {
    background: var(--border);
  }
  .icon:disabled {
    opacity: 0.4;
  }
  .icon[aria-busy='true'] {
    opacity: 0.5;
  }
  .resolve {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 22px;
    padding: 0 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-elev);
    font-size: 11px;
    white-space: nowrap;
  }
  .resolve:hover:not(:disabled) {
    background: var(--row-hover);
    border-color: var(--accent);
  }
  .resolve:disabled {
    opacity: 0.5;
  }
</style>
