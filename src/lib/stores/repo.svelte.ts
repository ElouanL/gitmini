// Repository workspace: ordered tabs, active repository and persisted startup session.
import { commands } from '../ipc/commands';
import type { ErrorCode, HeadInfo, RecentRepo, RepoInfo } from '../ipc/types';
import type { TabsSetting } from '../ipc/settings-types';
import { closeAllDialogs } from '../dialogs/registry';
import { dialogStack } from '../dialogs/stack.svelte';
import { reportError } from '../errors/report';
import { perfMark } from '../perf';
import { t } from '../../i18n/index';
import { app } from './app.svelte';
import { graphFor } from './graph.svelte';
import { opFor } from './op.svelte';
import { refsFor } from './refs.svelte';
import { activeSession, Session } from './session.svelte';
import { statusFor } from './status.svelte';
import { uiFor } from './ui.svelte';
import { undoFor } from './undo.svelte';
import { toast } from './toast.svelte';

export interface OpenError {
  code: ErrorCode;
  reason: string | null;
  message: string;
  path: string;
  details: Record<string, unknown>;
}
const OPEN_ERROR_CODES: ReadonlySet<ErrorCode> = new Set(['NOT_A_REPO', 'NOT_FOUND', 'UNSUPPORTED_REPO_FORMAT']);

/** Stable view captured by an action: reading it after await still refers to its original tab. */
export class RepoView {
  constructor(private readonly captured?: Session) {}
  get owner(): Session { return this.captured ?? activeSession.current; }
  get info(): RepoInfo | null { return this.owner.info; }
  set info(value: RepoInfo | null) { this.owner.info = value; }
  get missing(): boolean { return this.owner.missing; }
  set missing(value: boolean) { this.owner.missing = value; }
  get isOpen(): boolean { return this.info !== null; }
  get id(): number | null { return this.info?.id ?? this.owner.repoId; }
  get name(): string { return this.info?.name ?? ''; }
  get head(): HeadInfo | null { return refsFor(this.owner).head ?? statusFor(this.owner).snapshot?.head ?? this.info?.head ?? null; }

  markMissing(): void {
    if (!this.info || this.missing) return;
    this.missing = true;
    this.owner.attention = true;
    statusFor(this.owner).deactivate();
    if (this.owner === activeSession.current) closeAllDialogs();
  }
  closeMissing(): Promise<void> { return repo.close(this.owner); }
}

class RepoStore extends RepoView {
  tabs = $state.raw<Session[]>([]);
  recents = $state.raw<RecentRepo[]>([]);
  openError = $state.raw<OpenError | null>(null);
  opening = $state(false);
  attempted = $state(false);
  restoring = $state(false);
  #title = Promise.resolve();
  #lastOpenedPath: string | null = null;

  async refreshRecents(): Promise<void> {
    try { this.recents = await commands.repoRecentList(); }
    catch (e) { reportError(e, { command: 'repo_recent_list', quiet: true }); }
  }

  async open(path: string, opts: { activate?: boolean; restoring?: boolean } = {}): Promise<boolean> {
    if (this.opening) return false;
    this.#lastOpenedPath = null;
    const existing = this.tabs.find((tab) => tab.info?.workdir === path);
    if (existing) {
      this.#lastOpenedPath = existing.info!.workdir;
      if (opts.activate !== false) this.activate(existing);
      return true;
    }
    const previous = activeSession.current;
    this.opening = true;
    this.attempted = true;
    this.openError = null;
    try {
      perfMark('gitmini:repo-open-start');
      const info = await commands.repoOpen({ path });
      this.#lastOpenedPath = info.workdir;
      this.adopt(info, opts.activate !== false && activeSession.current === previous);
      return true;
    } catch (e) {
      reportError(e, {
        command: 'repo_open', quiet: opts.restoring,
        onError: (er) => {
          if (!OPEN_ERROR_CODES.has(er.code) || (er.code === 'NOT_FOUND' && er.details?.what !== 'path')) return false;
          this.openError = {
            code: er.code, reason: typeof er.details?.reason === 'string' ? er.details.reason : null,
            message: er.message, path, details: er.details ?? {},
          };
          if (this.tabs.length && !opts.restoring) toast.error(er.message, { title: path });
          return true;
        },
      });
      await this.refreshRecents();
      return false;
    } finally { this.opening = false; }
  }

  /** Clone returns an already-open handle; adding it must not close any other tab. */
  adopt(info: RepoInfo, activate = true): void {
    const existing = this.tabs.find((tab) => tab.info?.workdir === info.workdir);
    if (existing) {
      if (activate) this.activate(existing);
      return;
    }
    const owner = new Session();
    const gen = owner.begin(info.id);
    owner.info = info;
    this.tabs = [...this.tabs, owner];
    opFor(owner).setState(info.opState);
    graphFor(owner).onIndexComplete(() => {
      if (!owner.isCurrent(gen)) return;
      void refsFor(owner).reloadRefs();
      void statusFor(owner).refresh();
    });
    if (activate) this.activate(owner);
    const graph = graphFor(owner);
    void graph.loadFirstPage();
    void refsFor(owner).reloadRefs();
    void refsFor(owner).reloadRemotes();
    void refsFor(owner).reloadStashes();
    void statusFor(owner).refresh().then(() => {
      if (owner.isCurrent(gen) && graph.selection.kind === 'none' && statusFor(owner).files.length > 0) graph.selectWip();
    });
    void undoFor(owner).peekNow();
    void this.refreshRecents();
    this.persist();
  }

  activate(owner: Session): boolean {
    if (!this.tabs.includes(owner) || dialogStack.top) return false;
    if (owner !== activeSession.current) {
      const ui = uiFor(activeSession.current);
      ui.contextMenu = null;
      ui.popover = null;
      ui.paletteOpen = false;
      statusFor(activeSession.current).deactivate();
      activeSession.current = owner;
    }
    statusFor(owner).activate();
    owner.attention = false;
    document.title = t('app.windowTitle', { name: owner.info?.name ?? '' });
    this.syncTitle(owner.repoId);
    this.persist();
    return true;
  }

  cycle(direction: number): void {
    if (this.tabs.length < 2) return;
    const i = this.tabs.indexOf(activeSession.current);
    this.activate(this.tabs[(i + direction + this.tabs.length) % this.tabs.length]!);
  }

  async close(owner: Session = activeSession.current): Promise<void> {
    if (opFor(owner).busy || this.opening) return;
    const id = owner.repoId ?? owner.info?.id ?? null;
    const index = this.tabs.indexOf(owner);
    const wasActive = owner === activeSession.current;
    owner.end();
    owner.info = null;
    owner.missing = false;
    graphFor(owner).onIndexComplete(null);
    for (const store of owner.stores.values()) {
      (store as { reset?: () => void }).reset?.call(store);
    }
    uiFor(owner).resetForRepo();
    this.tabs = this.tabs.filter((tab) => tab !== owner);
    if (wasActive) {
      closeAllDialogs();
      const next = this.tabs[Math.min(Math.max(index, 0), this.tabs.length - 1)];
      if (next) this.activate(next);
      else {
        activeSession.current = new Session();
        document.title = t('app.title');
        this.syncTitle(null);
      }
    }
    this.persist();
    if (id !== null) {
      try { await commands.repoClose({ repoId: id }); }
      catch (e) { reportError(e, { command: 'repo_close', quiet: true }); }
    }
    await this.refreshRecents();
  }

  private syncTitle(repoId: number | null): void {
    // Serialize rapid switches: a late IPC call cannot overwrite a newer title.
    this.#title = this.#title.then(() => commands.repoActivate({ repoId })).then(() => undefined)
      .catch((e) => { reportError(e, { command: 'repo_activate', quiet: true }); });
  }

  persist(): void {
    if (this.restoring) return;
    void app.set('workspace.tabs', {
      paths: this.tabs.flatMap((tab) => tab.info ? [tab.info.workdir] : []),
      activePath: activeSession.current.info?.workdir ?? null,
    });
  }

  async restore(saved: TabsSetting | null, initialPath: string | null): Promise<void> {
    this.restoring = true;
    const paths = [...new Set(saved?.paths ?? [])];
    if (initialPath && !paths.includes(initialPath)) paths.push(initialPath);
    const preferred = initialPath ?? saved?.activePath ?? paths[0] ?? null;
    const order = preferred ? [preferred, ...paths.filter((path) => path !== preferred)] : paths;
    const failures: string[] = [];
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- temporary startup ordering, never rendered
    const positions = new Map<string, number>();
    try {
      for (const path of order) {
        if (!await this.open(path, { activate: this.tabs.length === 0, restoring: true })) failures.push(path);
        else {
          // repo_open also resolves aliases; order by the canonical path it returned.
          const canonical = this.#lastOpenedPath;
          if (canonical) positions.set(canonical, Math.min(positions.get(canonical) ?? paths.length, paths.indexOf(path)));
        }
      }
      // Opening the active tab first must not change the saved visual order.
      this.tabs = [...this.tabs].sort((a, b) => (positions.get(a.info!.workdir) ?? paths.length) - (positions.get(b.info!.workdir) ?? paths.length));
      this.openError = null;
    } finally {
      this.restoring = false;
      this.persist();
    }
    if (failures.length) toast.info(t('tabs.restoreFailed', { paths: failures.join('\n') }));
  }

  /** Test teardown: discard every session, including inactive timers. */
  reset(): void {
    for (const owner of new Set([...this.tabs, activeSession.current])) {
      owner.end();
      for (const store of owner.stores.values()) {
        const reset = (store as { reset?: () => void }).reset;
        reset?.call(store);
      }
    }
    this.tabs = [];
    activeSession.current = new Session();
    this.openError = null;
    this.opening = false;
    this.attempted = false;
    this.restoring = false;
    this.recents = [];
  }
}

export const repo = new RepoStore();
export const repoFor = (owner: Session): RepoView => new RepoView(owner);
