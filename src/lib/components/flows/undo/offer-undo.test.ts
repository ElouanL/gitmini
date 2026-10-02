import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import ToastContainer from '$lib/components/toast/ToastContainer.svelte';
import { whenIdle } from '$lib/activity';
import { session } from '$lib/stores/session.svelte';
import { createFakeTransport } from '$lib/test/fake-transport';
import { makeUndo, oid } from '$lib/test/fixtures';
import { resetAll } from '$lib/test/reset';
import type { UndoStatus } from '$lib/ipc/types';
import { offerUndo, undoOffer } from './offer-undo';

beforeEach(() => {
  resetAll({ keepRegistrations: true });
  session.begin(1);
});
afterEach(() => resetAll({ keepRegistrations: true }));

const unavailable: UndoStatus = { entry: null, available: false, reason: 'empty', head: oid(1) };

describe("undoOffer (pure decision)", () => {
  it("no entry or unavailable: nothing to offer", () => {
    expect(undoOffer(null)).toBeNull();
    expect(undoOffer(unavailable)).toBeNull();
    expect(undoOffer({ ...makeUndo(), available: false, reason: 'pushed' })).toBeNull();
  });
  it("proposes the input and the captured HEAD", () => {
    const s = makeUndo();
    expect(undoOffer(s)).toEqual({ entry: s.entry, head: s.head });
  });
  it("Expected Kind Filter (a Kind or List)", () => {
    const s = makeUndo(); // kind = commit
    expect(undoOffer(s, 'commit')).not.toBeNull();
    expect(undoOffer(s, ['merge', 'commit'])).not.toBeNull();
    expect(undoOffer(s, 'rebase')).toBeNull();
    expect(undoOffer(s, ['cherry-pick', 'revert'])).toBeNull();
  });
});

describe('offerUndo', () => {
  it("toast[data-kind=undo] + toast-undo-btn: undo_last with captured inputId and HEAD, without dialogue", async () => {
    const fake = createFakeTransport({
      undo_peek: () => makeUndo(),
      undo_last: () => ({ head: { branch: 'main', oid: oid(59), detached: false, unborn: false } }),
    }).install();
    render(ToastContainer);
    await offerUndo("Commit created", 'commit');
    const toast = await screen.findByTestId('toast');
    expect(toast).toHaveAttribute('data-kind', 'undo');
    expect(toast).toHaveTextContent("Commit created");
    await userEvent.click(screen.getByTestId('toast-undo-btn'));
    await whenIdle();
    expect(fake.callsOf('undo_last')).toHaveLength(1);
    expect(fake.callsOf('undo_last')[0]!.args).toEqual({ repoId: 1, entryId: 'undo-1', expectedHead: oid(60) });
    // The button disappears: you can't cancel twice.
    expect(screen.queryByTestId('toast-undo-btn')).toBeNull();
  });

  it("input from another kind: simple toast of success, no button", async () => {
    createFakeTransport({ undo_peek: () => makeUndo() }).install();
    render(ToastContainer);
    await offerUndo("Rebase completed", 'rebase');
    expect(await screen.findByTestId('toast')).toHaveAttribute('data-kind', 'success');
    expect(screen.queryByTestId('toast-undo-btn')).toBeNull();
  });

  it("undo unavailable: simple toast of success", async () => {
    createFakeTransport({ undo_peek: () => unavailable }).install();
    render(ToastContainer);
    await offerUndo("Branch deleted");
    expect(await screen.findByTestId('toast')).toHaveAttribute('data-kind', 'success');
    expect(screen.queryByTestId('toast-undo-btn')).toBeNull();
  });
});
