/**
 * Deterministic pseudo-random generation for controlled replay.
 *
 * The generator lives here so the replay worker and the case planner cannot
 * drift: they previously each inlined the same xorshift32 loop, and a fix to
 * one (such as the zero-seed collapse below) would silently not apply to the
 * other.
 */

/** One xorshift32 step. Returns the next unsigned 32-bit state. */
export const nextXorshift32 = (state: number): number => {
  let next = state >>> 0;
  next ^= next << 13;
  next ^= next >>> 17;
  next ^= next << 5;
  return next >>> 0;
};

/**
 * xorshift32 has a fixed point at zero: seeding it with 0 yields 0 forever, so
 * every "random" value collapses to the same constant and two runs look
 * identical for the wrong reason. Substitute a fixed non-zero state instead.
 */
export const NON_DEGENERATE_XORSHIFT32_SEED = 0x9e37_79b9;

export const normalizeXorshift32Seed = (seed: number): number => {
  const state = seed >>> 0;
  return state === 0 ? NON_DEGENERATE_XORSHIFT32_SEED : state;
};

/** A seeded generator returning floats in [0, 1). */
export type SeededRandom = () => number;

/** A seeded generator returning unsigned 32-bit integers. */
export type SeededRandomUint = () => number;

/** Build a float generator in [0, 1) whose values depend only on `seed`. */
export const createSeededRandom = (seed: number): SeededRandom => {
  let state = normalizeXorshift32Seed(seed);
  return () => {
    state = nextXorshift32(state);
    return state / 0x1_0000_0000;
  };
};

/** Build an unsigned 32-bit generator whose values depend only on `seed`. */
export const createSeededRandomUint = (seed: number): SeededRandomUint => {
  let state = normalizeXorshift32Seed(seed);
  return () => {
    state = nextXorshift32(state);
    return state;
  };
};
