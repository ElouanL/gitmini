// `commit-form` (05): button activation, amend, "already pushed" warning, hook that refuses, identity, merge.
import { screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { whenIdle } from '$lib/activity';
import { graph } from '$lib/stores/graph.svelte';
import { op } from '$lib/stores/op.svelte';
import { repo } from '$lib/stores/repo.svelte';
import { status } from '$lib/stores/status.svelte';
import { toast } from '$lib/stores/toast.svelte';
import { oid } from '$lib/test/fixtures';
import '$lib/register-core';
import '../../dialogs-base/register';
import '../../wt/register';
import WtPanel from '../../wt/WtPanel.svelte';
import { file, mountWithDialogs, opState, setup, snapshot } from '../../wt/__tests__/helpers';
import { commitForm } from '../form-state.svelte';
import type { FakeTransport } from '$lib/test/fake-transport';

let fake: FakeTransport;
const tid = (id: string) => screen.getByTestId(id);
const stagedFile = (p = 'staged.txt') => file(p, { staged: 'added' });
const COMMIT_RESULT = { oid: oid(99), status: snapshot([]) };

async function type(id: string, text: string) {
  const el = tid(id);
  await userEvent.clear(el);
  if (text) await userEvent.type(el, text);
}

beforeEach(() => {
  fake = setup();
});

describe("button activation (STAGE-06)", () => {
  it("disabled without summary or without staged file; active with both; worded \"Commit N files\"", async () => {
    setup({}, [file('mod.txt', { unstaged: 'modified' })]);
    mountWithDialogs(WtPanel);
    expect(tid('commit-submit-btn')).toBeDisabled();
    await type('commit-summary-input', 'feat: x');
    expect(tid('commit-submit-btn')).toBeDisabled(); // nothing from staged

    status.apply(snapshot([stagedFile('a'), stagedFile('b')]));
    await waitFor(() => expect(tid('commit-submit-btn')).toBeEnabled());
    expect(tid('commit-submit-btn')).toHaveTextContent("Commit 2 files");
    await type('commit-summary-input', '   ');
    expect(tid('commit-submit-btn')).toBeDisabled(); // empty summary after trim
  });

  it('compteur : gris ≤ 50, orange 51–72, rouge > 72', async () => {
    mountWithDialogs(WtPanel);
    for (const [n, level] of [[50, 'ok'], [51, 'warn'], [72, 'warn'], [73, 'danger']] as const) {
      commitForm.summary = 'x'.repeat(n);
      await waitFor(() => expect(tid('commit-summary-count')).toHaveAttribute('data-level', level));
      expect(tid('commit-summary-count')).toHaveTextContent(String(n));
    }
  });

  it("actual author; \"Identity not configured\" if null", async () => {
    mountWithDialogs(WtPanel);
    expect(tid('commit-author')).toHaveTextContent("Author: Demo <demo@example.org> (global)");
    repo.info = { ...repo.info!, identity: null };
    await waitFor(() => expect(tid('commit-author')).toHaveTextContent("Identity not configured"));
  });
});

describe('commit (STAGE-03)', () => {
  it("commit_create { summary, body, amend:false }; answer updates status; empty fields; commit is selected", async () => {
    fake = setup({ commit_create: () => COMMIT_RESULT }, [stagedFile()]);
    mountWithDialogs(WtPanel);
    await type('commit-summary-input', 'feat: test');
    await userEvent.type(tid('commit-body-input'), 'body');
    await userEvent.click(tid('commit-submit-btn'));
    await whenIdle();
    expect(fake.callsOf('commit_create')[0]!.args).toEqual({ repoId: 1, summary: 'feat: test', body: 'body', amend: false });
    expect(status.snapshot?.files).toEqual([]);
    expect(graph.selection).toMatchObject({ kind: 'commits', oids: [oid(99)] });
    expect(commitForm.summary).toBe('');
    expect(commitForm.body).toBe('');
  });

  it("without description: body omitted", async () => {
    fake = setup({ commit_create: () => COMMIT_RESULT }, [stagedFile()]);
    mountWithDialogs(WtPanel);
    await type('commit-summary-input', 'fix: y');
    await userEvent.click(tid('commit-submit-btn'));
    await whenIdle();
    expect(fake.callsOf('commit_create')[0]!.args).toEqual({ repoId: 1, summary: 'fix: y', amend: false });
  });

  it("Mod+Enter commit", async () => {
    fake = setup({ commit_create: () => COMMIT_RESULT }, [stagedFile()]);
    mountWithDialogs(WtPanel);
    await type('commit-summary-input', 'feat: kbd');
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    await whenIdle();
    expect(fake.callsOf('commit_create')).toHaveLength(1);
  });

  it("the draft is retained by repository when the panel is dismantled and reassembled", async () => {
    mountWithDialogs(WtPanel);
    await type('commit-summary-input', 'draft');
    screen.getByTestId('wt-panel').remove();
    // The form reads the status of the module: a new montage finds the text.
    expect(commitForm.summary).toBe('draft');
  });
});

describe('amend (STAGE-04)', () => {
  const head = (over = {}) => ({ branch: 'main', oid: oid(60), detached: false, unborn: false, ...over });

  it("pre-filled check from commit_details { oid: HEAD }; warning if already pushed; uncheck restores draft", async () => {
    fake = setup({ commit_details: () => ({ message: 'feat: ancien\n\nold body\n' }) }, [], { upstream: 'origin/main', ahead: 0, behind: 0, head: head() });
    mountWithDialogs(WtPanel);
    expect(screen.queryByTestId('commit-amend-pushed-warning')).toBeNull();
    await userEvent.click(tid('commit-amend-toggle'));
    await waitFor(() => expect(tid('commit-summary-input')).toHaveValue('feat: ancien'));
    expect(fake.callsOf('commit_details')[0]!.args).toEqual({ repoId: 1, oid: repo.head!.oid });
    expect(tid('commit-body-input')).toHaveValue('old body');
    expect(tid('commit-form')).toHaveAttribute('data-mode', 'amend');
    expect(tid('commit-amend-pushed-warning')).toHaveTextContent("This commit is already on origin/main");
    expect(tid('commit-submit-btn')).toHaveTextContent("Amend");
    expect(tid('commit-submit-btn')).toBeEnabled(); // message alone: no staged file required

    await userEvent.click(tid('commit-amend-toggle'));
    await waitFor(() => expect(tid('commit-summary-input')).toHaveValue(''));
    expect(screen.queryByTestId('commit-amend-pushed-warning')).toBeNull();
  });

  it("no warning if local commits are in advance; does not replace a message already entered", async () => {
    fake = setup({ commit_details: () => ({ message: 'ancien' }) }, [], { upstream: 'origin/main', ahead: 2, behind: 0 });
    mountWithDialogs(WtPanel);
    await type('commit-summary-input', "already seized");
    await userEvent.click(tid('commit-amend-toggle'));
    expect(tid('commit-summary-input')).toHaveValue("already seized");
    expect(fake.callsOf('commit_details')).toHaveLength(0);
    expect(screen.queryByTestId('commit-amend-pushed-warning')).toBeNull();
  });

  it("amend: commit_create { amend: true }; checkbox is unchecked after success", async () => {
    fake = setup({ commit_details: () => ({ message: 'ancien' }), commit_create: () => COMMIT_RESULT });
    mountWithDialogs(WtPanel);
    await userEvent.click(tid('commit-amend-toggle'));
    await waitFor(() => expect(tid('commit-summary-input')).toHaveValue('ancien'));
    await type('commit-summary-input', 'nouveau');
    await userEvent.click(tid('commit-submit-btn'));
    await whenIdle();
    expect(fake.callsOf('commit_create')[0]!.args).toEqual({ repoId: 1, summary: 'nouveau', amend: true });
    expect(commitForm.amend).toBe(false);
  });

  it("disabled if HEAD is not born", () => {
    setup({}, [], { head: head({ unborn: true, oid: null }) });
    repo.info = { ...repo.info!, head: head({ unborn: true, oid: null }) };
    mountWithDialogs(WtPanel);
    expect(tid('commit-amend-toggle')).toBeDisabled();
  });
});

describe("hook that refuses (STAGE-07)", () => {
  it("GIT_FAILED : stderr in commit-hook-output, message stored, no toast", async () => {
    fake = setup({}, [stagedFile()]);
    fake.reject('commit_create', { code: 'GIT_FAILED', message: "git failed", details: { exitCode: 1, stderr: 'lint ko\n', args: [] } });
    mountWithDialogs(WtPanel);
    await type('commit-summary-input', "feel: refused");
    await userEvent.click(tid('commit-submit-btn'));
    await whenIdle();
    expect(tid('commit-hook-output')).toHaveTextContent('lint ko');
    expect(tid('commit-summary-input')).toHaveValue("feel: refused");
    expect(toast.items).toHaveLength(0);
    // The form remains usable: a second test erases the output.
    fake.on('commit_create', () => COMMIT_RESULT);
    await userEvent.click(tid('commit-submit-btn'));
    await whenIdle();
    expect(screen.queryByTestId('commit-hook-output')).toBeNull();
  });

  it("another GIT_FAILED (excluding commit) keeps the toast of the base", async () => {
    fake = setup({}, [file('a', { unstaged: 'modified' })]);
    fake.reject('stage_paths', { code: 'GIT_FAILED', message: "git failed", details: { exitCode: 1, stderr: 'boom' } });
    mountWithDialogs(WtPanel);
    await userEvent.click(tid('wt-stage-all-btn'));
    await whenIdle();
    expect(screen.queryByTestId('commit-hook-output')).toBeNull();
    expect(toast.items).toHaveLength(1);
  });
});

describe("missing identity (STAGE-09)", () => {
  it("IDENTITY_MISSING → identity-dialog → config_set_identity → commit renewed, commit-author updated", async () => {
    fake = setup(
      {
        commit_create: () => COMMIT_RESULT,
        config_set_identity: (a) => ({ name: a.name, email: a.email, scope: a.scope }),
      },
      [stagedFile()],
    );
    repo.info = { ...repo.info!, identity: null };
    fake.reject('commit_create', { code: 'IDENTITY_MISSING', message: "unknown identity", details: {} });
    mountWithDialogs(WtPanel);
    await type('commit-summary-input', 'feat: id');
    await userEvent.click(tid('commit-submit-btn'));
    const dlg = await screen.findByTestId('identity-dialog');
    expect(dlg).toBeInTheDocument();
    expect(tid('identity-scope-select')).toHaveValue("global"); // default `global`

    await userEvent.click(tid('identity-save-btn'));
    expect(tid('identity-name-error')).toBeInTheDocument(); // empty fields: nothing is sent
    expect(fake.callsOf('config_set_identity')).toHaveLength(0);

    await userEvent.type(tid('identity-name-input'), 'Ada');
    await userEvent.type(tid('identity-email-input'), 'ada@x.io');
    await userEvent.selectOptions(tid('identity-scope-select'), "local");
    await userEvent.click(tid('identity-save-btn'));
    await whenIdle();
    await waitFor(() => expect(fake.callsOf('commit_create')).toHaveLength(2));
    expect(fake.callsOf('config_set_identity')[0]!.args).toEqual({ repoId: 1, name: 'Ada', email: 'ada@x.io', scope: "local" });
    expect(fake.callsOf('commit_create')[1]!.args).toEqual(fake.callsOf('commit_create')[0]!.args);
    expect(screen.queryByTestId('identity-dialog')).toBeNull();
    expect(tid('commit-author')).toHaveTextContent('Ada <ada@x.io> (local)');
    expect(commitForm.summary).toBe(''); // the success of the recovery is treated as that of a first try
  });

  it("a click on commit-author opens the pre-filled dialog; the global scope does not send repoId", async () => {
    fake = setup({ config_set_identity: (a) => ({ name: a.name, email: a.email, scope: a.scope }) });
    mountWithDialogs(WtPanel);
    await userEvent.click(tid('commit-author'));
    expect(await screen.findByTestId('identity-name-input')).toHaveValue('Demo');
    expect(tid('identity-email-input')).toHaveValue('demo@example.org');
    await userEvent.clear(tid('identity-name-input'));
    await userEvent.type(tid('identity-name-input'), 'Grace');
    await userEvent.click(tid('identity-save-btn'));
    await whenIdle();
    expect(fake.callsOf('config_set_identity')[0]!.args).toEqual({ name: 'Grace', email: 'demo@example.org', scope: "global" });
    expect(tid('commit-author')).toHaveTextContent('Grace');
  });
});

describe("current and status operations", () => {
  it("merge : data-mode=merge, pre-filled summary, disabled as long as conflicts remain, « Finish the merge » → merge_continue", async () => {
    fake = setup({ merge_continue: () => ({ oid: oid(7) }) }, [file('c.txt', { conflict: 'both-modified' })]);
    op.setState(opState({ conflictedPaths: ['c.txt'] }));
    mountWithDialogs(WtPanel);
    expect(tid('commit-form')).toHaveAttribute('data-mode', 'merge');
    await waitFor(() => expect(tid('commit-summary-input')).toHaveValue("Merge branch 'feature'"));
    expect(screen.queryByTestId('commit-amend-toggle')).toBeNull();
    expect(tid('commit-submit-btn')).toHaveTextContent("Finish the merge");
    expect(tid('commit-submit-btn')).toBeDisabled();

    // No more conflict (stage_paths): button activates; message changed is merge_continue.
    status.apply(snapshot([file('c.txt', { staged: 'modified' })]));
    op.setState(opState({ conflictedPaths: [] }));
    await waitFor(() => expect(tid('commit-submit-btn')).toBeEnabled());
    await type('commit-summary-input', "Merge branch 'feature' (resolved)");
    await userEvent.click(tid('commit-submit-btn'));
    await whenIdle();
    expect(fake.callsOf('merge_continue')[0]!.args).toEqual({ repoId: 1, message: "Merge branch 'feature' (resolved)" });
  });

  it("merge_continue refused by a hook: output in commit-hook-output, no toast", async () => {
    fake = setup({});
    fake.reject('merge_continue', { code: 'GIT_FAILED', message: "git failed", details: { stderr: "commit-msg: refused" } });
    op.setState(opState({ conflictedPaths: [] }));
    mountWithDialogs(WtPanel);
    await waitFor(() => expect(tid('commit-summary-input')).toHaveValue("Merge branch 'feature'"));
    await userEvent.click(tid('commit-submit-btn'));
    await whenIdle();
    expect(tid('commit-hook-output')).toHaveTextContent("commit-msg: refused");
    expect(toast.items).toHaveLength(0);
  });

  it.each(['rebase', 'cherry-pick', 'revert', 'am'] as const)("masked for %s: continue with the banner", (kind) => {
    op.setState(opState({ kind, conflictedPaths: [] }));
    mountWithDialogs(WtPanel);
    expect(screen.queryByTestId('commit-form')).toBeNull();
  });
});
