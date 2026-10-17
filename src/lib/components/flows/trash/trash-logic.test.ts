// Pure logic of the discarded files: names, size and meta line of an entry, and the toast texts.
import { describe, expect, it } from 'vitest';
import type { DiscardedFile } from '$lib/ipc/types';
import { announcementText, entryMeta, formatSize, restoreMessage, splitPath } from './trash-logic';

const NOW = 1_800_000_000_000;
const entry = (over: Partial<DiscardedFile> = {}): DiscardedFile => ({
  id: 'a1', path: 'src/lib/a.ts', oid: 'a'.repeat(40), kind: 'file', size: 1536, time: NOW / 1000 - 120, source: 'discard', ...over,
});

describe('splitPath', () => {
  it('separates the folder from the file name', () => {
    expect(splitPath('src/lib/a.ts')).toEqual({ dir: 'src/lib', name: 'a.ts' });
    expect(splitPath('README.md')).toEqual({ dir: '', name: 'README.md' });
    expect(splitPath('dir avec espace/é.txt')).toEqual({ dir: 'dir avec espace', name: 'é.txt' });
  });
});

describe('formatSize', () => {
  it('counts bytes under a KiB, then scales', () => {
    expect(formatSize(0)).toBe('0 B');
    expect(formatSize(1023)).toBe('1023 B');
    expect(formatSize(1536)).toBe('1.5 KiB');
    expect(formatSize(6 * 1024 * 1024)).toBe('6.0 MiB');
  });
});

describe('entryMeta', () => {
  it('reads source, size and age, and names a kind that is not a plain file', () => {
    expect(entryMeta(entry(), NOW)).toBe('Discarded · 1.5 KiB · 2 minutes ago');
    expect(entryMeta(entry({ source: 'discard-hunk' }), NOW)).toBe('Changes discarded · 1.5 KiB · 2 minutes ago');
    expect(entryMeta(entry({ source: 'resolve', kind: 'executable', size: 10 }), NOW)).toBe('Replaced while resolving · executable · 10 B · 2 minutes ago');
    expect(entryMeta(entry({ source: 'restore', kind: 'symlink', size: 5 }), NOW)).toBe('Replaced by a restore · link · 5 B · 2 minutes ago');
  });
});

describe('restoreMessage', () => {
  it('names a single file, says when it replaced something, and counts several', () => {
    expect(restoreMessage({ restored: ['a.txt'], replaced: [] })).toBe('Restored a.txt.');
    expect(restoreMessage({ restored: ['a.txt'], replaced: ['a.txt'] })).toBe('Restored a.txt. The version it replaced is in the list.');
    expect(restoreMessage({ restored: ['a.txt', 'b.txt'], replaced: [] })).toBe('Restored 2 files.');
    expect(restoreMessage({ restored: [], replaced: [] })).toBe('Restored 0 files.');
  });
});

describe('announcementText', () => {
  it('counts files, names a hunk, and says "all" when the count is not known', () => {
    expect(announcementText({ kind: 'files', count: 1 })).toBe('Discarded 1 file.');
    expect(announcementText({ kind: 'files', count: 3 })).toBe('Discarded 3 files.');
    expect(announcementText({ kind: 'all' })).toBe('Discarded all changes.');
    expect(announcementText({ kind: 'hunk', path: 'src/a.ts' })).toBe('Discarded changes in src/a.ts.');
  });
});
