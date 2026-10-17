// Pure logic of the tags flow.
import { describe, expect, it } from 'vitest';
import { conflictMessage, existsErrorMessage, normalizeTagInput, planTagPush, tagConflict, tagProblemMessage, validateTagName } from './tag-logic';

describe('tag names', () => {
  it('accept the usual release names and refuse what git refuses, with a message', () => {
    for (const ok of ['v1.0.0', 'release/2.1', 'v1.0-rc.1', 'build_42']) expect(validateTagName(ok), ok).toBeNull();
    const msg = (name: string) => {
      const p = validateTagName(name);
      return p ? tagProblemMessage(p) : null;
    };
    expect(msg('')).toBeNull(); // an empty name only disables the button
    expect(msg('-x')).toBe('Invalid tag name: can\'t start with "-".');
    expect(msg('HEAD')).toBe('Invalid tag name: HEAD is reserved.');
    expect(msg('a..b')).toBe('Invalid tag name: cannot contain "..".');
    expect(msg('a:b')).toBe('Invalid tag name: ":" is prohibited.');
    expect(msg('v1.')).toBe('Invalid tag name: cannot end with ".".');
  });

  it('typed spaces become dashes', () => {
    expect(normalizeTagInput('release candidate 1')).toBe('release-candidate-1');
  });
});

describe('tagConflict', () => {
  const tags = [{ name: 'v1.0' }, { name: 'rel/1' }];
  it('finds the name itself, a tag that would be its folder, and a tag it would be the folder of', () => {
    expect(tagConflict('v2.0', tags)).toBeNull();
    expect(tagConflict('v1.0', tags)).toEqual({ kind: 'exists' });
    expect(tagConflict('v1.0/rc', tags)).toEqual({ kind: 'blocked', blockedBy: 'v1.0' });
    expect(tagConflict('rel', tags)).toEqual({ kind: 'blocked', blockedBy: 'rel/1' });
    expect(tagConflict('v1', tags)).toBeNull(); // a prefix without the slash is another name
  });

  it('words the conflict, and the backend refusal the same way', () => {
    expect(conflictMessage('v1.0', { kind: 'exists' })).toBe('A tag named "v1.0" already exists.');
    expect(conflictMessage('v1.0/rc', { kind: 'blocked', blockedBy: 'v1.0' })).toBe('The "v1.0" tag already exists and blocks "v1.0/rc".');
    expect(existsErrorMessage('v1.0', { what: 'tag' })).toBe('A tag named "v1.0" already exists.');
    expect(existsErrorMessage('v1.0/rc', { what: 'tag', blockedBy: 'v1.0' })).toBe('The "v1.0" tag already exists and blocks "v1.0/rc".');
    expect(existsErrorMessage('v1.0', null)).toBe('A tag named "v1.0" already exists.');
  });
});

describe('planTagPush', () => {
  it('goes nowhere without remote, straight to the only one, and lets the user choose among several (origin first)', () => {
    expect(planTagPush([])).toEqual({ kind: 'none' });
    expect(planTagPush([{ name: 'fork' }])).toEqual({ kind: 'single', remote: 'fork' });
    expect(planTagPush([{ name: 'fork' }, { name: 'origin' }])).toEqual({ kind: 'choose', remote: 'origin' });
    expect(planTagPush([{ name: 'fork' }, { name: 'upstream' }])).toEqual({ kind: 'choose', remote: 'fork' });
  });
});
