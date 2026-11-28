import { CanonicalizeService } from "../application/canonicalize/CanonicalizeService.js";
import { CanonicalizeProvider } from "../canonicalize/CanonicalizeProvider.js";

/** Portable, execution-free antidote canonicalization with no engine, toolchain or target acquisition. */
export const createCanonicalizeService = (): CanonicalizeService =>
  new CanonicalizeService(new CanonicalizeProvider());
