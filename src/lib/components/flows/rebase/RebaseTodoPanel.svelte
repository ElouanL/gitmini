<script lang="ts">
  import { captureStores } from '$lib/stores/context';
  const { reportError, refs, op, repo, runWrite, ui } = captureStores();
  // `rebase-todo-panel` (07 "Interactive Rebase") : view of the central area (replaces the graph) opened by
  // `ui.openCenter('rebase-todo-panel', { upstream })`. List of the oldest (top) to the latest, git order; shares
  // pick/reword/squash/fixup/drop; rescheduling by Pointer Events (handle) or Alt+↑ / Alt+▼; reword and reword messages
  // group ; validation (same rules as backend); `rebase_todo_preview` → `rebase_interactive_start { expectedHead }`.
  import { onDestroy, tick, untrack } from 'svelte';
  import { t, tp } from '$i18n/index';
  import { trackActivity } from '$lib/activity';
  import { offerUndo } from '$lib/components/flows/undo/offer-undo';
  import Icon from '$lib/components/ui/Icon.svelte';

  import { commands } from '$lib/ipc/commands';
  import type { AppError, TodoAction, TodoPreview } from '$lib/ipc/types';

  import { toast } from '$lib/stores/toast.svelte';

  import { headBranchName, worktreeDirty } from '../branches/common';
  import { isNoopSlot, moveBy, moveToSlot, slotAt, type RowRect } from './reorder';
  import { buildRows, summarize, toTodoItems, validateTodo, TODO_ACTIONS, type TodoProblem } from './todo';
  import { noteRebaseAutostash } from './autostash';
  import { targetLabel } from './rebase-state';

  interface Props {
    /** rebase base (`main`, oid of the parent of a commit); `null` = `--root`. */
    upstream: string | null;
  }

  let { upstream }: Props = $props();

  let preview = $state.raw<TodoPreview | null>(null);
  let order = $state.raw<TodoPreview['items']>([]);
  let actions = $state.raw<Record<string, TodoAction>>({});
  let rewordEdits = $state.raw<Record<string, string>>({});
  let groupEdits = $state.raw<Record<string, string>>({});
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let startError = $state<string | null>(null);
  let running = $state(false);
  let autostash = $state(untrack(() => worktreeDirty()));
  let listEl = $state<HTMLElement | undefined>();

  const rows = $derived(buildRows(order, actions, { reword: rewordEdits, group: groupEdits }));
  const problem = $derived<TodoProblem | null>(validateTodo(rows));
  const summary = $derived(summarize(rows));
  const dirty = $derived(worktreeDirty());
  const pushedCount = $derived(rows.filter((r) => r.item.pushed).length);
  const head = $derived(headBranchName() ?? t('rebase.target.head'));
  const subtitle = $derived(
    upstream === null
      ? t('rebase.todo.subtitle.root', { head })
      : t('rebase.todo.subtitle.upstream', { head, upstream: targetLabel(upstream) }),
  );
  const shownError = $derived(loadError ?? startError ?? (problem && rows.length > 0 ? t(`rebase.todo.error.${problem}`) : null));
  const canStart = $derived(preview !== null && rows.length > 0 && problem === null && !running && !op.busy && loadError === null);

  // ── Chargement

  function loadErrorText(e: AppError): string {
    switch (e.code) {
      case 'DETACHED_HEAD':
        return t('rebase.todo.error.detached');
      case 'UNSUPPORTED_MERGES':
        return t('rebase.todo.error.merges');
      case 'INVALID_ARGUMENT':
        return e.details?.reason === 'not-in-head' ? t('rebase.todo.error.notInHead') : e.message;
      default:
        return e.message;
    }
  }

  async function load(): Promise<void> {
    const repoId = repo.id;
    if (repoId === null) return;
    loading = true;
    loadError = null;
    startError = null;
    try {
      const p = await commands.rebaseTodoPreview({ repoId, upstream });
      preview = p;
      order = p.items;
      actions = Object.fromEntries(p.items.map((i) => [i.oid, 'pick' as const]));
      rewordEdits = {};
      groupEdits = {};
    } catch (e) {
      preview = null;
      order = [];
      reportError(e, {
        command: 'rebase_todo_preview',
        onError: (er) => {
          loadError = loadErrorText(er);
          return true;
        },
      });
    } finally {
      loading = false;
    }
  }

  // Reload when the base changes (reopening the panel from another line).
  $effect(() => {
    void upstream;
    untrack(() => void trackActivity('rebase-todo-load', load()));
  });

  //
  function setAction(oid: string, action: TodoAction): void {
    actions = { ...actions, [oid]: action };
    startError = null;
  }

  function setMessage(rowIndex: number, value: string): void {
    const row = rows[rowIndex];
    if (!row?.field) return;
    if (row.field.kind === 'reword') rewordEdits = { ...rewordEdits, [row.item.oid]: value };
    else if (row.joins) groupEdits = { ...groupEdits, [row.joins]: value };
    startError = null;
  }

  // -- -- Reordering: Pointer Events (never HTML5 DnD)
  let drag = $state<{ from: number; slot: number } | null>(null);
  let rects: RowRect[] = [];

  function measure(): RowRect[] {
    const els = listEl?.querySelectorAll<HTMLElement>('[data-testid="rebase-todo-row"]') ?? [];
    return [...els].map((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom };
    });
  }

  function onPointerMove(e: PointerEvent): void {
    if (!drag) return;
    const slot = slotAt(rects, e.clientY);
    if (slot !== drag.slot) drag = { from: drag.from, slot };
  }

  function stopDrag(commit: boolean): void {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerCancel);
    window.removeEventListener('keydown', onDragKey, true);
    const d = drag;
    drag = null;
    if (!d || !commit || isNoopSlot(d.from, d.slot)) return;
    const moved = order[d.from];
    order = moveToSlot(order, d.from, d.slot);
    startError = null;
    if (moved) void focusHandle(moved.oid);
  }
  const onPointerUp = (e: PointerEvent): void => {
    if (drag) drag = { from: drag.from, slot: slotAt(rects, e.clientY) };
    stopDrag(true);
  };
  const onPointerCancel = (): void => stopDrag(false);
  function onDragKey(e: KeyboardEvent): void {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    stopDrag(false);
  }

  function startDrag(e: PointerEvent, from: number): void {
    if (e.button !== 0 || running || drag) return;
    e.preventDefault();
    rects = measure();
    drag = { from, slot: from };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
    window.addEventListener('keydown', onDragKey, true);
    onPointerMove(e);
  }

  onDestroy(() => {
    if (drag) stopDrag(false);
  });

  async function focusHandle(oid: string): Promise<void> {
    await tick();
    listEl?.querySelector<HTMLElement>(`[data-oid="${oid}"] [data-testid="rebase-todo-drag-handle"]`)?.focus();
  }

  async function focusRow(oid: string): Promise<void> {
    await tick();
    listEl?.querySelector<HTMLElement>(`[data-oid="${oid}"]`)?.focus();
  }

  /** Listen `keydown` on the LIGNE (`<li>`): `Alt+↑` / `Alt+↓` works from any element of the line that has the focus. */
  function rowKeys(node: HTMLElement, handler: (e: KeyboardEvent) => void) {
    let current = handler;
    const on = (e: KeyboardEvent): void => current(e);
    node.addEventListener('keydown', on);
    return {
      update(next: (e: KeyboardEvent) => void): void {
        current = next;
      },
      destroy(): void {
        node.removeEventListener('keydown', on);
      },
    };
  }

  function onRowKey(e: KeyboardEvent, i: number): void {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || running) return;
    // In a field (list of actions, message), Alt+arrow keeps its native meaning: no reordering.
    const target = e.target as HTMLElement | null;
    const tag = target?.tagName;
    if (tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'INPUT') return;
    e.preventDefault();
    const moved = moveBy(order, i, e.key === 'ArrowUp' ? -1 : 1);
    if (moved.index === i) return;
    order = moved.list;
    startError = null;
    const oid = moved.list[moved.index]!.oid;
    // The focus follows the moved line, on the same element (the line itself or its handle).
    if (target?.getAttribute('data-testid') === 'rebase-todo-row') void focusRow(oid);
    else void focusHandle(oid);
  }

  // ── Launch

  function startErrorText(e: AppError): string | null {
    if (e.code === 'INVALID_ARGUMENT' && e.details?.field === 'todo') {
      const reason = e.details.reason;
      return reason === 'all-dropped' || reason === 'first-is-squash' || reason === 'empty-message' ? t(`rebase.todo.error.${reason}`) : e.message;
    }
    if (e.code === 'DIRTY_WORKTREE') return t('rebase.todo.error.dirty');
    if (e.code === 'DETACHED_HEAD' || e.code === 'UNSUPPORTED_MERGES') return loadErrorText(e);
    return null;
  }

  async function start(): Promise<void> {
    const repoId = repo.id;
    const p = preview;
    if (!canStart || repoId === null || !p) return;
    running = true;
    startError = null;
    const items = toTodoItems(rows);
    const useAutostash = dirty && autostash;
    const stashesBefore = refs.stashes.length;
    const res = await runWrite(
      t('rebase.op.interactive'),
      ({ opId }) =>
        commands.rebaseInteractiveStart({ repoId, opId: opId!, upstream, expectedHead: p.head, todo: items, autostash: useAutostash }),
      {
        long: true,
        command: 'rebase_interactive_start',
        onError: (e) => {
          if (e.code === 'STALE' && e.details?.what === 'todo') {
            // HEAD or range modified from preview: silent list reload.
            void trackActivity('rebase-todo-reload', load());
            return true;
          }
          if (e.code === 'CONFLICT') {
            ui.closeCenter(); // the banner of the base takes over
            return false;
          }
          if (e.code === 'CANCELLED') {
            toast.info(t('rebase.cancelled.start'));
            return true;
          }
          const text = startErrorText(e);
          if (text !== null) {
            startError = text;
            return true;
          }
          return false;
        },
      },
    );
    running = false;
    if (!res.ok) return;
    ui.closeCenter();
    if (useAutostash) await noteRebaseAutostash(stashesBefore, false);
    await offerUndo(t('rebase.todo.done', { branch: headBranchName() ?? t('rebase.target.head') }), 'rebase');
  }

  function cancel(): void {
    if (drag) stopDrag(false);
    ui.closeCenter();
  }
</script>

<section class="todo" data-testid="rebase-todo-panel" aria-label={t('rebase.todo.title')}>
  <header class="head">
    <h2>{t('rebase.todo.title')}</h2>
    <p class="muted">{subtitle}</p>
  </header>

  <div class="scroll">
    {#if loading && !preview}
      <p class="muted pad" data-testid="rebase-todo-loading">{t('rebase.todo.loading')}</p>
    {:else if rows.length === 0 && !loadError}
      <p class="muted pad" data-testid="rebase-todo-empty">{t('rebase.todo.empty')}</p>
    {/if}

    <ol class="rows" bind:this={listEl} aria-label={t('rebase.todo.list')}>
      {#each rows as row, i (row.item.oid)}
        <li
          class="row"
          class:member={row.joins !== null}
          class:dropped={row.action === 'drop'}
          class:dragging={drag?.from === i}
          class:drop-before={drag !== null && !isNoopSlot(drag.from, drag.slot) && drag.slot === i}
          class:drop-after={drag !== null && !isNoopSlot(drag.from, drag.slot) && drag.slot === rows.length && i === rows.length - 1}
          data-testid="rebase-todo-row"
          tabindex="-1"
          use:rowKeys={(e) => onRowKey(e, i)}
          data-oid={row.item.oid}
          data-action={row.action}
          data-pushed={row.item.pushed ? 'true' : 'false'}
        >
          <div class="line">
            <button
              type="button"
              class="handle"
              data-testid="rebase-todo-drag-handle"
              aria-label={t('rebase.todo.dragHandle', { sha: row.item.shortOid })}
              disabled={running}
              onpointerdown={(e) => startDrag(e, i)}
            >
              <svg width="12" height="16" viewBox="0 0 12 16" aria-hidden="true" fill="currentColor">
                <circle cx="3.5" cy="3" r="1.3" /><circle cx="8.5" cy="3" r="1.3" />
                <circle cx="3.5" cy="8" r="1.3" /><circle cx="8.5" cy="8" r="1.3" />
                <circle cx="3.5" cy="13" r="1.3" /><circle cx="8.5" cy="13" r="1.3" />
              </svg>
            </button>
            <select
              class="select action"
              data-testid="rebase-todo-action-select"
              aria-label={t('rebase.todo.actionLabel', { sha: row.item.shortOid })}
              value={row.action}
              disabled={running}
              onchange={(e) => setAction(row.item.oid, e.currentTarget.value as TodoAction)}
            >
              {#each TODO_ACTIONS as a (a)}
                <option value={a}>{t(`rebase.todo.action.${a}`)}</option>
              {/each}
            </select>
            <span class="sha mono">{row.item.shortOid}</span>
            <span class="subject truncate" title={row.item.summary}>{row.item.summary}</span>
            {#if row.item.pushed}
              <span class="cloud" title={t('rebase.todo.pushed')}><Icon name="cloud" size={13} label={t('rebase.todo.pushed')} /></span>
            {/if}
          </div>
          {#if row.field}
            <textarea
              class="textarea message"
              rows={row.field.kind === 'group' ? 4 : 2}
              data-testid="rebase-todo-message-input"
              data-kind={row.field.kind}
              aria-label={row.field.kind === 'reword' ? t('rebase.todo.message.reword') : t('rebase.todo.message.group')}
              value={row.field.value}
              disabled={running}
              oninput={(e) => setMessage(i, e.currentTarget.value)}
            ></textarea>
          {/if}
        </li>
      {/each}
    </ol>
  </div>

  <footer class="foot">
    {#if pushedCount > 0}
      <p class="warning" role="note" data-testid="rebase-todo-pushed-warning">
        <Icon name="alert" size={14} />
        <span>{tp('rebase.todo.pushedWarning', pushedCount)}</span>
      </p>
    {/if}
    {#if shownError}
      <p class="field-error" role="alert" data-testid="rebase-todo-error">{shownError}</p>
    {/if}
    <div class="bar">
      <span class="summary muted" data-testid="rebase-todo-summary">
        {#if rows.length > 0}
          {tp('rebase.todo.summary.base', summary.before, { before: summary.before, after: summary.after })}{summary.dropped > 0
            ? `, ${tp('rebase.todo.summary.dropped', summary.dropped)}`
            : ''}
        {/if}
      </span>
      <span class="spacer"></span>
      {#if dirty}
        <label class="checkbox">
          <input type="checkbox" data-testid="rebase-todo-autostash-checkbox" bind:checked={autostash} disabled={running} />
          <span>{t('rebase.todo.autostash')}</span>
        </label>
      {/if}
      <button type="button" class="btn" data-testid="rebase-todo-cancel-btn" onclick={cancel}>{t('rebase.todo.cancel')}</button>
      <button type="button" class="btn btn-primary" data-testid="rebase-todo-start-btn" disabled={!canStart} onclick={() => void start()}>
        {t('rebase.todo.start')}
      </button>
    </div>
  </footer>
</section>

<style>
  .todo {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: var(--bg);
  }
  .head {
    padding: 12px 16px 8px;
    border-bottom: 1px solid var(--border);
  }
  .head p {
    margin: 2px 0 0;
  }
  .scroll {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }
  .pad {
    padding: 12px 16px;
  }
  .rows {
    margin: 0;
    padding: 4px 0;
    list-style: none;
  }
  .row {
    position: relative;
    padding: 4px 16px;
    border-top: 2px solid transparent;
    border-bottom: 2px solid transparent;
  }
  .row:hover {
    background: var(--row-hover);
  }
  .row.member {
    padding-left: 44px;
  }
  .row.member::before {
    content: '';
    position: absolute;
    left: 28px;
    top: 0;
    bottom: 0;
    border-left: 2px solid var(--border);
  }
  .row.dropped .subject,
  .row.dropped .sha {
    text-decoration: line-through;
    opacity: 0.6;
  }
  .row.dragging {
    opacity: 0.5;
  }
  .row.drop-before {
    border-top-color: var(--accent);
  }
  .row.drop-after {
    border-bottom-color: var(--accent);
  }
  .line {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: var(--row-height);
  }
  .handle {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 24px;
    padding: 0;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--fg-muted);
    cursor: grab;
    touch-action: none;
  }
  .handle:hover:not(:disabled) {
    color: var(--fg);
    background: var(--row-selected);
  }
  .action {
    flex: none;
    width: 230px;
  }
  .sha {
    flex: none;
    color: var(--fg-muted);
  }
  .subject {
    flex: 1;
    min-width: 0;
  }
  .cloud {
    flex: none;
    display: inline-flex;
    color: var(--fg-muted);
  }
  .message {
    display: block;
    width: calc(100% - 30px);
    margin: 4px 0 4px 30px;
    font-family: var(--font-mono);
    font-size: 12px;
  }
  .foot {
    padding: 8px 16px 12px;
    border-top: 1px solid var(--border);
    background: var(--bg-elev);
  }
  .warning {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    margin: 0 0 8px;
    padding: 6px 8px;
    border: 1px solid var(--warn);
    border-radius: var(--radius-sm);
  }
  .warning :global(svg) {
    flex: none;
    margin-top: 2px;
    color: var(--warn);
  }
  .field-error {
    margin: 0 0 8px;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .spacer {
    flex: 1;
  }
</style>
