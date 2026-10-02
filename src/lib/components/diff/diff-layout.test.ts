import { describe, expect, it } from 'vitest';
import type { DiffLine, Hunk } from '$lib/ipc/types';
import { buildRows, displayLine, firstConflictLine, formatBytes, HEADER_HEIGHT, isConflictMarker, layoutDiff, LINE_HEIGHT, maxColumns, modeChange, MAX_LINE_CHARS } from './diff-layout';

function line(kind: DiffLine['kind'], text: string, oldNo: number | null, newNo: number | null): DiffLine {
  return { kind, text, oldNo, newNo };
}

function hunk(lines: DiffLine[], header = '@@ -1,3 +1,3 @@'): Hunk {
  return { header, oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines };
}

describe('displayLine', () => {
  it("remove the final \\r from a CRLF but report it", () => {
    expect(displayLine('line 2\r')).toEqual({ text: 'line 2', truncatedFrom: null, crlf: true });
    expect(displayLine('line 2')).toEqual({ text: 'line 2', truncatedFrom: null, crlf: false });
  });

  it("truncates beyond 2,000 characters and keeps the total", () => {
    const d = displayLine('x'.repeat(5000));
    expect(d.text).toHaveLength(MAX_LINE_CHARS);
    expect(d.truncatedFrom).toBe(5000);
  });

  it("do not cut a pair of substitutions", () => {
    const text = 'x'.repeat(MAX_LINE_CHARS - 1) + '😀' + 'y'.repeat(10);
    const d = displayLine(text);
    expect(d.text.endsWith('\uD83D')).toBe(false);
    expect(d.truncatedFrom).toBe(MAX_LINE_CHARS + 10);
  });

  it("a line of 2,000 characters stack is not truncated", () => {
    expect(displayLine('a'.repeat(MAX_LINE_CHARS)).truncatedFrom).toBeNull();
  });
});

describe('marqueurs de conflit', () => {
  it.each(['<<<<<<< HEAD', '<<<<<<<', '=======', '>>>>>>> feature', '||||||| base'])("%s is a marker", (s) => {
    expect(isConflictMarker(s)).toBe(true);
  });
  it.each(['a <<<<<<< b', '<<<<<<', '========', '=== x', "text", ''])("%s is not a", (s) => {
    expect(isConflictMarker(s)).toBe(false);
  });
});

describe("buildRows and layoutDiff", () => {
  const hunks = [
    hunk([line('ctx', 'a', 1, 1), line('del', 'b', 2, null), line('add', 'B', null, 2), line('noeol', '\\ No newline at end of file', null, null)]),
    hunk([line('ctx', 'z', 10, 10)], '@@ -10 +10 @@ fn'),
  ];

  it("flattened headers and lines, with numbers", () => {
    const rows = buildRows(hunks);
    expect(rows.map((r) => r.type)).toEqual(['hunk', 'line', 'line', 'line', 'line', 'hunk', 'line']);
    const del = rows[2]!;
    expect(del.type === 'line' && del.kind === 'del' && del.oldNo === 2 && del.newNo === null).toBe(true);
    expect(rows[5]).toMatchObject({ type: 'hunk', hunkIndex: 1, header: '@@ -10 +10 @@ fn' });
  });

  it("positions: 26 px per header, 20 px per line", () => {
    const l = layoutDiff({ hunks });
    expect(l.tops[0]).toBe(0);
    expect(l.tops[1]).toBe(HEADER_HEIGHT);
    expect(l.tops[2]).toBe(HEADER_HEIGHT + LINE_HEIGHT);
    expect(l.total).toBe(2 * HEADER_HEIGHT + 5 * LINE_HEIGHT);
    expect(l.hunkRows).toEqual([0, 5]);
    expect(l.virtual).toBe(false);
  });

  it("Virtualized from 2,000 lines", () => {
    const big = hunk(Array.from({ length: 2000 }, (_, i) => line('ctx', `l${i}`, i + 1, i + 1)));
    expect(layoutDiff({ hunks: [big] }).virtual).toBe(true);
    const small = hunk(Array.from({ length: 1990 }, (_, i) => line('ctx', `l${i}`, i + 1, i + 1)));
    expect(layoutDiff({ hunks: [small] }).virtual).toBe(false);
  });

  it("marks the markers only in the marketers view", () => {
    const h = hunk([line('ctx', '<<<<<<< HEAD', 1, 1), line('ctx', 'x', 2, 2), line('ctx', '=======', 3, 3)]);
    const on = buildRows([h], { markers: true }).filter((r) => r.type === 'line' && r.marker);
    expect(on).toHaveLength(2);
    expect(buildRows([h]).some((r) => r.type === 'line' && r.marker)).toBe(false);
  });

  it("CRLF: only text changes, line type remains backend type", () => {
    const rows = buildRows([hunk([line('add', "line 2 as amended\r", null, 2), line('ctx', 'line 3\r', 3, 3)])]);
    expect(rows[1]).toMatchObject({ kind: 'add', text: "line 2 as amended", crlf: true });
    expect(rows[2]).toMatchObject({ kind: 'ctx', text: 'line 3', crlf: true });
  });

  it("maxColumns counts tabs on 4 columns", () => {
    const rows = buildRows([hunk([line('ctx', '\t\tab', 1, 1), line('ctx', 'abcdefgh', 2, 2)])]);
    expect(maxColumns(rows)).toBe(10);
  });
});

describe('divers', () => {
  it("first marker line for open_external", () => {
    const h = hunk([line('ctx', 'a', 1, 1), line('ctx', 'b', 2, 2), line('ctx', '<<<<<<< HEAD', 3, 3)]);
    expect(firstConflictLine({ hunks: [h] })).toBe(3);
    expect(firstConflictLine({ hunks: [hunk([line('ctx', 'a', 1, 1)])] })).toBeNull();
  });

  it('changement de mode', () => {
    expect(modeChange({ oldMode: 0o100644, newMode: 0o100755 })).toBe('100644 → 100755');
    expect(modeChange({ oldMode: 0o100644, newMode: 0o100644 })).toBeNull();
    expect(modeChange({ oldMode: null, newMode: 0o100644 })).toBeNull();
  });

  it("size formatting", () => {
    expect(formatBytes(512)).toBe('512 o');
    expect(formatBytes(12_700)).toMatch(/^12\.4 KiB$/);
    expect(formatBytes(6 * 1024 * 1024)).toMatch(/^6.0 MiB$/);
  });
});
