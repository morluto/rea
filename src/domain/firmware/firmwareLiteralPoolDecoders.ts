import { readUint16At, readUint32At } from "../binaryContainer.js";
import { formatHexCompact } from "./firmwareLiteralPoolRegions.js";

export interface RawPoolLoadCandidate {
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

export interface RawIsaScanResult {
  readonly candidates: readonly RawPoolLoadCandidate[];
  readonly outOfImageTargets: number;
  readonly suppressedForwardOverlaps: number;
}

export const SCAN_COOPERATIVE_BYTE_STEP = 65_536;

/** Exact byte-granular bitset for 4-byte literal-pool slots across arbitrary base alignments. */
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

  markWord(poolOffset: number): void {
    this.markByte(poolOffset);
    this.markByte(poolOffset + 1);
    this.markByte(poolOffset + 2);
    this.markByte(poolOffset + 3);
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

const resolvePoolSlot = (
  fileBytes: Uint8Array,
  baseAddress: number,
  poolAddrBig: bigint,
): { readonly poolOffset: number; readonly loadedValue: number } | null => {
  if ((poolAddrBig & 3n) !== 0n) return null;
  const relBig = poolAddrBig - BigInt(baseAddress >>> 0);
  if (relBig < 0n || relBig + 4n > BigInt(fileBytes.length)) return null;
  const poolOffset = Number(relBig);
  const loadedValue = readUint32At(fileBytes, poolOffset, true);
  if (loadedValue === undefined) return null;
  return { poolOffset, loadedValue };
};

const decodeThumb32LiteralLoad = (options: {
  readonly fileBytes: Uint8Array;
  readonly baseAddress: number;
  readonly off: number;
  readonly hw1: number;
  readonly hw2: number;
}): RawPoolLoadCandidate | "out_of_image" | null => {
  if (options.hw1 !== 0xf8df && options.hw1 !== 0xf85f) return null;
  const uAdd = options.hw1 === 0xf8df;
  const rt = (options.hw2 >>> 12) & 0x0f;
  const imm12 = options.hw2 & 0x0fff;
  const insnAddress = (options.baseAddress + options.off) >>> 0;
  const alignedPc = (BigInt(insnAddress) + 4n) & ~3n;
  const poolAddrBig = uAdd
    ? alignedPc + BigInt(imm12)
    : alignedPc - BigInt(imm12);
  const resolved = resolvePoolSlot(
    options.fileBytes,
    options.baseAddress,
    poolAddrBig,
  );
  if (resolved === null) return "out_of_image";
  const reg = ARM_REGISTERS[rt] ?? `r${String(rt)}`;
  const signedDisp = uAdd
    ? `#0x${imm12.toString(16)}`
    : `#-0x${imm12.toString(16)}`;
  return {
    insnOffset: options.off,
    insnSize: 4,
    insnAddress,
    mnemonic: "ldr.w",
    targetRegister: reg,
    disassembly: `ldr.w ${reg}, [pc, ${signedDisp}]`,
    poolOffset: resolved.poolOffset,
    poolAddress: Number(poolAddrBig),
    loadedValue: resolved.loadedValue,
  };
};

const decodeThumb16LiteralLoad = (options: {
  readonly fileBytes: Uint8Array;
  readonly baseAddress: number;
  readonly off: number;
  readonly hw1: number;
}): RawPoolLoadCandidate | "out_of_image" | null => {
  if ((options.hw1 & 0xf800) !== 0x4800) return null;
  const rt = (options.hw1 >>> 8) & 0x07;
  const immBytes = (options.hw1 & 0xff) * 4;
  const insnAddress = (options.baseAddress + options.off) >>> 0;
  const alignedPc = (BigInt(insnAddress) + 4n) & ~3n;
  const poolAddrBig = alignedPc + BigInt(immBytes);
  const resolved = resolvePoolSlot(
    options.fileBytes,
    options.baseAddress,
    poolAddrBig,
  );
  if (resolved === null) return "out_of_image";
  const reg = ARM_REGISTERS[rt] ?? `r${String(rt)}`;
  return {
    insnOffset: options.off,
    insnSize: 2,
    insnAddress,
    mnemonic: "ldr",
    targetRegister: reg,
    disassembly: `ldr ${reg}, [pc, #0x${immBytes.toString(16)}]`,
    poolOffset: resolved.poolOffset,
    poolAddress: Number(poolAddrBig),
    loadedValue: resolved.loadedValue,
  };
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
    const dec = decodeThumb32LiteralLoad({
      fileBytes,
      baseAddress,
      off,
      hw1,
      hw2,
    });
    return dec !== null && dec !== "out_of_image";
  }
  const dec16 = decodeThumb16LiteralLoad({ fileBytes, baseAddress, off, hw1 });
  return dec16 !== null && dec16 !== "out_of_image";
};

export function* collectThumbCandidatesSteps(
  fileBytes: Uint8Array,
  baseAddress: number,
  scanStart: number,
  scanEnd: number,
): Generator<"step", RawIsaScanResult, void> {
  const candidates: RawPoolLoadCandidate[] = [];
  const forwardPoolBytes = new PoolByteBitset(fileBytes.length);
  // not-an-allowance: tally of PC-relative literal loads targeting outside image bounds
  let outOfImageTargets = 0;
  // not-an-allowance: tally of forward pool-slot data halfwords suppressed from decoding
  let suppressedForwardOverlaps = 0;
  let off = scanStart;
  let nextYield = scanStart + SCAN_COOPERATIVE_BYTE_STEP;

  while (off + 2 <= scanEnd) {
    if (off >= nextYield) {
      yield "step";
      nextYield = off + SCAN_COOPERATIVE_BYTE_STEP;
    }
    if (forwardPoolBytes.hasByte(off)) {
      if (thumbPoolHalfwordLooksLikeLoad(fileBytes, baseAddress, off, scanEnd))
        suppressedForwardOverlaps += 1;
      off += 2;
      continue;
    }
    const hw1 = readUint16At(fileBytes, off, true);
    if (hw1 === undefined) break;

    if (hw1 >= 0xe800) {
      if (off + 4 > scanEnd) break;
      if (forwardPoolBytes.overlaps(off, 4)) {
        off += 2;
        continue;
      }
      const hw2 = readUint16At(fileBytes, off + 2, true);
      if (hw2 === undefined) break;
      const decoded = decodeThumb32LiteralLoad({
        fileBytes,
        baseAddress,
        off,
        hw1,
        hw2,
      });
      if (decoded === "out_of_image") {
        outOfImageTargets += 1;
      } else if (decoded !== null) {
        if (decoded.poolOffset >= off + 4) {
          forwardPoolBytes.markWord(decoded.poolOffset);
        }
        candidates.push(decoded);
      }
      off += 4;
      continue;
    }

    const decoded16 = decodeThumb16LiteralLoad({
      fileBytes,
      baseAddress,
      off,
      hw1,
    });
    if (decoded16 === "out_of_image") {
      outOfImageTargets += 1;
    } else if (decoded16 !== null) {
      if (decoded16.poolOffset >= off + 2) {
        forwardPoolBytes.markWord(decoded16.poolOffset);
      }
      candidates.push(decoded16);
    }
    off += 2;
  }

  return { candidates, outOfImageTargets, suppressedForwardOverlaps };
}

const decodeA32LiteralWord = (
  fileBytes: Uint8Array,
  baseAddress: number,
  off: number,
): RawPoolLoadCandidate | "out_of_image" | null => {
  const word = readUint32At(fileBytes, off, true);
  if (word === undefined) return null;
  const cond = (word >>> 28) & 0x0f;
  if (cond === 0x0f || (word & 0x0f7f_0000) !== 0x051f_0000) return null;

  const uAdd = (word & 0x0080_0000) !== 0;
  const rd = (word >>> 12) & 0x0f;
  const imm12 = word & 0x0fff;
  const insnAddress = (baseAddress + off) >>> 0;
  const poolAddrBig =
    BigInt(insnAddress) + 8n + (uAdd ? BigInt(imm12) : -BigInt(imm12));
  const resolved = resolvePoolSlot(fileBytes, baseAddress, poolAddrBig);
  if (resolved === null) return "out_of_image";
  const reg = ARM_REGISTERS[rd] ?? `r${String(rd)}`;
  const condText = A32_COND_SUFFIX[cond] ?? "";
  const signedDisp = uAdd
    ? `#0x${imm12.toString(16)}`
    : `#-0x${imm12.toString(16)}`;
  return {
    insnOffset: off,
    insnSize: 4,
    insnAddress,
    mnemonic: "ldr",
    targetRegister: reg,
    disassembly: `ldr${condText} ${reg}, [pc, ${signedDisp}]`,
    poolOffset: resolved.poolOffset,
    poolAddress: Number(poolAddrBig),
    loadedValue: resolved.loadedValue,
  };
};

export function* collectA32CandidatesSteps(
  fileBytes: Uint8Array,
  baseAddress: number,
  scanStart: number,
  scanEnd: number,
): Generator<"step", RawIsaScanResult, void> {
  const candidates: RawPoolLoadCandidate[] = [];
  const forwardPoolBytes = new PoolByteBitset(fileBytes.length);
  // not-an-allowance: tally of PC-relative literal loads targeting outside image bounds
  let outOfImageTargets = 0;
  // not-an-allowance: tally of forward pool-slot data words suppressed from decoding
  let suppressedForwardOverlaps = 0;
  let nextYield = scanStart + SCAN_COOPERATIVE_BYTE_STEP;

  for (let off = scanStart; off + 4 <= scanEnd; off += 4) {
    if (off >= nextYield) {
      yield "step";
      nextYield = off + SCAN_COOPERATIVE_BYTE_STEP;
    }
    const decoded = decodeA32LiteralWord(fileBytes, baseAddress, off);
    if (forwardPoolBytes.overlaps(off, 4)) {
      if (decoded !== null && decoded !== "out_of_image") {
        suppressedForwardOverlaps += 1;
      }
      continue;
    }
    if (decoded === "out_of_image") {
      outOfImageTargets += 1;
      continue;
    }
    if (decoded === null) continue;
    if (decoded.poolOffset >= off + 4) {
      forwardPoolBytes.markWord(decoded.poolOffset);
    }
    candidates.push(decoded);
  }

  return { candidates, outOfImageTargets, suppressedForwardOverlaps };
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

const decodeXtensaL32rAt = (
  fileBytes: Uint8Array,
  baseAddress: number,
  off: number,
  scanEnd: number,
): RawPoolLoadCandidate | "out_of_image" | null => {
  const b0 = fileBytes[off]!;
  if ((b0 & 0x0f) !== 0x01 || off + 3 > scanEnd) return null;
  const at = (b0 >>> 4) & 0x0f;
  const offset16 = fileBytes[off + 1]! | (fileBytes[off + 2]! << 8);
  const signedWords = offset16 - 0x1_0000;
  const insnAddress = (baseAddress + off) >>> 0;
  const alignedPc = (BigInt(insnAddress) + 3n) & ~3n;
  const poolAddrBig = alignedPc + BigInt(signedWords) * 4n;
  const resolved = resolvePoolSlot(fileBytes, baseAddress, poolAddrBig);
  if (resolved === null || resolved.poolOffset + 4 > off) {
    return "out_of_image";
  }
  const reg = `a${String(at)}`;
  const poolAddrNum = Number(poolAddrBig);
  return {
    insnOffset: off,
    insnSize: 3,
    insnAddress,
    mnemonic: "l32r",
    targetRegister: reg,
    disassembly: `l32r ${reg}, ${formatHexCompact(poolAddrNum)}`,
    poolOffset: resolved.poolOffset,
    poolAddress: poolAddrNum,
    loadedValue: resolved.loadedValue,
  };
};

interface XtensaStepOutcome {
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
      nextOff: nextMappedAlign4Offset(baseAddress, off),
      invalidEncoding: true,
    };
  }
  if (op0 >= 0x08) {
    const b1 = fileBytes[off + 1]!;
    const isNarrowRet = (b0 === 0x0d || b0 === 0x1d) && b1 === 0xf0;
    return {
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
  if (off + 3 > scanEnd) return { nextOff: "stop", invalidEncoding: false };
  const b1 = fileBytes[off + 1]!;
  const b2 = fileBytes[off + 2]!;
  if (b0 === 0x00 && b1 === 0x00 && b2 === 0x00) {
    return {
      nextOff: nextMappedAlign4Offset(baseAddress, off),
      invalidEncoding: true,
    };
  }
  const isWideRet = (b0 === 0x80 || b0 === 0x90) && b1 === 0x00 && b2 === 0x00;
  return {
    nextOff: isWideRet
      ? skipZeroPaddingToMappedAlign4(fileBytes, baseAddress, off + 3, scanEnd)
      : off + 3,
    invalidEncoding: false,
  };
};

interface PendingAlignedTrace {
  readonly alignedOff: number;
  readonly candidates: readonly RawPoolLoadCandidate[];
  readonly nearInvalid: boolean;
}

const filterSelfConsistentXtensaPools = (
  candidates: readonly RawPoolLoadCandidate[],
  byteLength: number,
): PoolByteBitset => {
  const allTargets = new PoolByteBitset(byteLength);
  for (const c of candidates) allTargets.markWord(c.poolOffset);
  const confirmed = new PoolByteBitset(byteLength);
  for (const c of candidates) {
    if (!allTargets.overlaps(c.insnOffset, c.insnSize)) {
      confirmed.markWord(c.poolOffset);
    }
  }
  return confirmed;
};

function* discoverXtensaPoolBytesSteps(
  fileBytes: Uint8Array,
  baseAddress: number,
  scanStart: number,
  scanEnd: number,
): Generator<"step", PoolByteBitset, void> {
  const visited = new PoolByteBitset(fileBytes.length);
  const invalidBytes = new PoolByteBitset(fileBytes.length);
  const accepted: RawPoolLoadCandidate[] = [];
  let off = scanStart;
  let nextYield = scanStart + SCAN_COOPERATIVE_BYTE_STEP;

  while (off + 2 <= scanEnd) {
    if (off >= nextYield) {
      yield "step";
      nextYield = off + SCAN_COOPERATIVE_BYTE_STEP;
    }
    visited.markByte(off);
    const l32r = decodeXtensaL32rAt(fileBytes, baseAddress, off, scanEnd);
    if (l32r !== null && l32r !== "out_of_image") accepted.push(l32r);
    const step = stepXtensaRaw(fileBytes, baseAddress, off, scanEnd);
    if (step.invalidEncoding) invalidBytes.markByte(off);
    if (step.nextOff === "stop") break;
    off = step.nextOff;
  }

  const pendingTraces: PendingAlignedTrace[] = [];
  const firstRem = ((baseAddress >>> 0) + scanStart) & 3;
  const firstAligned = firstRem === 0 ? scanStart : scanStart + (4 - firstRem);
  nextYield = firstAligned + SCAN_COOPERATIVE_BYTE_STEP;

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
    const traceCands: RawPoolLoadCandidate[] = [];
    let cursor = alignedOff;
    let hitInvalid = false;
    while (cursor + 2 <= scanEnd && !visited.hasByte(cursor)) {
      visited.markByte(cursor);
      const l32r = decodeXtensaL32rAt(fileBytes, baseAddress, cursor, scanEnd);
      if (l32r !== null && l32r !== "out_of_image") traceCands.push(l32r);
      const step = stepXtensaRaw(fileBytes, baseAddress, cursor, scanEnd);
      if (step.invalidEncoding) {
        hitInvalid = true;
        break;
      }
      if (step.nextOff === "stop") break;
      cursor = step.nextOff;
    }
    if (hitInvalid || traceCands.length === 0) continue;
    const nearInvalid = invalidBytes.overlaps(
      Math.max(scanStart, alignedOff - 4),
      8,
    );
    pendingTraces.push({ alignedOff, candidates: traceCands, nearInvalid });
  }

  const knownPoolOffsets = new Set<number>(accepted.map((c) => c.poolOffset));
  for (const trace of pendingTraces) {
    const precedesKnownPool = alignedPrecededByPool(
      trace.alignedOff,
      trace.candidates,
      knownPoolOffsets,
    );
    if (trace.nearInvalid || precedesKnownPool) {
      for (const c of trace.candidates) {
        accepted.push(c);
        knownPoolOffsets.add(c.poolOffset);
      }
    }
  }

  return filterSelfConsistentXtensaPools(accepted, fileBytes.length);
}

const alignedPrecededByPool = (
  alignedOff: number,
  traceCands: readonly RawPoolLoadCandidate[],
  knownPoolOffsets: ReadonlySet<number>,
): boolean => {
  if (alignedOff < 4) return false;
  const prevWord = alignedOff - 4;
  if (knownPoolOffsets.has(prevWord)) return true;
  return traceCands.some((c) => c.poolOffset === prevWord);
};

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
  const candidates: RawPoolLoadCandidate[] = [];
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
        const fake = decodeXtensaL32rAt(fileBytes, baseAddress, pos, scanEnd);
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

    const l32r = decodeXtensaL32rAt(fileBytes, baseAddress, off, scanEnd);
    if (l32r === "out_of_image") {
      outOfImageTargets += 1;
    } else if (l32r !== null) {
      candidates.push(l32r);
    }

    const step = stepXtensaRaw(fileBytes, baseAddress, off, scanEnd);
    if (step.nextOff === "stop") break;
    off = step.nextOff;
  }

  return { candidates, outOfImageTargets, suppressedForwardOverlaps };
}
