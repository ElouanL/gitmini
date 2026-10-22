// RW-01 — "Edit message..." of a commit of the current branch, in the `?mock=1` demo mode (no repository, bridge or git: the
// in-memory transport of src/lib/mock/transport.ts runs the interactive rebase as a reword of the target only). The context menu
// and the button next to the commit title open `reword-dialog`, pre-filled with the subject and the description; Save stays
// disabled while nothing changed; saving shows the new subject in the graph and keeps the commit selected, and the undo toast puts
// the old message back. (The mock keeps the oids, so the details panel, which caches by oid, is not asserted on the new text: a real
// reword gives new oids.) The `mock` fixture fails the test if the page logged an error or a warning.
import { expect, mockTest as test } from '../support/mock-app';

const oid = (n: number): string => n.toString(16).padStart(40, '0');

test.describe('RW-01 — Edit the message of a commit (mock)', () => {
  test('RW-01 — menu and details button open the dialog; save rewords the commit; undo restores it', async ({ mock }) => {
    await mock.open();
    const target = oid(59);
    const original = 'feat: command palette'; // the subject of commit 59 in the demo log
    await expect(mock.byTid('graph-row', { oid: target })).toContainText(original);

    // 1. The context menu of a commit of `main` offers "Edit message..."; a cancelled dialog changes nothing.
    await mock.rightClick('graph-row', { oid: target });
    await expect(mock.byTid('context-menu-item-reword')).toHaveText('Edit message...');
    await mock.click('context-menu-item-reword');
    await expect(mock.byTid('reword-dialog')).toBeVisible();
    await expect(mock.byTid('reword-commit')).toHaveAttribute('data-oid', target);
    const summary = mock.byTid('reword-summary-input');
    await expect(summary).not.toHaveValue('');
    await expect(summary).toBeFocused();
    await expect(mock.byTid('reword-confirm-btn')).toBeDisabled(); // unchanged
    await expect(mock.byTid('reword-rewrite-note')).toHaveText('1 later commit will be rewritten as well.');
    await mock.click('reword-cancel-btn');
    await mock.waitGone('reword-dialog');

    // 2. The button next to the title of the selected commit opens the same dialog; saving rewords the commit.
    await mock.click('graph-row', { oid: target });
    await expect(mock.byTid('commit-details-panel')).toHaveAttribute('data-oid', target);
    await mock.click('commit-details-reword-btn');
    await expect(mock.byTid('reword-dialog')).toBeVisible();
    await mock.type('reword-summary-input', 'docs: explain the reword flow');
    await mock.type('reword-description-input', 'Edited from the graph.');
    await expect(mock.byTid('reword-confirm-btn')).toBeEnabled();
    await mock.click('reword-confirm-btn');
    await mock.waitGone('reword-dialog');

    const undo = mock.toast('undo', 'Commit message updated');
    await expect(undo).toBeVisible();
    await expect(mock.byTid('graph-row', { oid: target })).toContainText('docs: explain the reword flow');
    await expect(mock.byTid('commit-details-panel')).toHaveAttribute('data-oid', target);

    // 3. Undo puts the previous message back.
    await undo.getByTestId('toast-undo-btn').click();
    await expect(mock.byTid('graph-row', { oid: target })).toContainText(original);
    await expect(mock.byTid('graph-row', { oid: target })).not.toContainText('docs: explain the reword flow');
  });
});
