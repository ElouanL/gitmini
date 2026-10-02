// Formatting of graph columns (04 "Columns"): relative/absolute date, initials and colour tablet. Pure.
import { formatRelative } from '$lib/format';

const WEEK = 7 * 86400;

const pad = (n: number): string => String(n).padStart(2, '0');

/** Author date: relative ("3 hours ago") within 7 days, otherwise `YYYY-MM-DD HH:mm` (local time). */
export function formatGraphDate(epochSeconds: number, nowMs: number = Date.now()): string {
  if (Math.abs(nowMs / 1000 - epochSeconds) < WEEK) return formatRelative(epochSeconds, nowMs);
  const d = new Date(epochSeconds * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** One or two initials (first letter of the first two words), in capital letters; `?` for an empty name. */
export function initials(name: string): string {
  const words = name.trim().split(/[\s._-]+/u).filter(Boolean);
  if (words.length === 0) return '?';
  const first = [...words[0]!][0] ?? '?';
  const second = words.length > 1 ? ([...words[words.length - 1]!][0] ?? '') : '';
  return (first + second).toUpperCase();
}

/** FNV-1a 32 bits. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Pastille color (0..7, lane palette) derived from the hash of the email, insensitive to the breakage. */
export function avatarColor(email: string): number {
  return hash32(email.trim().toLowerCase()) % 8;
}
