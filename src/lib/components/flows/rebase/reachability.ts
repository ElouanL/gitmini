// "This commit is ancestor of HEAD?" from the only lines of the graph always loaded, without IPC: servers hide the
// impossible menu entries (07: "Unable entries are hidden") when the answer is certain.
// The answer is `unknown` and the input remains visible (the backend refuses properly).

export type Reach = 'yes' | 'no' | 'unknown';

export interface ParentsRow {
  parents: readonly string[];
}

export function reachableFromHead(headOid: string | null, oid: string, rows: ReadonlyMap<string, ParentsRow>): Reach {
  if (!headOid) return 'unknown';
  const seen = new Set<string>();
  const stack = [headOid];
  let incomplete = false;
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur === oid) return 'yes';
    if (seen.has(cur)) continue;
    seen.add(cur);
    const row = rows.get(cur);
    if (!row) {
      incomplete = true;
      continue;
    }
    for (const p of row.parents) if (!seen.has(p)) stack.push(p);
  }
  return incomplete ? 'unknown' : 'no';
}
