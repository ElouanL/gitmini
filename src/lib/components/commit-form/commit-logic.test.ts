import { describe, expect, it } from 'vitest';
import { buildMessage, canSubmit, counterLevel, disabledReason, formMode, formVisible, headIsPushed, joinMessage, mergeSummary, splitMessage, stagedCount, summaryLength, type SubmitInputs } from './commit-logic';

const base: SubmitInputs = { mode: 'commit', summary: 'feat: x', stagedCount: 1, conflictCount: 0, busy: false };

describe("summary counter", () => {
  it('gris ≤ 50, orange 51–72, rouge > 72', () => {
    expect(counterLevel(0)).toBe('ok');
    expect(counterLevel(50)).toBe('ok');
    expect(counterLevel(51)).toBe('warn');
    expect(counterLevel(72)).toBe('warn');
    expect(counterLevel(73)).toBe('danger');
  });
  it("count characters, not UTF-16 units", () => {
    expect(summaryLength('é😀')).toBe(2);
  });
});

describe("button activation (STAGE-06)", () => {
  it("commit: Unempty summary AND at least one staged file", () => {
    expect(canSubmit(base)).toBe(true);
    expect(canSubmit({ ...base, summary: '' })).toBe(false);
    expect(canSubmit({ ...base, summary: '   \n ' })).toBe(false);
    expect(canSubmit({ ...base, stagedCount: 0 })).toBe(false);
  });
  it("amend: allowed without file staged (message only) but not without summary", () => {
    expect(canSubmit({ ...base, mode: 'amend', stagedCount: 0 })).toBe(true);
    expect(canSubmit({ ...base, mode: 'amend', summary: '' })).toBe(false);
  });
  it("merge : deactivated as long as conflicts remain", () => {
    expect(canSubmit({ ...base, mode: 'merge', stagedCount: 0, conflictCount: 2 })).toBe(false);
    expect(canSubmit({ ...base, mode: 'merge', stagedCount: 0, conflictCount: 0 })).toBe(true);
  });
  it("deactivated during flight writing", () => {
    expect(canSubmit({ ...base, busy: true })).toBe(false);
    expect(disabledReason({ ...base, busy: true })).toBe('busy');
  });
  it("reason for deactivation", () => {
    expect(disabledReason(base)).toBeNull();
    expect(disabledReason({ ...base, summary: '' })).toBe('summary');
    expect(disabledReason({ ...base, stagedCount: 0 })).toBe('nothing-staged');
    expect(disabledReason({ ...base, mode: 'merge', conflictCount: 1 })).toBe('conflicts');
  });
});

describe("visibility and mode", () => {
  it("masked during rebase, cherry-pick, revert, am", () => {
    expect(formVisible(null)).toBe(true);
    expect(formVisible({ kind: 'merge' })).toBe(true);
    for (const kind of ['rebase', 'cherry-pick', 'revert', 'am'] as const) expect(formVisible({ kind })).toBe(false);
  });
  it('data-mode', () => {
    expect(formMode(null, false)).toBe('commit');
    expect(formMode(null, true)).toBe('amend');
    expect(formMode({ kind: 'merge' }, true)).toBe('merge');
  });
});

describe('messages', () => {
  it("summary + description: body omitted if empty", () => {
    expect(buildMessage('  feat: test ', '')).toEqual({ summary: 'feat: test' });
    expect(buildMessage('feat: test', '  \n')).toEqual({ summary: 'feat: test' });
    expect(buildMessage('feat: test', 'body')).toEqual({ summary: 'feat: test', body: 'body' });
    expect(joinMessage('feat: test', 'body')).toBe('feat: test\n\nbody');
    expect(joinMessage('a', '')).toBe('a');
  });

  it("cut the message from HEAD for pre-filling of amend", () => {
    expect(splitMessage("feat: x\n\nbody on\ntwo lines\n")).toEqual({ summary: 'feat: x', body: "body on\ntwo lines" });
    expect(splitMessage('feat: x\n')).toEqual({ summary: 'feat: x', body: '' });
    expect(splitMessage('feat: x')).toEqual({ summary: 'feat: x', body: '' });
    expect(splitMessage('a\r\n\r\nb\r\n')).toEqual({ summary: 'a', body: 'b' });
  });

  it("proposed merge summary", () => {
    expect(mergeSummary('feature')).toBe("Merge branch 'feature'");
    expect(mergeSummary('refs/heads/feature')).toBe("Merge branch 'feature'");
    expect(mergeSummary('a'.repeat(40))).toBe(`Merge commit '${'a'.repeat(40)}'`);
    expect(mergeSummary(null)).toBe('Merge');
  });
});

describe("warning \"commit already pushed\" (STAGE-04)", () => {
  it("upstream and ahead = 0, or unknown", () => {
    expect(headIsPushed({ upstream: 'origin/main', ahead: 0 })).toBe(true);
    expect(headIsPushed({ upstream: 'origin/main', ahead: null })).toBe(true);
  });
  it("no d", () => {
    expect(headIsPushed({ upstream: null, ahead: null })).toBe(false);
    expect(headIsPushed({ upstream: 'origin/main', ahead: 2 })).toBe(false);
    expect(headIsPushed(null)).toBe(false);
  });
});

describe("files staged", () => {
  it("ignores conflicts and non-staged", () => {
    expect(stagedCount([{ staged: 'added' }, { staged: null }, { staged: 'modified', conflict: 'both-modified' }, { staged: 'deleted', conflict: null }])).toBe(2);
  });
});
