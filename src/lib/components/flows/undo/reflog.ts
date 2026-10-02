// Refrog Line Wording: `HEAD@{3}`, `feature@{0}`.
export function reflogRefLabel(ref: string, index: number): string {
  return `${ref}@{${index}}`;
}
