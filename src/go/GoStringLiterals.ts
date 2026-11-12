import type { FileMapping } from "../domain/virtualFileMapping.js";
import { isUtf8 } from "node:buffer";
import {
  GO_ANALYSIS_BUDGET_DEFAULTS,
  type GoAnalysisBudgets,
  type GoStringBudgetKey,
  type GoStringLiteral,
  type GoStringLiterals,
} from "../domain/go/goBinary.js";
import {
  BinaryMappingFailure,
  createFileMappingIndex,
  imageFileMappings,
  type BinaryContainer,
  type FileMappingIndex,
  type LoadRegion,
} from "../native/metadata/BinaryContainer.js";

const MAX_REJECTED_SLICE_CACHE = 4096;
const PE_MEM_READ = 0x40000000;
const PE_MEM_EXECUTE = 0x20000000;
const PE_MEM_DISCARDABLE = 0x02000000;
const PE_CNT_CODE = 0x00000020;
const PE_CNT_INITIALIZED_DATA = 0x00000040;
const MACHO_ATTR_INSTRUCTIONS = 0x80000400;
const MACHO_ATTR_DEBUG = 0x02000000;
const DISALLOWED_GO_STRING_CODE_POINT =
  /(?![\t\n\r\u200c\u200d])[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/u;

interface CandidateLiteral {
  readonly offset: number;
  readonly bytes: number;
  firstHeaderOffset: number;
  referenceCount: number;
}

interface HeaderScanSpan {
  readonly startOffset: number;
  readonly endOffset: number;
}

/**
 * Recover bounded printable UTF-8 Go string literals referenced by word-aligned
 * static `(ptr, len)` pairs in non-executable mapped data.
 */
export const recoverGoStringLiterals = (
  bytes: Buffer,
  container: BinaryContainer,
  budgets: GoAnalysisBudgets = GO_ANALYSIS_BUDGET_DEFAULTS,
  checkActive?: () => void,
): GoStringLiterals => {
  const limitsReached = new Set<GoStringBudgetKey>();
  const maxItems = budgets.max_string_literals;
  checkActive?.();
  const index = createFileMappingIndex(
    imageFileMappings(container),
    container.zero_fills,
  );
  checkActive?.();
  const readableRegions = createReadableLoadRegionIndex(
    container.load_regions,
    checkActive,
  );
  const targets = selectTargetSpans(
    bytes,
    container,
    index,
    readableRegions,
    checkActive,
  );
  const headerSpans = selectHeaderScanSpans(
    bytes,
    container,
    index,
    readableRegions,
    checkActive,
  );
  if (targets.length === 0 || headerSpans.length === 0)
    return {
      evidence_kind: "inferred",
      items: [],
      discovered_count: 0,
      aggregate_bytes: 0,
      max_items: maxItems,
      truncated: false,
    };

  const { bits } = container;
  const little = container.byte_order === "little";
  const wordBytes = bits === 64 ? 8 : 4;
  const firstTarget = targets[0] as FileMapping;
  const lastTarget = targets[targets.length - 1] as FileMapping;
  const minTargetAddr = firstTarget.address;
  const maxTargetEnd = lastTarget.address + BigInt(lastTarget.size);

  const accepted = new Map<string, CandidateLiteral>();
  const rejected = new Set<string>();
  const candidates: CandidateLiteral[] = [];
  let remainingBudget = budgets.max_string_header_scan_bytes;
  let budgetTruncated = false;
  let steps = 0;

  outer: for (const { startOffset, endOffset } of headerSpans) {
    if (remainingBudget < wordBytes * 2) {
      budgetTruncated = true;
      limitsReached.add("max_string_header_scan_bytes");
      break;
    }
    remainingBudget -= wordBytes;
    let word0 = readWord(bytes, startOffset, bits, little);

    for (
      let headerOffset = startOffset;
      headerOffset + wordBytes * 2 <= endOffset;
      headerOffset += wordBytes
    ) {
      if ((++steps & 0xffff) === 0) checkActive?.();
      if (remainingBudget < wordBytes) {
        budgetTruncated = true;
        limitsReached.add("max_string_header_scan_bytes");
        break outer;
      }
      remainingBudget -= wordBytes;
      const word1 = readWord(bytes, headerOffset + wordBytes, bits, little);
      const ptr = word0;
      const rawLen = word1;
      word0 = word1;

      if (rawLen < 1n) continue;
      if (ptr < minTargetAddr || ptr >= maxTargetEnd) continue;
      const targetIndex = lastSpanAtOrBelow(targets, ptr);
      if (targetIndex < 0) continue;
      const target = targets[targetIndex] as FileMapping;
      if (ptr + rawLen > target.address + BigInt(target.size)) continue;

      if (rawLen > BigInt(budgets.max_string_literal_bytes)) {
        limitsReached.add("max_string_literal_bytes");
        budgetTruncated = true;
        continue;
      }
      const byteLen = Number(rawLen);
      const sliceOffset = target.offset + Number(ptr - target.address);
      if (
        headerOffset < sliceOffset + byteLen &&
        sliceOffset < headerOffset + wordBytes * 2
      )
        continue;

      const key = `${String(sliceOffset)}:${String(byteLen)}`;
      const existing = accepted.get(key);
      if (existing !== undefined) {
        existing.referenceCount += 1;
        if (headerOffset < existing.firstHeaderOffset)
          existing.firstHeaderOffset = headerOffset;
        continue;
      }
      if (rejected.has(key)) continue;

      if (candidates.length >= budgets.max_string_candidates) {
        limitsReached.add("max_string_candidates");
        budgetTruncated = true;
        break outer;
      }
      if (remainingBudget < byteLen) {
        limitsReached.add("max_string_header_scan_bytes");
        budgetTruncated = true;
        break outer;
      }
      remainingBudget -= byteLen;

      const slice = bytes.subarray(sliceOffset, sliceOffset + byteLen);
      if (!isPrintableGoUtf8(slice)) {
        if (rejected.size >= MAX_REJECTED_SLICE_CACHE) rejected.clear();
        rejected.add(key);
        continue;
      }
      const entry: CandidateLiteral = {
        offset: sliceOffset,
        bytes: byteLen,
        firstHeaderOffset: headerOffset,
        referenceCount: 1,
      };
      accepted.set(key, entry);
      candidates.push(entry);
    }
  }

  checkActive?.();
  candidates.sort(
    (left, right) => left.offset - right.offset || left.bytes - right.bytes,
  );

  const items: GoStringLiteral[] = [];
  let aggregateBytes = 0;
  let outputTruncated = false;
  for (const candidate of candidates) {
    if (
      items.length >= maxItems ||
      aggregateBytes + candidate.bytes > budgets.max_string_bytes
    ) {
      limitsReached.add(
        items.length >= maxItems ? "max_string_literals" : "max_string_bytes",
      );
      outputTruncated = true;
      break;
    }
    items.push({
      value: bytes
        .subarray(candidate.offset, candidate.offset + candidate.bytes)
        .toString("utf8"),
      location: { offset: candidate.offset, bytes: candidate.bytes },
      first_header_offset: candidate.firstHeaderOffset,
      reference_count: candidate.referenceCount,
    });
    aggregateBytes += candidate.bytes;
  }

  return {
    evidence_kind: "inferred",
    items,
    discovered_count: candidates.length,
    aggregate_bytes: aggregateBytes,
    max_items: maxItems,
    truncated: budgetTruncated || outputTruncated,
    ...(limitsReached.size === 0 ? {} : { limits_reached: [...limitsReached] }),
  };
};

const readWord = (
  bytes: Buffer,
  offset: number,
  bits: 32 | 64,
  little: boolean,
): bigint =>
  bits === 32
    ? BigInt(little ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset))
    : little
      ? bytes.readBigUInt64LE(offset)
      : bytes.readBigUInt64BE(offset);

const isPrintableGoUtf8 = (slice: Buffer): boolean => {
  let hasNonAscii = false;
  for (const byte of slice) {
    if (byte >= 0x80) {
      hasNonAscii = true;
      continue;
    }
    if (
      (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) ||
      byte === 0x7f
    )
      return false;
  }
  if (!hasNonAscii) return true;
  if (!isUtf8(slice)) return false;
  return !DISALLOWED_GO_STRING_CODE_POINT.test(slice.toString("utf8"));
};

const admitMappedSpan = (
  bytes: Buffer,
  container: BinaryContainer,
  index: FileMappingIndex,
  address: bigint,
  offset: number,
  size: number,
): FileMapping | null => {
  if (
    size <= 0 ||
    offset < 0 ||
    offset > bytes.length ||
    size > bytes.length - offset ||
    address < 0n ||
    address + BigInt(size) > 1n << BigInt(container.bits)
  )
    return null;
  try {
    return index.offset(address, size) === offset
      ? { address, offset, size }
      : null;
  } catch (cause) {
    if (cause instanceof BinaryMappingFailure) return null;
    throw cause;
  }
};

interface ReadableLoadRegionIndex {
  readonly contains: (address: bigint, size: number) => boolean;
}

const createReadableLoadRegionIndex = (
  loadRegions: readonly LoadRegion[] | undefined,
  checkActive?: () => void,
): ReadableLoadRegionIndex => {
  if (loadRegions === undefined || loadRegions.length === 0)
    return { contains: () => false };
  const raw: { start: bigint; end: bigint }[] = [];
  let steps = 0;
  for (const region of loadRegions) {
    if ((++steps & 0x3ff) === 0) checkActive?.();
    if (!region.read || region.mapping.size <= 0) continue;
    raw.push({
      start: region.mapping.address,
      end: region.mapping.address + BigInt(region.mapping.size),
    });
  }
  if (raw.length === 0) return { contains: () => false };
  checkActive?.();
  raw.sort((left, right) =>
    left.start < right.start
      ? -1
      : left.start > right.start
        ? 1
        : left.end < right.end
          ? -1
          : left.end > right.end
            ? 1
            : 0,
  );
  const starts: bigint[] = [];
  const ends: bigint[] = [];
  let currentStart = (raw[0] as (typeof raw)[number]).start;
  let currentEnd = (raw[0] as (typeof raw)[number]).end;
  for (let index = 1; index < raw.length; index += 1) {
    if ((index & 0x3ff) === 0) checkActive?.();
    const span = raw[index] as (typeof raw)[number];
    if (span.start <= currentEnd) {
      if (span.end > currentEnd) currentEnd = span.end;
      continue;
    }
    starts.push(currentStart);
    ends.push(currentEnd);
    currentStart = span.start;
    currentEnd = span.end;
  }
  starts.push(currentStart);
  ends.push(currentEnd);
  return {
    contains: (address, size) => {
      if (size <= 0) return false;
      const index = lastBigIntAtOrBelow(starts, address);
      return index >= 0 && address + BigInt(size) <= (ends[index] as bigint);
    },
  };
};

/**
 * Retain read-only non-executable mapped spans without merging distinct sections,
 * so `[ptr, ptr + len)` cannot cross section boundaries.
 */
const selectTargetSpans = (
  bytes: Buffer,
  container: BinaryContainer,
  index: FileMappingIndex,
  readableRegions: ReadableLoadRegionIndex,
  checkActive?: () => void,
): readonly FileMapping[] => {
  const raw: FileMapping[] = [];
  let steps = 0;
  if (container.sections.length > 0) {
    for (const section of container.sections) {
      if ((++steps & 0x3ff) === 0) checkActive?.();
      if (!section.read_only) continue;
      if (
        section.format === "pe" &&
        (section.characteristics & PE_MEM_DISCARDABLE) !== 0
      )
        continue;
      if (
        section.format === "macho" &&
        (section.segment_unmapped ||
          (section.flags & MACHO_ATTR_DEBUG) !== 0 ||
          !readableRegions.contains(section.address, section.size))
      )
        continue;
      const address =
        section.format === "pe"
          ? (container.image_base ?? 0n) + BigInt(section.virtual_address)
          : section.address;
      const admitted = admitMappedSpan(
        bytes,
        container,
        index,
        address,
        section.offset,
        section.size,
      );
      if (admitted !== null) raw.push(admitted);
    }
  } else {
    for (const region of container.load_regions ?? []) {
      if ((++steps & 0x3ff) === 0) checkActive?.();
      if (!region.read || region.write || region.execute) continue;
      const admitted = admitMappedSpan(
        bytes,
        container,
        index,
        region.mapping.address,
        region.mapping.offset,
        region.mapping.size,
      );
      if (admitted !== null) raw.push(admitted);
    }
  }
  raw.sort((left, right) =>
    left.address < right.address
      ? -1
      : left.address > right.address
        ? 1
        : right.size - left.size,
  );
  const nonContained: FileMapping[] = [];
  let maxEnd = -1n;
  for (const span of raw) {
    if ((++steps & 0x3ff) === 0) checkActive?.();
    const end = span.address + BigInt(span.size);
    if (end <= maxEnd) continue;
    nonContained.push(span);
    maxEnd = end;
  }
  return nonContained;
};

/** Select non-executable initialized data spans that may store static `(ptr, len)` pairs. */
const selectHeaderScanSpans = (
  bytes: Buffer,
  container: BinaryContainer,
  index: FileMappingIndex,
  readableRegions: ReadableLoadRegionIndex,
  checkActive?: () => void,
): readonly HeaderScanSpan[] => {
  const spans: FileMapping[] = [];
  let steps = 0;
  const push = (address: bigint, offset: number, size: number): void => {
    const admitted = admitMappedSpan(
      bytes,
      container,
      index,
      address,
      offset,
      size,
    );
    if (admitted !== null) spans.push(admitted);
  };

  for (const section of container.sections) {
    if ((++steps & 0x3ff) === 0) checkActive?.();
    if (!section.file_backed || section.compressed) continue;
    if (section.format === "elf") {
      if (
        section.type !== 1 ||
        (section.flags & 2n) === 0n ||
        (section.flags & 4n) !== 0n
      )
        continue;
      push(section.address, section.offset, section.size);
      continue;
    }
    if (section.format === "macho") {
      if (
        section.segment_unmapped ||
        (section.flags & MACHO_ATTR_INSTRUCTIONS) !== 0 ||
        (section.flags & MACHO_ATTR_DEBUG) !== 0 ||
        !readableRegions.contains(section.address, section.size)
      )
        continue;
      push(section.address, section.offset, section.size);
      continue;
    }
    if (
      (section.characteristics & PE_MEM_READ) === 0 ||
      (section.characteristics & PE_MEM_EXECUTE) !== 0 ||
      (section.characteristics & PE_CNT_CODE) !== 0 ||
      (section.characteristics & PE_MEM_DISCARDABLE) !== 0 ||
      (section.characteristics & PE_CNT_INITIALIZED_DATA) === 0 ||
      container.image_base === undefined
    )
      continue;
    push(
      container.image_base + BigInt(section.virtual_address),
      section.offset,
      section.size,
    );
  }

  if (container.sections.length === 0) {
    for (const region of container.load_regions ?? []) {
      if ((++steps & 0x3ff) === 0) checkActive?.();
      if (!region.read || region.execute) continue;
      push(region.mapping.address, region.mapping.offset, region.mapping.size);
    }
  } else if (
    container.format === "elf" &&
    container.section_names_limitation !== undefined
  ) {
    for (const region of container.load_regions ?? []) {
      if ((++steps & 0x3ff) === 0) checkActive?.();
      if (!region.read || !region.write || region.execute) continue;
      push(region.mapping.address, region.mapping.offset, region.mapping.size);
    }
  }

  return normalizeHeaderScanSpans(
    spans,
    container.bits === 64 ? 8 : 4,
    checkActive,
  );
};

/**
 * Align candidate header spans to pointer-word boundaries, merge overlapping
 * same-phase intervals so physical headers are never counted twice, and sort
 * in ascending file-offset order so `first_header_offset` is minimal.
 */
const normalizeHeaderScanSpans = (
  spans: readonly FileMapping[],
  wordBytes: 4 | 8,
  checkActive?: () => void,
): readonly HeaderScanSpan[] => {
  const wordWidth = BigInt(wordBytes);
  const aligned: {
    startOffset: number;
    endOffset: number;
    readonly phase: number;
  }[] = [];
  let steps = 0;
  for (const span of spans) {
    if ((++steps & 0x3ff) === 0) checkActive?.();
    const misalign = Number(
      (wordWidth - (span.address % wordWidth)) % wordWidth,
    );
    const startOffset = span.offset + misalign;
    const spanEnd = span.offset + span.size;
    if (spanEnd - startOffset < wordBytes * 2) continue;
    const endOffset =
      startOffset + Math.floor((spanEnd - startOffset) / wordBytes) * wordBytes;
    aligned.push({
      startOffset,
      endOffset,
      phase: startOffset % wordBytes,
    });
  }
  if (aligned.length === 0) return [];
  aligned.sort(
    (left, right) =>
      left.phase - right.phase ||
      left.startOffset - right.startOffset ||
      right.endOffset - left.endOffset,
  );
  const merged: HeaderScanSpan[] = [];
  let current = aligned[0] as (typeof aligned)[number];
  for (let index = 1; index < aligned.length; index += 1) {
    if ((++steps & 0x3ff) === 0) checkActive?.();
    const next = aligned[index] as (typeof aligned)[number];
    if (next.phase === current.phase && next.startOffset < current.endOffset) {
      if (next.endOffset > current.endOffset)
        current = { ...current, endOffset: next.endOffset };
      continue;
    }
    merged.push({
      startOffset: current.startOffset,
      endOffset: current.endOffset,
    });
    current = next;
  }
  merged.push({
    startOffset: current.startOffset,
    endOffset: current.endOffset,
  });
  merged.sort(
    (left, right) =>
      left.startOffset - right.startOffset || left.endOffset - right.endOffset,
  );
  return merged;
};

const lastBigIntAtOrBelow = (
  sorted: readonly bigint[],
  value: bigint,
): number => {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((sorted[middle] as bigint) <= value) low = middle + 1;
    else high = middle;
  }
  return low - 1;
};

const lastSpanAtOrBelow = (
  sorted: readonly FileMapping[],
  address: bigint,
): number => {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((sorted[middle] as FileMapping).address <= address) low = middle + 1;
    else high = middle;
  }
  return low - 1;
};
