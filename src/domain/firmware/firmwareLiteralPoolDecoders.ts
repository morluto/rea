import { readUint16At, readUint32At } from "../binaryContainer.js";
import type { FirmwareLiteralPoolIsa } from "./firmwareLiteralPools.js";
import { formatHexCompact } from "./firmwareLiteralPoolRegions.js";

export interface DecodedPoolLoadInstruction {
  readonly insnOffset: number;
  readonly insnSize: number;
  readonly insnAddress: number;
  readonly mnemonic: "ldr" | "ldr.w" | "l32r";
  readonly targetRegister: string;
  readonly disassembly: string;
  readonly poolOffset: number;
  readonly poolAddress: number;
  readonly loadedValue: number;
}

const CANDIDATE_CHUNK_SHIFT = 10;
const CANDIDATE_CHUNK_SIZE = 1 << CANDIDATE_CHUNK_SHIFT;
const CANDIDATE_CHUNK_MASK = CANDIDATE_CHUNK_SIZE - 1;

/**
 * Chunked TypedArray candidate table storing `(insnOffset, poolOffset, insnSize)`
 * in 9 bytes/entry without allocating JS objects or disassembly strings before
 * `max_references` admission succeeds.
 */
export class CompactCandidateBuffer {
  readonly #insnOffsets: Uint32Array[] = [];
  readonly #poolOffsets: Uint32Array[] = [];
  readonly #insnSizes: Uint8Array[] = [];
  #length = 0;

  get length(): number {
    return this.#length;
  }

  push(insnOffset: number, insnSize: number, poolOffset: number): void {
    const chunkIdx = this.#length >>> CANDIDATE_CHUNK_SHIFT;
    const slotIdx = this.#length & CANDIDATE_CHUNK_MASK;
    if (slotIdx === 0) {
      this.#insnOffsets.push(new Uint32Array(CANDIDATE_CHUNK_SIZE));
      this.#poolOffsets.push(new Uint32Array(CANDIDATE_CHUNK_SIZE));
      this.#insnSizes.push(new Uint8Array(CANDIDATE_CHUNK_SIZE));
    }
    this.#insnOffsets[chunkIdx]![slotIdx] = insnOffset;
    this.#poolOffsets[chunkIdx]![slotIdx] = poolOffset;
    this.#insnSizes[chunkIdx]![slotIdx] = insnSize;
    this.#length += 1;
  }

  insnOffsetAt(index: number): number {
    return this.#insnOffsets[index >>> CANDIDATE_CHUNK_SHIFT]![
      index & CANDIDATE_CHUNK_MASK
    ]!;
  }

  poolOffsetAt(index: number): number {
    return this.#poolOffsets[index >>> CANDIDATE_CHUNK_SHIFT]![
      index & CANDIDATE_CHUNK_MASK
    ]!;
  }

  insnSizeAt(index: number): number {
    return this.#insnSizes[index >>> CANDIDATE_CHUNK_SHIFT]![
      index & CANDIDATE_CHUNK_MASK
    ]!;
  }
}

export interface RawIsaScanResult {
  readonly candidates: CompactCandidateBuffer;
  readonly outOfImageTargets: number;
  readonly suppressedForwardOverlaps: number;
}

export const SCAN_COOPERATIVE_BYTE_STEP = 65_536;

/** Exact byte-granular bitset for literal-pool slots and instruction spans. */
export class PoolByteBitset {
  readonly #words: Uint32Array;
  readonly #byteLength: number;

  constructor(byteLength: number) {
    this.#byteLength = byteLength;
    this.#words = new Uint32Array((byteLength + 31) >>> 5);
  }

  markByte(offset: number): void {
    if (offset < 0 || offset >= this.#byteLength) return;
    this.#words[offset >>> 5]! |= 1 << (offset & 31);
  }

  markSpan(offset: number, size: number): void {
    const end = offset + size;
    for (let pos = offset; pos < end; pos += 1) {
      this.markByte(pos);
    }
  }

  markWord(poolOffset: number): void {
    this.markSpan(poolOffset, 4);
  }

  copyFrom(other: PoolByteBitset): void {
    const count = Math.min(this.#words.length, other.#words.length);
    for (let i = 0; i < count; i += 1) {
      this.#words[i]! |= other.#words[i]!;
    }
  }

  equals(other: PoolByteBitset): boolean {
    if (this.#words.length !== other.#words.length) return false;
    for (let i = 0; i < this.#words.length; i += 1) {
      if (this.#words[i]! !== other.#words[i]!) return false;
    }
    return true;
  }

  hasAnyBit(): boolean {
    for (let i = 0; i < this.#words.length; i += 1) {
      if (this.#words[i]! !== 0) return true;
    }
    return false;
  }

  hasByte(offset: number): boolean {
    if (offset < 0 || offset >= this.#byteLength) return false;
    return (this.#words[offset >>> 5]! & (1 << (offset & 31))) !== 0;
  }

  overlaps(offset: number, size: number): boolean {
    const end = offset + size;
    for (let pos = offset; pos < end; pos += 1) {
      if (this.hasByte(pos)) return true;
    }
    return false;
  }
}

const ARM_REGISTERS = [
  "r0",
  "r1",
  "r2",
  "r3",
  "r4",
  "r5",
  "r6",
  "r7",
  "r8",
  "r9",
  "r10",
  "r11",
  "r12",
  "sp",
  "lr",
  "pc",
] as const;

const A32_COND_SUFFIX = [
  "eq",
  "ne",
  "cs",
  "cc",
  "mi",
  "pl",
  "vs",
  "vc",
  "hi",
  "ls",
  "ge",
  "lt",
  "gt",
  "le",
  "",
] as const;

const resolveBytePoolOffset = (
  fileByteLength: number,
  baseAddress: number,
  poolAddrBig: bigint,
): number | null => {
  const relBig = poolAddrBig - BigInt(baseAddress >>> 0);
  if (relBig < 0n || relBig + 4n > BigInt(fileByteLength)) return null;
  return Number(relBig);
};

const resolveWordAlignedPoolOffset = (
  fileByteLength: number,
  baseAddress: number,
  poolAddrBig: bigint,
): number | null => {
  if ((poolAddrBig & 3n) !== 0n) return null;
  return resolveBytePoolOffset(fileByteLength, baseAddress, poolAddrBig);
};

const probeThumb32PoolOffset = (
  fileByteLength: number,
  baseAddress: number,
  off: number,
  hw1: number,
  hw2: number,
): number | "out_of_image" | null => {
  if (hw1 !== 0xf8df && hw1 !== 0xf85f) return null;
  const uAdd = hw1 === 0xf8df;
  const imm12 = hw2 & 0x0fff;
  const insnAddress = (baseAddress + off) >>> 0;
  const alignedPc = (BigInt(insnAddress) + 4n) & ~3n;
  const poolAddrBig = uAdd
    ? alignedPc + BigInt(imm12)
    : alignedPc - BigInt(imm12);
  const poolOffset = resolveBytePoolOffset(
    fileByteLength,
    baseAddress,
    poolAddrBig,
  );
  return poolOffset === null ? "out_of_image" : poolOffset;
};

const probeThumb16PoolOffset = (
  fileByteLength: number,
  baseAddress: number,
  off: number,
  hw1: number,
): number | "out_of_image" | null => {
  if ((hw1 & 0xf800) !== 0x4800) return null;
  const immBytes = (hw1 & 0xff) * 4;
  const insnAddress = (baseAddress + off) >>> 0;
  const alignedPc = (BigInt(insnAddress) + 4n) & ~3n;
  const poolAddrBig = alignedPc + BigInt(immBytes);
  const poolOffset = resolveWordAlignedPoolOffset(
    fileByteLength,
    baseAddress,
    poolAddrBig,
  );
  return poolOffset === null ? "out_of_image" : poolOffset;
};

const thumbPoolHalfwordLooksLikeLoad = (
  fileBytes: Uint8Array,
  baseAddress: number,
  off: number,
  scanEnd: number,
): boolean => {
  const hw1 = readUint16At(fileBytes, off, true);
  if (hw1 === undefined) return false;
  if (hw1 >= 0xe800) {
    if (off + 4 > scanEnd) return false;
    const hw2 = readUint16At(fileBytes, off + 2, true);
    if (hw2 === undefined) return false;
    const pool = probeThumb32PoolOffset(
      fileBytes.length,
      baseAddress,
      off,
      hw1,
      hw2,
    );
    return pool !== null && pool !== "out_of_image";
  }
  const pool16 = probeThumb16PoolOffset(
    fileBytes.length,
    baseAddress,
    off,
    hw1,
  );
  return pool16 !== null && pool16 !== "out_of_image";
};

const deriveConfirmedBackwardPools = (
  candidates: CompactCandidateBuffer,
  byteLength: number,
): PoolByteBitset => {
  const allTargets = new PoolByteBitset(byteLength);
  for (let i = 0; i < candidates.length; i += 1) {
    allTargets.markWord(candidates.poolOffsetAt(i));
  }
  const confirmedBackward = new PoolByteBitset(byteLength);
  for (let i = 0; i < candidates.length; i += 1) {
    const insnOff = candidates.insnOffsetAt(i);
    const insnSize = candidates.insnSizeAt(i);
    const poolOff = candidates.poolOffsetAt(i);
    if (poolOff < insnOff && !allTargets.overlaps(insnOff, insnSize)) {
      confirmedBackward.markWord(poolOff);
    }
  }
  return confirmedBackward;
};

function* runThumbSinglePassSteps(
  fileBytes: Uint8Array,
  baseAddress: number,
  scanStart: number,
  scanEnd: number,
  seededPoolBytes?: PoolByteBitset,
): Generator<
  "step",
  RawIsaScanResult & { readonly sawBackwardCandidate: boolean },
  void
> {
  const candidates = new CompactCandidateBuffer();
  const poolBytes = new PoolByteBitset(fileBytes.length);
  if (seededPoolBytes !== undefined) poolBytes.copyFrom(seededPoolBytes);
  // not-an-allowance: tally of PC-relative literal loads targeting outside image bounds
  let outOfImageTargets = 0;
  // not-an-allowance: tally of pool-slot data halfwords suppressed from decoding
  let suppressedForwardOverlaps = 0;
  let sawBackwardCandidate = false;
  let off = scanStart;
  let nextYield = scanStart + SCAN_COOPERATIVE_BYTE_STEP;

  while (off + 2 <= scanEnd) {
    if (off >= nextYield) {
      yield "step";
      nextYield = off + SCAN_COOPERATIVE_BYTE_STEP;
    }
    if (poolBytes.overlaps(off, 2)) {
      if (thumbPoolHalfwordLooksLikeLoad(fileBytes, baseAddress, off, scanEnd))
        suppressedForwardOverlaps += 1;
      off += 2;
      continue;
    }
    const hw1 = readUint16At(fileBytes, off, true);
    if (hw1 === undefined) break;

    if (hw1 >= 0xe800) {
      if (off + 4 > scanEnd) break;
      if (poolBytes.overlaps(off, 4)) {
        off += 2;
        continue;
      }
      const hw2 = readUint16At(fileBytes, off + 2, true);
      if (hw2 === undefined) break;
      const poolOff = probeThumb32PoolOffset(
        fileBytes.length,
        baseAddress,
        off,
        hw1,
        hw2,
      );
      if (poolOff === "out_of_image") {
        outOfImageTargets += 1;
      } else if (poolOff !== null) {
        if (poolOff >= off + 4) poolBytes.markWord(poolOff);
        else if (poolOff < off) sawBackwardCandidate = true;
        candidates.push(off, 4, poolOff);
      }
      off += 4;
      continue;
    }

    const poolOff16 = probeThumb16PoolOffset(
      fileBytes.length,
      baseAddress,
      off,
      hw1,
    );
    if (poolOff16 === "out_of_image") {
      outOfImageTargets += 1;
    } else if (poolOff16 !== null) {
      if (poolOff16 >= off + 2) poolBytes.markWord(poolOff16);
      candidates.push(off, 2, poolOff16);
    }
    off += 2;
  }

  return {
    candidates,
    outOfImageTargets,
    suppressedForwardOverlaps,
    sawBackwardCandidate,
  };
}

export function* collectThumbCandidatesSteps(
  fileBytes: Uint8Array,
  baseAddress: number,
  scanStart: number,
  scanEnd: number,
): Generator<"step", RawIsaScanResult, void> {
  let pass = yield* runThumbSinglePassSteps(
    fileBytes,
    baseAddress,
    scanStart,
    scanEnd,
  );
  if (!pass.sawBackwardCandidate) return pass;

  let seeded = deriveConfirmedBackwardPools(pass.candidates, fileBytes.length);
  if (!seeded.hasAnyBit()) return pass;

  for (let round = 0; round < 2; round += 1) {
    pass = yield* runThumbSinglePassSteps(
      fileBytes,
      baseAddress,
      scanStart,
      scanEnd,
      seeded,
    );
    const nextSeed = deriveConfirmedBackwardPools(
      pass.candidates,
      fileBytes.length,
    );
    nextSeed.copyFrom(seeded);
    if (nextSeed.equals(seeded)) break;
    seeded = nextSeed;
  }
  return pass;
}

const probeA32LiteralWord = (
  fileBytes: Uint8Array,
  baseAddress: number,
  off: number,
): number | "out_of_image" | null => {
  const word = readUint32At(fileBytes, off, true);
  if (word === undefined) return null;
  const cond = (word >>> 28) & 0x0f;
  if (cond === 0x0f || (word & 0x0f7f_0000) !== 0x051f_0000) return null;

  const uAdd = (word & 0x0080_0000) !== 0;
  const imm12 = word & 0x0fff;
  const insnAddress = (baseAddress + off) >>> 0;
  const poolAddrBig =
    BigInt(insnAddress) + 8n + (uAdd ? BigInt(imm12) : -BigInt(imm12));
  const poolOffset = resolveBytePoolOffset(
    fileBytes.length,
    baseAddress,
    poolAddrBig,
  );
  return poolOffset === null ? "out_of_image" : poolOffset;
};

function* runA32SinglePassSteps(
  fileBytes: Uint8Array,
  baseAddress: number,
  scanStart: number,
  scanEnd: number,
  seededPoolBytes?: PoolByteBitset,
): Generator<
  "step",
  RawIsaScanResult & { readonly sawBackwardCandidate: boolean },
  void
> {
  const candidates = new CompactCandidateBuffer();
  const poolBytes = new PoolByteBitset(fileBytes.length);
  if (seededPoolBytes !== undefined) poolBytes.copyFrom(seededPoolBytes);
  // not-an-allowance: tally of PC-relative literal loads targeting outside image bounds
  let outOfImageTargets = 0;
  // not-an-allowance: tally of pool-slot data words suppressed from decoding
  let suppressedForwardOverlaps = 0;
  let sawBackwardCandidate = false;
  let nextYield = scanStart + SCAN_COOPERATIVE_BYTE_STEP;

  for (let off = scanStart; off + 4 <= scanEnd; off += 4) {
    if (off >= nextYield) {
      yield "step";
      nextYield = off + SCAN_COOPERATIVE_BYTE_STEP;
    }
    const poolOff = probeA32LiteralWord(fileBytes, baseAddress, off);
    if (poolBytes.overlaps(off, 4)) {
      if (poolOff !== null && poolOff !== "out_of_image") {
        suppressedForwardOverlaps += 1;
      }
      continue;
    }
    if (poolOff === "out_of_image") {
      outOfImageTargets += 1;
      continue;
    }
    if (poolOff === null) continue;
    if (poolOff >= off + 4) poolBytes.markWord(poolOff);
    else if (poolOff < off) sawBackwardCandidate = true;
    candidates.push(off, 4, poolOff);
  }

  return {
    candidates,
    outOfImageTargets,
    suppressedForwardOverlaps,
    sawBackwardCandidate,
  };
}

export function* collectA32CandidatesSteps(
  fileBytes: Uint8Array,
  baseAddress: number,
  scanStart: number,
  scanEnd: number,
): Generator<"step", RawIsaScanResult, void> {
  let pass = yield* runA32SinglePassSteps(
    fileBytes,
    baseAddress,
    scanStart,
    scanEnd,
  );
  if (!pass.sawBackwardCandidate) return pass;

  let seeded = deriveConfirmedBackwardPools(pass.candidates, fileBytes.length);
  if (!seeded.hasAnyBit()) return pass;

  for (let round = 0; round < 2; round += 1) {
    pass = yield* runA32SinglePassSteps(
      fileBytes,
      baseAddress,
      scanStart,
      scanEnd,
      seeded,
    );
    const nextSeed = deriveConfirmedBackwardPools(
      pass.candidates,
      fileBytes.length,
    );
    nextSeed.copyFrom(seeded);
    if (nextSeed.equals(seeded)) break;
    seeded = nextSeed;
  }
  return pass;
}

const nextMappedAlign4Offset = (baseAddress: number, off: number): number => {
  const rem = ((baseAddress >>> 0) + off) & 3;
  return off + (4 - rem);
};

const skipZeroPaddingToMappedAlign4 = (
  fileBytes: Uint8Array,
  baseAddress: number,
  startOff: number,
  scanEnd: number,
): number => {
  let cursor = startOff;
  while (
    cursor < scanEnd &&
    (((baseAddress >>> 0) + cursor) & 3) !== 0 &&
    fileBytes[cursor] === 0x00
  ) {
    cursor += 1;
  }
  return cursor;
};

const probeXtensaL32rPoolOffset = (
  fileBytes: Uint8Array,
  baseAddress: number,
  off: number,
  scanEnd: number,
): number | "out_of_image" | null => {
  const b0 = fileBytes[off]!;
  if ((b0 & 0x0f) !== 0x01 || off + 3 > scanEnd) return null;
  const offset16 = fileBytes[off + 1]! | (fileBytes[off + 2]! << 8);
  const signedWords = offset16 - 0x1_0000;
  const insnAddress = (baseAddress + off) >>> 0;
  const alignedPc = (BigInt(insnAddress) + 3n) & ~3n;
  const poolAddrBig = alignedPc + BigInt(signedWords) * 4n;
  const poolOffset = resolveWordAlignedPoolOffset(
    fileBytes.length,
    baseAddress,
    poolAddrBig,
  );
  if (poolOffset === null || poolOffset + 4 > off) {
    return "out_of_image";
  }
  return poolOffset;
};

interface XtensaStepOutcome {
  readonly insnWidth: 1 | 2 | 3;
  readonly nextOff: number | "stop";
  readonly invalidEncoding: boolean;
}

const stepXtensaRaw = (
  fileBytes: Uint8Array,
  baseAddress: number,
  off: number,
  scanEnd: number,
): XtensaStepOutcome => {
  const b0 = fileBytes[off]!;
  const op0 = b0 & 0x0f;
  if (op0 >= 0x0e) {
    return {
      insnWidth: 1,
      nextOff: nextMappedAlign4Offset(baseAddress, off),
      invalidEncoding: true,
    };
  }
  if (op0 >= 0x08) {
    const b1 = fileBytes[off + 1]!;
    const isNarrowRet = (b0 === 0x0d || b0 === 0x1d) && b1 === 0xf0;
    return {
      insnWidth: 2,
      nextOff: isNarrowRet
        ? skipZeroPaddingToMappedAlign4(
            fileBytes,
            baseAddress,
            off + 2,
            scanEnd,
          )
        : off + 2,
      invalidEncoding: false,
    };
  }
  if (off + 3 > scanEnd) {
    return { insnWidth: 3, nextOff: "stop", invalidEncoding: false };
  }
  const b1 = fileBytes[off + 1]!;
  const b2 = fileBytes[off + 2]!;
  if (b0 === 0x00 && b1 === 0x00 && b2 === 0x00) {
    return {
      insnWidth: 3,
      nextOff: nextMappedAlign4Offset(baseAddress, off),
      invalidEncoding: true,
    };
  }
  const isWideRet = (b0 === 0x80 || b0 === 0x90) && b1 === 0x00 && b2 === 0x00;
  return {
    insnWidth: 3,
    nextOff: isWideRet
      ? skipZeroPaddingToMappedAlign4(fileBytes, baseAddress, off + 3, scanEnd)
      : off + 3,
    invalidEncoding: false,
  };
};

interface PendingAlignedTrace {
  readonly alignedOff: number;
  readonly candStart: number;
  readonly candEnd: number;
  readonly nearInvalid: boolean;
}

const filterSelfConsistentXtensaPools = (
  candidates: CompactCandidateBuffer,
  byteLength: number,
): PoolByteBitset => {
  const allTargets = new PoolByteBitset(byteLength);
  for (let i = 0; i < candidates.length; i += 1) {
    allTargets.markWord(candidates.poolOffsetAt(i));
  }
  const confirmed = new PoolByteBitset(byteLength);
  for (let i = 0; i < candidates.length; i += 1) {
    const insnOff = candidates.insnOffsetAt(i);
    const insnSize = candidates.insnSizeAt(i);
    if (!allTargets.overlaps(insnOff, insnSize)) {
      confirmed.markWord(candidates.poolOffsetAt(i));
    }
  }
  return confirmed;
};

function* markXtensaRunFullSpansSteps(
  visited: PoolByteBitset,
  fileBytes: Uint8Array,
  baseAddress: number,
  runStart: number,
  runStop: number,
  scanEnd: number,
): Generator<"step", void, void> {
  let cursor = runStart;
  let nextYield = runStart + SCAN_COOPERATIVE_BYTE_STEP;
  while (cursor < runStop && cursor + 2 <= scanEnd) {
    if (cursor >= nextYield) {
      yield "step";
      nextYield = cursor + SCAN_COOPERATIVE_BYTE_STEP;
    }
    const step = stepXtensaRaw(fileBytes, baseAddress, cursor, scanEnd);
    if (step.invalidEncoding) break;
    visited.markSpan(cursor, step.insnWidth);
    if (step.nextOff === "stop") break;
    cursor = step.nextOff;
  }
}

function* walkPrimaryXtensaSteps(
  fileBytes: Uint8Array,
  baseAddress: number,
  scanStart: number,
  scanEnd: number,
) {
  const visited = new PoolByteBitset(fileBytes.length);
  const invalidBytes = new PoolByteBitset(fileBytes.length);
  const accepted = new CompactCandidateBuffer();
  let runStartOff = scanStart;
  let runHasL32r = false;
  let off = scanStart;
  let nextYield = scanStart + SCAN_COOPERATIVE_BYTE_STEP;

  while (off + 2 <= scanEnd) {
    if (off >= nextYield) {
      yield "step" as const;
      nextYield = off + SCAN_COOPERATIVE_BYTE_STEP;
    }
    const poolOff = probeXtensaL32rPoolOffset(
      fileBytes,
      baseAddress,
      off,
      scanEnd,
    );
    if (poolOff !== null && poolOff !== "out_of_image") {
      accepted.push(off, 3, poolOff);
      runHasL32r = true;
    }
    const step = stepXtensaRaw(fileBytes, baseAddress, off, scanEnd);
    if (step.invalidEncoding) {
      invalidBytes.markByte(off);
      if (runHasL32r) {
        yield* markXtensaRunFullSpansSteps(
          visited,
          fileBytes,
          baseAddress,
          runStartOff,
          off,
          scanEnd,
        );
      }
      runHasL32r = false;
      if (step.nextOff === "stop") {
        runStartOff = scanEnd;
        break;
      }
      off = step.nextOff;
      runStartOff = off;
      continue;
    }
    visited.markByte(off);
    if (step.nextOff === "stop") {
      visited.markSpan(off, step.insnWidth);
      yield* markXtensaRunFullSpansSteps(
        visited,
        fileBytes,
        baseAddress,
        runStartOff,
        off,
        scanEnd,
      );
      runStartOff = scanEnd;
      break;
    }
    off = step.nextOff;
  }
  if (runStartOff < off) {
    yield* markXtensaRunFullSpansSteps(
      visited,
      fileBytes,
      baseAddress,
      runStartOff,
      off,
      scanEnd,
    );
  }
  return { visited, invalidBytes, accepted };
}

const alignedPrecededByPool = (
  alignedOff: number,
  tracePool: CompactCandidateBuffer,
  candStart: number,
  candEnd: number,
  knownPoolBytes: PoolByteBitset,
): boolean => {
  if (alignedOff < 4) return false;
  const prevWord = alignedOff - 4;
  if (knownPoolBytes.hasByte(prevWord)) return true;
  for (let i = candStart; i < candEnd; i += 1) {
    if (tracePool.poolOffsetAt(i) === prevWord) return true;
  }
  return false;
};

function* discoverXtensaPoolBytesSteps(
  fileBytes: Uint8Array,
  baseAddress: number,
  scanStart: number,
  scanEnd: number,
): Generator<"step", PoolByteBitset, void> {
  const { visited, invalidBytes, accepted } = yield* walkPrimaryXtensaSteps(
    fileBytes,
    baseAddress,
    scanStart,
    scanEnd,
  );

  // Protect primary-walk L32R spans that are not self-invalidated by another primary load.
  const primaryAllTargets = new PoolByteBitset(fileBytes.length);
  for (let i = 0; i < accepted.length; i += 1) {
    primaryAllTargets.markWord(accepted.poolOffsetAt(i));
  }
  const protectedPrimarySpans = new PoolByteBitset(fileBytes.length);
  const knownPoolBytes = new PoolByteBitset(fileBytes.length);
  for (let i = 0; i < accepted.length; i += 1) {
    const insnOff = accepted.insnOffsetAt(i);
    const insnSize = accepted.insnSizeAt(i);
    const poolOff = accepted.poolOffsetAt(i);
    knownPoolBytes.markWord(poolOff);
    if (!primaryAllTargets.overlaps(insnOff, insnSize)) {
      protectedPrimarySpans.markSpan(insnOff, insnSize);
    }
  }

  const tracePool = new CompactCandidateBuffer();
  const pendingTraces: PendingAlignedTrace[] = [];
  const firstRem = ((baseAddress >>> 0) + scanStart) & 3;
  const firstAligned = firstRem === 0 ? scanStart : scanStart + (4 - firstRem);
  let nextYield = firstAligned + SCAN_COOPERATIVE_BYTE_STEP;

  for (
    let alignedOff = firstAligned;
    alignedOff + 2 <= scanEnd;
    alignedOff += 4
  ) {
    if (alignedOff >= nextYield) {
      yield "step";
      nextYield = alignedOff + SCAN_COOPERATIVE_BYTE_STEP;
    }
    if (visited.hasByte(alignedOff)) continue;
    const candStart = tracePool.length;
    let validTraceCount = 0;
    let cursor = alignedOff;
    let hitInvalid = false;
    while (cursor + 2 <= scanEnd) {
      const step = stepXtensaRaw(fileBytes, baseAddress, cursor, scanEnd);
      if (step.invalidEncoding) {
        hitInvalid = true;
        break;
      }
      if (visited.overlaps(cursor, step.insnWidth)) break;
      visited.markSpan(cursor, step.insnWidth);
      const poolOff = probeXtensaL32rPoolOffset(
        fileBytes,
        baseAddress,
        cursor,
        scanEnd,
      );
      if (poolOff !== null && poolOff !== "out_of_image") {
        tracePool.push(cursor, 3, poolOff);
        validTraceCount += 1;
      }
      if (step.nextOff === "stop") break;
      cursor = step.nextOff;
    }
    if (hitInvalid || validTraceCount === 0) continue;
    const nearInvalid = invalidBytes.overlaps(
      Math.max(scanStart, alignedOff - 4),
      8,
    );
    pendingTraces.push({
      alignedOff,
      candStart,
      candEnd: candStart + validTraceCount,
      nearInvalid,
    });
  }

  for (const trace of pendingTraces) {
    const precedesKnownPool = alignedPrecededByPool(
      trace.alignedOff,
      tracePool,
      trace.candStart,
      trace.candEnd,
      knownPoolBytes,
    );
    if (!trace.nearInvalid && !precedesKnownPool) continue;
    for (let i = trace.candStart; i < trace.candEnd; i += 1) {
      const poolOff = tracePool.poolOffsetAt(i);
      if (protectedPrimarySpans.overlaps(poolOff, 4)) continue;
      accepted.push(
        tracePool.insnOffsetAt(i),
        tracePool.insnSizeAt(i),
        poolOff,
      );
      knownPoolBytes.markWord(poolOff);
    }
  }

  return filterSelfConsistentXtensaPools(accepted, fileBytes.length);
}

export function* collectXtensaCandidatesSteps(
  fileBytes: Uint8Array,
  baseAddress: number,
  scanStart: number,
  scanEnd: number,
): Generator<"step", RawIsaScanResult, void> {
  const confirmedPoolBytes = yield* discoverXtensaPoolBytesSteps(
    fileBytes,
    baseAddress,
    scanStart,
    scanEnd,
  );
  const candidates = new CompactCandidateBuffer();
  // not-an-allowance: tally of L32R instructions targeting outside image bounds
  let outOfImageTargets = 0;
  // not-an-allowance: tally of confirmed pool words whose bytes also resembled L32R
  let suppressedForwardOverlaps = 0;
  let off = scanStart;
  let nextYield = scanStart + SCAN_COOPERATIVE_BYTE_STEP;

  while (off + 2 <= scanEnd) {
    if (off >= nextYield) {
      yield "step";
      nextYield = off + SCAN_COOPERATIVE_BYTE_STEP;
    }
    if (confirmedPoolBytes.hasByte(off)) {
      const poolEnd = Math.min(
        scanEnd,
        nextMappedAlign4Offset(baseAddress, off),
      );
      for (let pos = off; pos + 3 <= poolEnd; pos += 1) {
        const fake = probeXtensaL32rPoolOffset(
          fileBytes,
          baseAddress,
          pos,
          scanEnd,
        );
        if (fake !== null && fake !== "out_of_image") {
          suppressedForwardOverlaps += 1;
          break;
        }
      }
      off = poolEnd > off ? poolEnd : off + 1;
      continue;
    }

    const b0 = fileBytes[off]!;
    const op0 = b0 & 0x0f;
    const insnWidth = op0 >= 0x0e ? 1 : op0 >= 0x08 ? 2 : 3;
    if (insnWidth > 1 && confirmedPoolBytes.overlaps(off, insnWidth)) {
      off += 1;
      continue;
    }

    const poolOff = probeXtensaL32rPoolOffset(
      fileBytes,
      baseAddress,
      off,
      scanEnd,
    );
    if (poolOff === "out_of_image") {
      outOfImageTargets += 1;
    } else if (poolOff !== null) {
      candidates.push(off, 3, poolOff);
    }

    const step = stepXtensaRaw(fileBytes, baseAddress, off, scanEnd);
    if (step.nextOff === "stop") break;
    off = step.nextOff;
  }

  return { candidates, outOfImageTargets, suppressedForwardOverlaps };
}

/** Materialize formatted disassembly and register facts for an admitted `(insnOffset, insnSize, poolOffset)` entry. */
export const decodeAdmittedPoolLoad = (options: {
  readonly isa: FirmwareLiteralPoolIsa;
  readonly fileBytes: Uint8Array;
  readonly baseAddress: number;
  readonly insnOffset: number;
  readonly insnSize: number;
  readonly poolOffset: number;
}): DecodedPoolLoadInstruction => {
  const { isa, fileBytes, baseAddress, insnOffset, insnSize, poolOffset } =
    options;
  const insnAddress = (baseAddress + insnOffset) >>> 0;
  const poolAddress = (baseAddress + poolOffset) >>> 0;
  const loadedValue = readUint32At(fileBytes, poolOffset, true) ?? 0;

  if (isa === "arm-thumb") {
    const hw1 = readUint16At(fileBytes, insnOffset, true) ?? 0;
    if (insnSize === 4) {
      const hw2 = readUint16At(fileBytes, insnOffset + 2, true) ?? 0;
      const uAdd = hw1 === 0xf8df;
      const rt = (hw2 >>> 12) & 0x0f;
      const imm12 = hw2 & 0x0fff;
      const reg = ARM_REGISTERS[rt] ?? `r${String(rt)}`;
      const signedDisp = uAdd
        ? `#0x${imm12.toString(16)}`
        : `#-0x${imm12.toString(16)}`;
      return {
        insnOffset,
        insnSize,
        insnAddress,
        mnemonic: "ldr.w",
        targetRegister: reg,
        disassembly: `ldr.w ${reg}, [pc, ${signedDisp}]`,
        poolOffset,
        poolAddress,
        loadedValue,
      };
    }
    const rt = (hw1 >>> 8) & 0x07;
    const immBytes = (hw1 & 0xff) * 4;
    const reg = ARM_REGISTERS[rt] ?? `r${String(rt)}`;
    return {
      insnOffset,
      insnSize,
      insnAddress,
      mnemonic: "ldr",
      targetRegister: reg,
      disassembly: `ldr ${reg}, [pc, #0x${immBytes.toString(16)}]`,
      poolOffset,
      poolAddress,
      loadedValue,
    };
  }

  if (isa === "arm-a32") {
    const word = readUint32At(fileBytes, insnOffset, true) ?? 0;
    const cond = (word >>> 28) & 0x0f;
    const uAdd = (word & 0x0080_0000) !== 0;
    const rd = (word >>> 12) & 0x0f;
    const imm12 = word & 0x0fff;
    const reg = ARM_REGISTERS[rd] ?? `r${String(rd)}`;
    const condText = A32_COND_SUFFIX[cond] ?? "";
    const signedDisp = uAdd
      ? `#0x${imm12.toString(16)}`
      : `#-0x${imm12.toString(16)}`;
    return {
      insnOffset,
      insnSize,
      insnAddress,
      mnemonic: "ldr",
      targetRegister: reg,
      disassembly: `ldr${condText} ${reg}, [pc, ${signedDisp}]`,
      poolOffset,
      poolAddress,
      loadedValue,
    };
  }

  const b0 = fileBytes[insnOffset]!;
  const at = (b0 >>> 4) & 0x0f;
  const reg = `a${String(at)}`;
  return {
    insnOffset,
    insnSize,
    insnAddress,
    mnemonic: "l32r",
    targetRegister: reg,
    disassembly: `l32r ${reg}, ${formatHexCompact(poolAddress)}`,
    poolOffset,
    poolAddress,
    loadedValue,
  };
};
