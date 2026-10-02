// Two selected commits (03 "Right Panel") : comparison is always made from the old to the recent, in order
// the graph (smallest row = the most recent). Pure.
export interface Pair {
  newer: string;
  older: string;
}

/**
 * @param rowOf rank of commits in graph (`null` if unknown). An unknown rank keeps order of selection (the 2nd commit
 * selected is assumed to be the most recent).
 */
export function orderPair(a: string, b: string, rowOf: (oid: string) => number | null): Pair {
  const ra = rowOf(a);
  const rb = rowOf(b);
  if (ra !== null && rb !== null) return ra <= rb ? { newer: a, older: b } : { newer: b, older: a };
  return { newer: b, older: a };
}
