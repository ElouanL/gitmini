// Formatage d'affichage (dates relatives, SHA courts).
const rtf = typeof Intl !== 'undefined' ? new Intl.RelativeTimeFormat('en', { numeric: 'auto' }) : null;

export function shortOid(oid: string | null | undefined, n = 7): string {
  return oid ? oid.slice(0, n) : '';
}

/** "two hours ago", "hierday"... since a date in epoch seconds (UTC). */
export function formatRelative(epochSeconds: number, now: number = Date.now()): string {
  const diff = Math.round(epochSeconds - now / 1000);
  const abs = Math.abs(diff);
  if (!rtf) return new Date(epochSeconds * 1000).toLocaleString('en-US');
  if (abs < 45) return rtf.format(0, 'second');
  if (abs < 45 * 60) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 22 * 3600) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 26 * 86400) return rtf.format(Math.round(diff / 86400), 'day');
  if (abs < 320 * 86400) return rtf.format(Math.round(diff / (30 * 86400)), 'month');
  return rtf.format(Math.round(diff / (365 * 86400)), 'year');
}

export function formatDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}
