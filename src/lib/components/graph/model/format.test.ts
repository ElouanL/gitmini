import { describe, expect, it } from 'vitest';
import { avatarColor, formatGraphDate, hash32, initials } from './format';

describe("text columns", () => {
  it("relative date within 7 days, absolute beyond", () => {
    const now = Date.UTC(2026, 9, 2, 12, 0, 0);
    expect(formatGraphDate(now / 1000 - 3 * 3600, now)).toMatch(/3 h/);
    const old = new Date(2026, 8, 1, 9, 5).getTime() / 1000;
    expect(formatGraphDate(old, now)).toBe('2026-09-01 09:05');
  });

  it("initials: first letter of the first two words", () => {
    expect(initials('Alice Martin')).toBe('AM');
    expect(initials('alice')).toBe('A');
    expect(initials('  jean-pierre  dupont ')).toBe('JD');
    expect(initials("Élodie Éluard")).toBe('ÉÉ');
    expect(initials('')).toBe('?');
  });

  it("tablet: color 0.7 stable, insensitive to the case of enamel", () => {
    const c = avatarColor('Alice@Example.org');
    expect(c).toBeGreaterThanOrEqual(0);
    expect(c).toBeLessThan(8);
    expect(avatarColor('alice@example.org')).toBe(c);
    expect(hash32('a')).toBe(hash32('a'));
    const distinct = new Set(['a@x', 'b@x', 'c@x', 'd@x', 'e@x', 'f@x', 'g@x', 'h@x'].map(avatarColor));
    expect(distinct.size).toBeGreaterThan(2);
  });
});
