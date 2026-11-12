import { expect, it } from "vitest";
import {
  computeBlockEntropy,
  countByteValues,
  entropyFromCounts,
  inspectByteEntropyInputSchema,
  mergeEntropyRuns,
  wholeFileByteCounts,
} from "./byteEntropy.js";

it("computes known Shannon answers including partial and empty blocks", () => {
  expect(computeBlockEntropy(new Uint8Array(4096))).toBe(0);
  expect(
    computeBlockEntropy(Uint8Array.from({ length: 256 }, (_, i) => i)),
  ).toBe(8);
  expect(computeBlockEntropy(Uint8Array.of(0, 1))).toBe(1);
  expect(computeBlockEntropy(Uint8Array.of(0, 0, 0, 1))).toBe(0.8113);
  expect(computeBlockEntropy(new Uint8Array())).toBe(0);
});

it("merges adjacent threshold edges but not unclassified blocks or gaps", () => {
  expect(
    mergeEntropyRuns(
      [
        { offset: 7, length: 256, entropy: 1 },
        { offset: 263, length: 256, entropy: 0 },
        { offset: 519, length: 256, entropy: 7.2 },
        { offset: 775, length: 256, entropy: 7.1999 },
        { offset: 1031, length: 256, entropy: 8 },
        { offset: 1400, length: 2, entropy: 8 },
      ],
      { high: 7.2, low: 1 },
    ),
  ).toEqual([
    { offset: 7, length: 512, classification: "low" },
    { offset: 519, length: 256, classification: "high" },
    { offset: 1031, length: 256, classification: "high" },
    { offset: 1400, length: 2, classification: "high" },
  ]);
});

it("rejects unsafe windows, unknown fields and unsupported block sizes", () => {
  for (const options of [
    { block_size: 257 },
    { block_size: 128 },
    { block_size: 131072 },
    { offset: -1 },
    { length: Number.MAX_SAFE_INTEGER + 1 },
    { extra: true },
  ]) {
    expect(
      inspectByteEntropyInputSchema.safeParse({ path: "/file", ...options })
        .success,
    ).toBe(false);
  }
});
it("counts a repeated byte past 2^32 without wrapping", () => {
  // A file larger than 4 GiB with one dominant byte value. `countByteValues` is the loop both the
  // per-block entropy and the service's whole-file census call, so exercising it here covers both
  // — and the counter type is part of its signature, which is what keeps a narrower bin out.
  const counts = wholeFileByteCounts();
  // 2^32 is far too many iterations for a test; the loop is called once per chunk, so calling it
  // with a chunk that lands just under the wrap and once more across it is enough.
  const chunk = new Uint8Array(2 ** 16).fill(0);
  counts[0] = 2 ** 32 - 2 ** 15;
  countByteValues(chunk, counts);
  expect(counts[0]).toBe(2 ** 32 + 2 ** 15);
  expect(entropyFromCounts(counts, counts[0]!)).toBe(0);
});

it("accumulates the same census across chunks as one concatenated run", () => {
  // The service counts chunk by chunk; a per-chunk counter would be wrong. Both chunks go into
  // one counter here, which is what the service does.
  const counts = wholeFileByteCounts();
  countByteValues(new Uint8Array([0, 1, 0]), counts);
  countByteValues(new Uint8Array([1, 0]), counts);
  expect(Array.from(counts.slice(0, 2))).toEqual([3, 2]);
  expect(entropyFromCounts(counts, 5)).toBe(
    computeBlockEntropy(new Uint8Array([0, 1, 0, 1, 0])),
  );
});
