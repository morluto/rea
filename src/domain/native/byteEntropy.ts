import { z } from "zod";
import { absoluteLocalPathStringSchema } from "../localPath.js";

const offsetSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const entropySchema = z.number().min(0).max(8);

/** Select blocks relative to an explicit byte window; identity remains file-wide. */
export const inspectByteEntropyInputSchema = z.strictObject({
  path: absoluteLocalPathStringSchema.describe(
    "Absolute filesystem path to the file",
  ),
  block_size: z
    .number()
    .int()
    .min(256)
    .max(65536)
    .refine(
      (value) => (value & (value - 1)) === 0,
      "Block size must be a power of two.",
    )
    .default(4096),
  offset: offsetSchema.default(0),
  length: offsetSchema.optional(),
});
const blockSchema = z.strictObject({
  offset: offsetSchema,
  length: offsetSchema,
  entropy: entropySchema,
});
const runSchema = z.strictObject({
  offset: offsetSchema,
  length: offsetSchema,
  classification: z.enum(["high", "low"]),
});
export const byteEntropySchema = z.strictObject({
  artifact: z.strictObject({
    path: z.string(),
    bytes: offsetSchema,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  block_size: z.number().int().min(256).max(65536),
  window: z.strictObject({ offset: offsetSchema, length: offsetSchema }),
  file_entropy: entropySchema,
  thresholds: z.strictObject({ high: entropySchema, low: entropySchema }),
  blocks: z.array(blockSchema),
  runs: z.array(runSchema),
  limitations: z.array(z.string()),
});
export type ByteEntropy = z.infer<typeof byteEntropySchema>;

/** Shannon entropy in bits per byte, rounded once at the reporting boundary. */
export const entropyFromCounts = (
  counts: ArrayLike<number>,
  length: number,
): number => {
  if (length === 0) return 0;
  let entropy = 0;
  for (let i = 0; i < counts.length; i++) {
    const count = counts[i] ?? 0;
    if (count > 0) {
      const probability = count / length;
      entropy -= probability * Math.log2(probability);
    }
  }
  return Math.round(entropy * 10000) / 10000;
};

/**
 * Counter for a whole-file byte census.
 *
 * A file may be larger than 4 GiB and one byte value may occur at least 2^32 times,
 * so the bin has to hold counts a `Uint32Array` would wrap. Indexed reads into a
 * `Float64Array` measure the same as into an integer bin, so exactness is free here.
 */
export const wholeFileByteCounts = (): Float64Array => new Float64Array(256);

/**
 * Add a run of bytes to a census.
 *
 * The counter is a `Float64Array` because one value can occur more than 2^32 times in a
 * whole-file census, and an integer bin would wrap. Indexed reads into a float counter measure the
 * same as into an integer one, so the exactness costs nothing; the gain over `for...of` comes from
 * the indexed reads, not from the bin.
 *
 * Both the per-block entropy and the service's whole-file census call this, so the loop exists
 * once and a caller cannot pick a narrower counter without the signature rejecting it.
 */
export const countByteValues = (
  bytes: Uint8Array,
  counts: Float64Array,
): void => {
  const length = bytes.length;
  for (let index = 0; index < length; index += 1) {
    const key = bytes[index] as number;
    counts[key] = counts[key]! + 1;
  }
};

export const computeBlockEntropy = (bytes: Uint8Array): number => {
  const counts = new Float64Array(256);
  countByteValues(bytes, counts);
  return entropyFromCounts(counts, bytes.length);
};

/** Merge only adjacent classified blocks, using the reported rounded entropy. */
export const mergeEntropyRuns = (
  blocks: readonly ByteEntropy["blocks"][number][],
  thresholds: ByteEntropy["thresholds"],
): ByteEntropy["runs"] => {
  const runs: ByteEntropy["runs"] = [];
  for (const block of blocks) {
    const classification =
      block.entropy >= thresholds.high
        ? "high"
        : block.entropy <= thresholds.low
          ? "low"
          : null;
    if (classification === null || block.length === 0) continue;
    const previous = runs.at(-1);
    if (
      previous?.classification === classification &&
      previous.offset + previous.length === block.offset
    )
      previous.length += block.length;
    else
      runs.push({ offset: block.offset, length: block.length, classification });
  }
  return runs;
};
