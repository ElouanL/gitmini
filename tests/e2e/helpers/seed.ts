// Reproducible random order of spec files: `GITMINI_TEST_SEED` (number or text), displayed at launch.

/** 32-bit seed from `GITMINI_TEST_SEED`; valueless, from clock. */
export function resolveSeed(value: string | undefined = process.env.GITMINI_TEST_SEED): { seed: number; explicit: boolean } {
  if (value !== undefined && value.trim() !== '') {
    const text = value.trim();
    if (/^\d+$/.test(text)) return { seed: Number(BigInt(text) % 0x1_0000_0000n), explicit: true };
    return { seed: fnv1a(text), explicit: true };
  }
  return { seed: Math.floor(Date.now() % 0x1_0000_0000), explicit: false };
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** mulberry32: 32-bit generator, determinist. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates; does not modify `items`. Same seed, same order, including between the shads of the same job. */
export function shuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  const rand = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}
