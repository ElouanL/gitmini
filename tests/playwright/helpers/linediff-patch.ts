// Pure helpers of the line-staging (STAGE-10) and diff-readability (DIFF-05) specs: what a unified patch says, so that the
// diff on screen can be compared with `git diff -U<n>` / `git show -U<n>`.

export interface ShownRow {
  kind: string;
  oldNo: number | null;
  newNo: number | null;
}

export interface Shown {
  rows: ShownRow[];
  /** Hunk header texts (`@@ -a,b +c,d @@ heading`). */
  headers: string[];
}

/** Lines of a unified patch as the diff viewer shows them: kind and old / new numbers, plus the hunk headers. File headers are skipped. */
export function parseUnified(patch: string): Shown {
  const rows: ShownRow[] = [];
  const headers: string[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const line of patch.split('\n')) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header) {
      headers.push(line);
      oldNo = Number(header[1]);
      newNo = Number(header[2]);
    } else if (headers.length === 0) continue;
    else if (line.startsWith('+')) rows.push({ kind: 'add', oldNo: null, newNo: newNo++ });
    else if (line.startsWith('-')) rows.push({ kind: 'del', oldNo: oldNo++, newNo: null });
    else if (line.startsWith(' ')) rows.push({ kind: 'ctx', oldNo: oldNo++, newNo: newNo++ });
  }
  return { rows, headers };
}

/** The added and removed lines of a patch (`-old`, `+new`), file headers excluded, in order: what a stage / unstage / discard changed. */
export function changedLines(patch: string): string[] {
  return patch.split('\n').filter((l) => /^[-+]/.test(l) && !/^(---|\+\+\+) /.test(l));
}

/** `line 1` .. `line <count>`, one per line, with `replacements` (1-based line number to new text) applied; ends with a newline. */
export function numberedFile(replacements: Record<number, string> = {}, count = 12): string {
  return Array.from({ length: count }, (_, i) => `${replacements[i + 1] ?? `line ${i + 1}`}\n`).join('');
}
