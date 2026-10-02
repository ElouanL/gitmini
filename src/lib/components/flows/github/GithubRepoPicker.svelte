<script lang="ts">
  // `github-repo-picker[data-state=loading|ready|error|logged-out]` (10 §GitHub): selector shared by the addition of remote and clone.
  // Local filter (`github-repos-search-input`), lines `github-repo-item[data-full-name]`, error + `github-repos-retry-btn`,
  // Disconnected (`AUTH_REQUIRED { github: true }`, token deleted) → `github-login-btn`. No cache: recharged at each opening.
  import { onMount, untrack } from 'svelte';
  import { roving } from '$lib/actions/roving';
  import { openDialog } from '$lib/dialogs/registry';
  import { commands } from '$lib/ipc/commands';
  import { isAppError } from '$lib/ipc/transport';
  import type { GithubRepo } from '$lib/ipc/types';
  import { github } from '$lib/stores/github.svelte';
  import { t } from '$i18n/index';
  import Spinner from '$lib/components/ui/Spinner.svelte';
  import { filterRepos, loadAllRepos, REPOS_PER_PAGE } from './github-repos';

  interface Props {
    /** `fullName` of the chosen repository. */
    selected?: string | null;
    onselect: (repo: GithubRepo) => void;
  }

  let { selected = null, onselect }: Props = $props();

  type PickerState = 'loading' | 'ready' | 'error' | 'logged-out';

  let pickerState = $state<PickerState>('loading');
  let repos = $state.raw<GithubRepo[]>([]);
  let more = $state(false);
  let query = $state('');
  let errorMessage = $state('');
  let seq = 0;

  const shown = $derived(filterRepos(repos, query));
  /** Primitive: the effect does not recover when `github.status` is replaced by an equivalent object. */
  const phase = $derived(github.status === null ? 'unknown' : github.loggedIn ? 'in' : 'out');

  async function load(): Promise<void> {
    const mine = ++seq;
    const cancelled = (): boolean => mine !== seq;
    pickerState = 'loading';
    errorMessage = '';
    repos = [];
    more = false;
    try {
      await loadAllRepos({
        fetchPage: (page) => commands.githubRepos({ page, perPage: REPOS_PER_PAGE }),
        onPage: (all, hasMore) => {
          repos = all;
          more = hasMore;
          pickerState = 'ready';
        },
        cancelled,
      });
    } catch (e) {
      if (cancelled()) return;
      if (isAppError(e) && e.code === 'AUTH_REQUIRED') {
        // Token revoked: the backend deleted it, the IU returns to the disconnected state.
        github.setLoggedOut();
        pickerState = 'logged-out';
        return;
      }
      errorMessage = isAppError(e) ? e.message : String(e);
      pickerState = repos.length > 0 ? 'ready' : 'error';
      more = false;
    }
  }

  onMount(() => {
    void github.ensureLoaded();
    return () => {
      seq++;
    };
  });

  $effect(() => {
    const p = phase;
    untrack(() => {
      if (p === 'unknown') pickerState = 'loading';
      else if (p === 'out') {
        seq++;
        repos = [];
        pickerState = 'logged-out';
      } else void load();
    });
  });
</script>

<div class="picker" data-testid="github-repo-picker" data-state={pickerState} aria-label={t('github.picker.label')}>
  {#if pickerState === 'logged-out'}
    <div class="state">
      <p class="muted">{t('github.picker.loggedOut')}</p>
      <button type="button" class="btn btn-primary" data-testid="github-login-btn" onclick={() => void openDialog('github-login-dialog')}>{t('github.picker.login')}</button>
    </div>
  {:else if pickerState === 'error'}
    <div class="state">
      <p data-testid="github-repos-error" role="alert">{t('github.picker.error')}{errorMessage ? ` ${errorMessage}` : ''}</p>
      <button type="button" class="btn" data-testid="github-repos-retry-btn" onclick={() => void load()}>{t('github.picker.retry')}</button>
    </div>
  {:else}
    <input
      class="input search"
      type="search"
      data-testid="github-repos-search-input"
      placeholder={t('github.picker.search')}
      aria-label={t('github.picker.search')}
      bind:value={query}
      onkeydown={(e) => {
        // Enter only filters; it does not submit the containing dialog.
        if (e.key === 'Enter') e.preventDefault();
      }}
    />
    {#if pickerState === 'loading'}
      <p class="muted state"><Spinner size={12} /> {t('github.picker.loading')}</p>
    {:else if shown.length === 0}
      <p class="muted state">{repos.length === 0 ? t('github.picker.empty') : t('github.picker.noMatch')}</p>
    {:else}
      <ul class="list" use:roving={'[data-roving]'}>
        {#each shown as r (r.fullName)}
          <li>
            <button
              type="button"
              class="item"
              class:selected={selected === r.fullName}
              data-roving
              data-testid="github-repo-item"
              data-full-name={r.fullName}
              aria-pressed={selected === r.fullName}
              onclick={() => onselect(r)}
            >
              <span class="name truncate">{r.fullName}</span>
              {#if r.private}<span class="chip">{t('github.picker.private')}</span>{/if}
              {#if r.fork}<span class="chip">{t('github.picker.fork')}</span>{/if}
              {#if r.description}<span class="desc muted truncate">{r.description}</span>{/if}
            </button>
          </li>
        {/each}
      </ul>
      {#if more}<p class="muted more"><Spinner size={12} /> {t('github.picker.loadingMore')}</p>{/if}
    {/if}
  {/if}
</div>

<style>
  .picker {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-height: 140px;
  }
  .state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    margin: 12px 0;
    text-align: center;
  }
  .list {
    max-height: 220px;
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }
  .item {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 2px 8px;
    width: 100%;
    padding: 4px 8px;
    border: 0;
    background: transparent;
    text-align: left;
  }
  .item:hover {
    background: var(--row-hover);
  }
  .item.selected {
    background: var(--row-selected);
  }
  .name {
    font-weight: 600;
    min-width: 0;
  }
  .desc {
    flex-basis: 100%;
    font-size: 12px;
  }
  .chip {
    padding: 0 6px;
    border: 1px solid var(--border);
    border-radius: 999px;
    font-size: 11px;
    color: var(--fg-muted);
  }
  .more {
    margin: 0;
    font-size: 12px;
  }
</style>
