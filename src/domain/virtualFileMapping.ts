import { err, ok, type Result } from "./result.js";

/** One file-backed virtual range; addresses stay exact until mapped to file offsets. */
export interface FileMapping {
  readonly address: bigint;
  readonly offset: number;
  readonly size: number;
}

/** Declared zero-initialized virtual memory with no corresponding file bytes. */
export interface ZeroFillMapping {
  readonly address: bigint;
  readonly size: bigint;
}

/** Why a declared virtual span does not establish one contiguous file span. */
export interface VirtualFileMappingFailure {
  readonly reason: "invalid-size" | "unmapped" | "ambiguous";
  readonly message: string;
}

/** Map a physically contiguous virtual span across consistent adjacent ranges. */
export const resolveMappedFileOffset = (
  mappings: readonly FileMapping[],
  address: bigint,
  size: number,
  zeroFills: readonly ZeroFillMapping[] = [],
): Result<number, VirtualFileMappingFailure> => {
  if (!Number.isSafeInteger(size) || size < 0)
    return err({
      reason: "invalid-size",
      message: "Virtual span size is invalid",
    });
  const end = address + BigInt(size);
  let found: number | undefined;
  const covered: { start: bigint; end: bigint }[] = [];
  let whollyCovered = size === 0;
  for (const mapping of mappings) {
    const mappingEnd = mapping.address + BigInt(mapping.size);
    const start = address > mapping.address ? address : mapping.address;
    const overlapEnd = end < mappingEnd ? end : mappingEnd;
    if (
      size === 0
        ? address < mapping.address || address > mappingEnd
        : start >= overlapEnd
    )
      continue;
    const origin = mapping.offset + Number(address - mapping.address);
    if (found !== undefined && found !== origin)
      return err({
        reason: "ambiguous",
        message: "Virtual span has ambiguous or noncontiguous file mappings",
      });
    found = origin;
    if (start === address && overlapEnd === end) whollyCovered = true;
    else if (!whollyCovered) covered.push({ start, end: overlapEnd });
  }
  if (found === undefined)
    return err({
      reason: "unmapped",
      message: "Virtual address or string range is not file mapped",
    });
  if (!whollyCovered) {
    covered.sort((left, right) =>
      left.start < right.start ? -1 : left.start > right.start ? 1 : 0,
    );
    let cursor = address;
    for (const span of covered) {
      if (span.start > cursor)
        return err({
          reason: "unmapped",
          message: "Virtual address or string range is not file mapped",
        });
      if (span.end > cursor) cursor = span.end;
    }
    if (cursor < end)
      return err({
        reason: "unmapped",
        message: "Virtual address or string range is not file mapped",
      });
  }
  for (const zeroFill of zeroFills) {
    if (spansOverlap(address, BigInt(size), zeroFill.address, zeroFill.size))
      return err({
        reason: "ambiguous",
        message: "Virtual address has ambiguous file and zero-fill mappings",
      });
  }
  return ok(found);
};

const spansOverlap = (
  address: bigint,
  size: bigint,
  otherAddress: bigint,
  otherSize: bigint,
): boolean =>
  size > 0n &&
  otherSize > 0n &&
  address < otherAddress + otherSize &&
  otherAddress < address + size;
