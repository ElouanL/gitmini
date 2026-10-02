import { captureStores } from '$lib/stores/context';
import { scopedStore, type Session } from '$lib/stores/session.svelte';
// Status of the commit form (05 "Commit", "Amend") : draft retained in memory by repository as long as the app is
// open, pre-filled amend and merge, hook output. The component `CommitForm` only displays it.
import { commands } from '$lib/ipc/commands';
import type { CommitCreateResult } from '$lib/ipc/commands';
import { t } from '$i18n/index';
import { offerUndo } from '../flows/undo/offer-undo';
import { buildMessage, joinMessage, mergeSummary, splitMessage } from './commit-logic';

interface Draft {
  summary: string;
  body: string;
  amend: boolean;
  stash: { summary: string; body: string } | null;
  mergeSummary: string;
  mergeBody: string;
  mergeFor: string | null;
}

const fresh = (): Draft => ({ summary: '', body: '', amend: false, stash: null, mergeSummary: '', mergeBody: '', mergeFor: null });

export interface HookOutput {
  stderr: string;
  command: string;
}

export class CommitFormState {
  constructor(readonly owner: Session) {}
  summary = $state('');
  body = $state('');
  amend = $state(false);
  mergeSummary = $state('');
  mergeBody = $state('');
  /** `incoming` for which the summary of the merge has been pre-filled (do not overwrite a entry). */
  mergeFor = $state<string | null>(null);
  /** `GIT_FAILED` of a `commit_create` or a `merge_continue`: hook stderr, message stored, no toast. */
  hook = $state.raw<HookOutput | null>(null);
  loadingAmend = $state(false);

  #key = '';
  #stash: { summary: string; body: string } | null = null;
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- Draft archive is read only when activating a repository.
  #drafts = new Map<string, Draft>();
  #seq = 0;

  /** Includes archived drafts and the message temporarily hidden by amend. */
  get hasPendingDraft(): boolean {
    const hasText = (d: Draft): boolean => Boolean(d.summary || d.body || d.amend || d.mergeSummary
      || d.mergeBody || d.stash?.summary || d.stash?.body);
    return this.loadingAmend || hasText(this.#snapshot())
      || [...this.#drafts].some(([key, draft]) => key !== this.#key && hasText(draft));
  }

  /** Switch on the draft of the repository `key` (path to the repository); the old one is stored. */
  activate(key: string): void {
    if (key === this.#key) return;
    if (this.#key !== '') this.#drafts.set(this.#key, this.#snapshot());
    this.#key = key;
    this.#load(this.#drafts.get(key) ?? fresh());
    this.hook = null;
    this.#seq++;
  }

  #snapshot(): Draft {
    return {
      summary: this.summary,
      body: this.body,
      amend: this.amend,
      stash: this.#stash,
      mergeSummary: this.mergeSummary,
      mergeBody: this.mergeBody,
      mergeFor: this.mergeFor,
    };
  }

  #load(d: Draft): void {
    this.summary = d.summary;
    this.body = d.body;
    this.amend = d.amend;
    this.#stash = d.stash;
    this.mergeSummary = d.mergeSummary;
    this.mergeBody = d.mergeBody;
    this.mergeFor = d.mergeFor;
  }

  /** Check / uncheck the amend (05 "Amend"). Check pre-filled with the message from HEAD if the fields are empty; uncheck restores the draft. */
  async setAmend(on: boolean): Promise<void> {
    const { repo, reportError } = captureStores(this.owner);
    const seq = ++this.#seq;
    if (!on) {
      if (this.#stash) {
        this.summary = this.#stash.summary;
        this.body = this.#stash.body;
      }
      this.#stash = null;
      this.amend = false;
      this.loadingAmend = false;
      return;
    }
    const head = repo.head;
    const repoId = this.owner.repoId;
    if (repoId === null || !head || head.unborn || !head.oid) return;
    this.#stash = { summary: this.summary, body: this.body };
    this.amend = true;
    if (this.summary.trim() !== '' || this.body.trim() !== '') return;
    this.loadingAmend = true;
    try {
      const d = await commands.commitDetails({ repoId, oid: head.oid });
      // Unchecked entre-temps, or fields entered during loading: nothing is touched.
      if (this.owner.closed || seq !== this.#seq || !this.amend) return;
      if (this.summary.trim() !== '' || this.body.trim() !== '') return;
      const m = splitMessage(d.message);
      this.summary = m.summary;
      this.body = m.body;
    } catch (e) {
      if (this.owner.closed) return;
      if (seq === this.#seq) {
        this.amend = false;
        this.#stash = null;
      }
      reportError(e, { command: 'commit_details' });
    } finally {
      if (seq === this.#seq) this.loadingAmend = false;
    }
  }

  /** Merge in progress: pre-filled summary with `Merge branch '<incoming>'`, editable (05 "Commit"). */
  prefillMerge(incoming: string | null | undefined): void {
    const key = incoming ?? '';
    if (this.mergeFor === key) return;
    this.mergeFor = key;
    this.mergeSummary = mergeSummary(incoming);
    this.mergeBody = '';
  }

  resetMerge(): void {
    this.mergeFor = null;
    this.mergeSummary = '';
    this.mergeBody = '';
  }

  /** Message from `merge_continue` launched from `op-banner-continue-btn` (`registerMergeMessageProvider`). */
  mergeMessage(): string | null {
    const m = joinMessage(this.mergeSummary, this.mergeBody);
    return m === '' ? null : m;
  }

  showHook(stderr: string, command: string): void {
    this.hook = { stderr, command };
  }

  clearHook(): void {
    this.hook = null;
  }

  /** Empty fields after successful commit: summary, description, amend unchecked. */
  #committed(): void {
    this.summary = '';
    this.body = '';
    this.amend = false;
    this.#stash = null;
    this.hook = null;
    this.loadingAmend = false;
    this.#seq++;
  }

  /**
   * `commit_create`: the `{ oid, status }` answer updates the store `status` (never optimistic); the `repo:changed` that follows
   * refresh the graph, where the new commit is selected. The success processing is in the function passed to `runWrite`:
   * the restart after `identity-dialog` (`IDENTITY_MISSING`) also executes it.
   */
  async submit(): Promise<boolean> {
    const { graph, status, runWrite } = captureStores(this.owner);
    const repoId = this.owner.repoId;
    if (repoId === null) return false;
    const msg = buildMessage(this.summary, this.body);
    const amend = this.amend;
    this.hook = null;
    const res = await runWrite(
      t(amend ? 'commit.op.amend' : 'commit.op.commit'),
      async () => {
        const r: CommitCreateResult = await commands.commitCreate({ repoId, summary: msg.summary, ...(msg.body ? { body: msg.body } : {}), amend });
        status.apply(r.status);
        this.#committed();
        graph.selectCommit(r.oid);
        // Toast of cancellation (`toast-undo-btn`) instead of a success toast; re-read `undo_peek`, without holding the writing lock.
        void offerUndo(t(amend ? 'wt.amended' : 'wt.committed', { summary: msg.summary }), amend ? 'amend' : 'commit', this.owner);
        return r;
      },
      { command: 'commit_create' },
    );
    return res.ok;
  }

  reset(): void {
    this.#drafts.clear();
    this.#key = '';
    this.#stash = null;
    this.#load(fresh());
    this.hook = null;
    this.loadingAmend = false;
    this.#seq++;
  }
}

const binding = scopedStore('commitForm', (owner) => new CommitFormState(owner));
export const commitForm = binding.current;
export const commitFormFor = binding.for;
