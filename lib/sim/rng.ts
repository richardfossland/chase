/** mulberry32 — tiny seeded PRNG so a scenario replays identically. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Normal-ish noise (sum of uniforms), mean 0, sd ≈ 1. */
export function gauss(r: () => number): number {
  return r() + r() + r() + r() - 2;
}
