import { err, ok, type Result } from "../result.js";

export interface MachoSectionHeader {
  readonly nameBytes: Buffer;
  readonly segmentNameBytes: Buffer;
  readonly address: bigint;
  readonly size: bigint;
  readonly offset: number;
  /** `reloff` and `nreloc`: the section's own relocation entries, used by object files. */
  readonly relocationOffset: number;
  readonly relocationCount: number;
  readonly flags: number;
}

/** Fixed section/section_64 facts; callers own mapping and display policies. */
export const readMachoSectionHeader = (
  bytes: Uint8Array,
  wide: boolean,
  littleEndian: boolean,
): Result<
  MachoSectionHeader,
  { readonly kind: "malformed"; readonly message: string }
> => {
  if (bytes.byteLength < (wide ? 80 : 68))
    return err({
      kind: "malformed",
      message: "Mach-O section header is truncated",
    });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return ok({
    nameBytes: Buffer.from(bytes.subarray(0, 16)),
    segmentNameBytes: Buffer.from(bytes.subarray(16, 32)),
    address: wide
      ? view.getBigUint64(32, littleEndian)
      : BigInt(view.getUint32(32, littleEndian)),
    size: wide
      ? view.getBigUint64(40, littleEndian)
      : BigInt(view.getUint32(36, littleEndian)),
    offset: view.getUint32(wide ? 48 : 40, littleEndian),
    relocationOffset: view.getUint32(wide ? 56 : 48, littleEndian),
    relocationCount: view.getUint32(wide ? 60 : 52, littleEndian),
    flags: view.getUint32(wide ? 64 : 56, littleEndian),
  });
};

/** S_ZEROFILL, S_GB_ZEROFILL and S_THREAD_LOCAL_ZEROFILL sections own no file bytes. */
export const isMachoZeroFillSection = (flags: number): boolean =>
  [1, 0xc, 0x12].includes(flags & 0xff);

type SectionExtent = Pick<
  MachoSectionHeader,
  "address" | "size" | "offset" | "flags"
>;

interface SegmentExtent {
  readonly address: bigint;
  readonly memorySize: bigint;
  readonly fileOffset: bigint;
  readonly fileSize: bigint;
}

const extentContains = (size: bigint, extentSize: bigint, delta: bigint) =>
  delta >= 0n && delta <= extentSize && size <= extentSize - delta;

/** File and virtual backing within the enclosing segment. Callers also check image bounds. */
export const machoSectionBacking = (
  section: SectionExtent,
  segment: SegmentExtent,
) => {
  const { size } = section;
  const zeroFill = isMachoZeroFillSection(section.flags);
  const inSegmentFile = extentContains(
    size,
    segment.fileSize,
    BigInt(section.offset) - segment.fileOffset,
  );
  const inSegmentMemory = extentContains(
    size,
    segment.memorySize,
    section.address - segment.address,
  );
  // An out-of-range virtual address can still have bytes on disk.
  return {
    onDisk: !zeroFill && inSegmentFile,
    issue: zeroFill
      ? "is zero-fill"
      : !inSegmentMemory
        ? "exceeds its segment's virtual extent"
        : !inSegmentFile
          ? "exceeds its segment's file extent"
          : null,
  } as const;
};

/** Admit a section's declared payload against the image that holds it. */
export const admitMachoSectionPayload = (
  section: Pick<MachoSectionHeader, "size" | "offset" | "flags">,
  imageBytes: number,
): Result<null, { readonly kind: "malformed"; readonly message: string }> =>
  section.size === 0n ||
  isMachoZeroFillSection(section.flags) ||
  (section.offset <= imageBytes &&
    section.size <= BigInt(imageBytes - section.offset))
    ? ok(null)
    : err({
        kind: "malformed",
        message: "Mach-O section payload is outside the file",
      });
