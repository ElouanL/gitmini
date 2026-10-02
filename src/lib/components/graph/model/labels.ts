// refs labels of a line (04 "refs Tags"): remote local grouping, sorting, overflowing "+n". Pure.
import type { RefLabel } from '$lib/ipc/types';

export interface PillPart {
  /** `RefLabel.fullRef` (`data-ref`). */
  ref: string;
  kind: RefLabel['kind'];
  /** Text displayed. */
  text: string;
  isHead: boolean;
  /** Target and source of drag and drop: local and remote branches only. */
  branch: boolean;
}

export interface Pill {
  /** 1 part, or 2 (local and then remote) for a merged label `main ⇅ origin`. */
  parts: PillPart[];
  merged: boolean;
  /** One of the parts is the current branch (or HEAD detached). */
  isHead: boolean;
}

export interface LabelLayout {
  /** Displayed labels (2 at most). */
  shown: Pill[];
  /** Number of masked labels (badge `+n`). */
  hidden: number;
  /** Complete list, one per line (ticket of badge). */
  tooltip: string;
}

export const MAX_SHOWN_PILLS = 2;

/** Name of the `<remote>/<name>` remote branch of a `refs/remotes/<remote>/<name>` ref. */
export function remoteShortName(fullRef: string): string {
  return fullRef.startsWith('refs/remotes/') ? fullRef.slice('refs/remotes/'.length) : fullRef;
}

function part(l: RefLabel, text = l.name): PillPart {
  return { ref: l.fullRef, kind: l.kind, text, isHead: l.isHead, branch: l.kind === "local" || l.kind === 'remote' };
}

/**
 * @param upstreamOf the short name of the upstream of a local branch (`origin/main`), if known; otherwise the remote name of the same branch
 * (`origin/<local>`) is used.
 */
export function layoutLabels(refs: readonly RefLabel[], upstreamOf: (local: string) => string | null = () => null): LabelLayout {
  // `origin/HEAD` is only a symbolic alias: it is not displayed.
  const visible = refs.filter((r) => !(r.kind === 'remote' && r.fullRef.endsWith('/HEAD')));
  const heads = visible.filter((r) => r.kind === 'head');
  const locals = visible.filter((r) => r.kind === "local").sort((a, b) => Number(b.isHead) - Number(a.isHead));
  const remotes = visible.filter((r) => r.kind === 'remote');
  const tags = visible.filter((r) => r.kind === 'tag');

  const pills: Pill[] = heads.map((h) => ({ parts: [part(h, "HEAD (detached)")], merged: false, isHead: true }));
  const used = new Set<RefLabel>();
  for (const l of locals) {
    const wanted = upstreamOf(l.name);
    const mate = remotes.find((r) => !used.has(r) && (wanted !== null ? r.name === wanted : r.name.endsWith(`/${l.name}`) && r.name.length > l.name.length + 1 && !r.name.slice(0, -(l.name.length + 1)).includes('/')));
    if (mate) {
      used.add(mate);
      const remoteName = mate.name.slice(0, mate.name.length - l.name.length - 1);
      pills.push({ parts: [part(l), part(mate, remoteName || mate.name)], merged: true, isHead: l.isHead });
    } else pills.push({ parts: [part(l)], merged: false, isHead: l.isHead });
  }
  for (const r of remotes) if (!used.has(r)) pills.push({ parts: [part(r)], merged: false, isHead: false });
  for (const t of tags) pills.push({ parts: [part(t)], merged: false, isHead: false });

  const label = (p: Pill) => (p.merged ? `${p.parts[0]!.text} ⇅ ${p.parts[1]!.text}` : p.parts[0]!.text);
  return {
    shown: pills.slice(0, MAX_SHOWN_PILLS),
    hidden: Math.max(0, pills.length - MAX_SHOWN_PILLS),
    tooltip: pills.map((p) => (p.isHead ? `HEAD → ${label(p)}` : label(p))).join('\n'),
  };
}
