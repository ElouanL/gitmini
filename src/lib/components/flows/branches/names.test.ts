import { describe, expect, it } from 'vitest';
import { backendReasonMessage, normalizeBranchInput, problemMessage, suggestLocalName, validateBranchName } from './names';

describe("validateBranchName (06 \"Validation of Names\")", () => {
  it("accept common names", () => {
    for (const ok of ['topic', 'feature/login', 'fix-123', 'release/1.2.3', 'a.b', 'é/ü', 'v1.0-rc1', 'a@b']) {
      expect(validateBranchName(ok), ok).toBeNull();
    }
  });

  it.each([
    ['', 'empty'],
    ['HEAD', 'head'],
    ['@', 'lone-at'],
    ['-x', 'leading-dash'],
    ['/x', 'leading-slash'],
    ['x/', 'trailing-slash'],
    ['a//b', 'double-slash'],
    ['a..b', 'double-dot'],
    ['a\u0001b', 'control-char'],
    ['a\u007fb', 'control-char'],
    ['a@{b', 'at-brace'],
    ['a.', 'trailing-dot'],
    ['.a', 'component-dot'],
    ['a/.b', 'component-dot'],
    ['a.lock', 'lock-suffix'],
    ['a.lock/b', 'lock-suffix'],
  ])('refuse %j (%s)', (name, reason) => {
    expect(validateBranchName(name)?.reason).toBe(reason);
  });

  it.each(['~', '^', ':', '?', '*', '[', '\\', ' '])("refuses character %j", (ch) => {
    const p = validateBranchName(`a${ch}b`);
    expect(p?.reason).toBe('forbidden-char');
    expect(p?.char).toBe(ch);
  });

  it("an empty name does not show any message", () => {
    expect(problemMessage({ reason: 'empty' })).toBeNull();
    expect(problemMessage({ reason: 'double-dot' })).toBe("Invalid branch name: cannot contain \"..\".");
    expect(problemMessage({ reason: 'forbidden-char', char: '~' })).toBe("Invalid branch name: \"~\" is prohibited.");
  });
});

describe("Standardization of Seizure", () => {
  it("converts spaces to dashes", () => {
    expect(normalizeBranchInput("my new branch")).toBe("my-new-branch");
    expect(normalizeBranchInput('a\tb')).toBe('a-b');
    expect(normalizeBranchInput("already-ok")).toBe("already-ok");
  });

  it("offers a local name for a remote branch in collision", () => {
    expect(suggestLocalName('origin/feature')).toBe('origin-feature');
    expect(suggestLocalName('origin/feature/x')).toBe('origin-feature-x');
  });

  it("backend message: known reason translated, unknown displayed as", () => {
    expect(backendReasonMessage('double-dot')).toContain("\"..\"");
    expect(backendReasonMessage('weird thing')).toBe("Invalid branch name: weird thing.");
    expect(backendReasonMessage(undefined)).toBe("Invalid branch name: ?.");
  });
});
