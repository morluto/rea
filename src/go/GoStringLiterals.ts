import { isUtf8 } from "node:buffer";
import {
  DEFAULT_MAX_GO_STRING_LITERALS,
  MAX_GO_STRING_AGGREGATE_BYTES,
  MAX_GO_STRING_HEADER_SCAN_BYTES,
  MAX_GO_STRING_LITERAL_BYTES,
  type GoStringLiteral,
  type GoStringLiterals,
} from "../domain/go/goBinary.js";
import {
  BinaryMappingFailure,
  createFileMappingIndex,
  imageFileMappings,
  type BinaryContainer,
  type FileMapping,
  type FileMappingIndex,
} from "../native/metadata/BinaryContainer.js";

const MAX_TRACKED_CANDIDATES = 100_000;
const PE_MEM_READ = 0x40000000;
const PE_MEM_EXECUTE = 0x20000000;
const PE_MEM_DISCARDABLE = 0x02000000;
const PE_CNT_CODE = 0x00000020;
const PE_CNT_INITIALIZED_DATA = 0x00000040;
const MACHO_ATTR_INSTRUCTIONS = 0x80000400;
const MACHO_ATTR_DEBUG = 0x02000000;
const DISALLOWED_GO_STRING_CODE_POINT =
  /(?![\t\n\r])[\p{Cc}\p{Cs}\p{Co}\p{Cn}]/u;

interface CandidateLiteral {
  readonly offset: number;
  readonly bytes: number;
  readonly firstHeaderOffset: number;
  referenceCount: number;
}

/**
 * Recover bounded printable UTF-8 Go string literals referenced by word-aligned
 * static `(ptr, len)` pairs in non-executable mapped data.
 */
export const recoverGoStringLiterals = (
  bytes: Buffer,
  container: BinaryContainer,
  maxItems: number = DEFAULT_MAX_GO_STRING_LITERALS,
  checkActive?: () => void,
): GoStringLiterals => {
  const index = createFileMappingIndex(
    imageFileMappings(container),
    container.zero_fills,
  );
  const targets = selectTargetSpans(bytes, container, index);
  const headerSpans = selectHeaderScanSpans(bytes, container, index);
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
  const wordWidth = BigInt(wordBytes);
  const firstTarget = targets[0] as FileMapping;
  const lastTarget = targets[targets.length - 1] as FileMapping;
  const minTargetAddr = firstTarget.address;
  const maxTargetEnd = lastTarget.address + BigInt(lastTarget.size);

  const seen = new Map<number, CandidateLiteral | null>();
  const candidates: CandidateLiteral[] = [];
  let remainingBudget = MAX_GO_STRING_HEADER_SCAN_BYTES;
  let budgetTruncated = false;
  let steps = 0;

  outer: for (const span of headerSpans) {
    const misalign = Number(
      (wordWidth - (span.address % wordWidth)) % wordWidth,
    );
    const startOffset = span.offset + misalign;
    const spanEnd = span.offset + span.size;
    if (spanEnd - startOffset < wordBytes * 2) continue;
    const alignedEnd =
      startOffset + Math.floor((spanEnd - startOffset) / wordBytes) * wordBytes;
    if (remainingBudget < wordBytes * 2) {
      budgetTruncated = true;
      break;
    }
    remainingBudget -= wordBytes;
    let word0 = readWord(bytes, startOffset, bits, little);

    for (
      let headerOffset = startOffset;
      headerOffset + wordBytes * 2 <= alignedEnd;
      headerOffset += wordBytes
    ) {
      if ((++steps & 0xffff) === 0) checkActive?.();
      if (remainingBudget < wordBytes) {
        budgetTruncated = true;
        break outer;
      }
      remainingBudget -= wordBytes;
      const word1 = readWord(bytes, headerOffset + wordBytes, bits, little);
      const ptr = word0;
      const rawLen = word1;
      word0 = word1;

      if (rawLen < 1n || rawLen > BigInt(MAX_GO_STRING_LITERAL_BYTES)) continue;
      if (ptr < minTargetAddr || ptr >= maxTargetEnd) continue;
      const targetIndex = lastSpanAtOrBelow(targets, ptr);
      if (targetIndex < 0) continue;
      const target = targets[targetIndex] as FileMapping;
      if (ptr + rawLen > target.address + BigInt(target.size)) continue;

      const byteLen = Number(rawLen);
      const sliceOffset = target.offset + Number(ptr - target.address);
      if (
        headerOffset < sliceOffset + byteLen &&
        sliceOffset < headerOffset + wordBytes * 2
      )
        continue;

      const key = sliceOffset * 8192 + byteLen;
      if (seen.has(key)) {
        const existing = seen.get(key);
        if (existing !== null && existing !== undefined)
          existing.referenceCount += 1;
        continue;
      }

      if (candidates.length >= MAX_TRACKED_CANDIDATES) {
        budgetTruncated = true;
        break outer;
      }
      if (remainingBudget < byteLen) {
        budgetTruncated = true;
        break outer;
      }
      remainingBudget -= byteLen;

      const slice = bytes.subarray(sliceOffset, sliceOffset + byteLen);
      if (!isPrintableGoUtf8(slice)) {
        seen.set(key, null);
        continue;
      }
      const entry: CandidateLiteral = {
        offset: sliceOffset,
        bytes: byteLen,
        firstHeaderOffset: headerOffset,
        referenceCount: 1,
      };
      seen.set(key, entry);
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
      aggregateBytes + candidate.bytes > MAX_GO_STRING_AGGREGATE_BYTES
    ) {
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

const hasReadableLoadRegion = (
  container: BinaryContainer,
  address: bigint,
  size: number,
): boolean => {
  const end = address + BigInt(size);
  return (container.load_regions ?? []).some(
    (region) =>
      region.read &&
      region.mapping.address <= address &&
      end <= region.mapping.address + BigInt(region.mapping.size),
  );
};

/**
 * Retain read-only non-executable mapped spans without merging distinct sections,
 * so `[ptr, ptr + len)` cannot cross section boundaries.
 */
const selectTargetSpans = (
  bytes: Buffer,
  container: BinaryContainer,
  index: FileMappingIndex,
): readonly FileMapping[] => {
  const raw: FileMapping[] = [];
  if (container.sections.length > 0) {
    for (const section of container.sections) {
      if (!section.read_only) continue;
      if (
        section.format === "pe" &&
        (section.characteristics & PE_MEM_DISCARDABLE) !== 0
      )
        continue;
      if (
        section.format === "macho" &&
        (section.flags & MACHO_ATTR_DEBUG) !== 0
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
): readonly FileMapping[] => {
  const wordWidth = BigInt(container.bits === 64 ? 8 : 4);
  const seen = new Set<string>();
  const spans: FileMapping[] = [];
  const push = (address: bigint, offset: number, size: number): void => {
    const admitted = admitMappedSpan(
      bytes,
      container,
      index,
      address,
      offset,
      size,
    );
    if (admitted === null) return;
    const identity = `${admitted.offset}:${admitted.size}:${admitted.address % wordWidth}`;
    if (seen.has(identity)) return;
    seen.add(identity);
    spans.push(admitted);
  };

  for (const section of container.sections) {
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
        !hasReadableLoadRegion(container, section.address, section.size)
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
      if (!region.read || region.execute) continue;
      push(region.mapping.address, region.mapping.offset, region.mapping.size);
    }
  } else if (
    container.format === "elf" &&
    container.section_names_limitation !== undefined
  ) {
    for (const region of container.load_regions ?? []) {
      if (!region.read || !region.write || region.execute) continue;
      push(region.mapping.address, region.mapping.offset, region.mapping.size);
    }
  }

  return spans;
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
