import { BinaryReader } from "../binaryContainer.js";
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

/** Fixed byte widths of Apple's section and section_64 records. */
export const machoSectionHeaderSize = (wide: boolean): 68 | 80 =>
  wide ? 80 : 68;

/** Fixed section/section_64 facts; callers own mapping and display policies. */
export const readMachoSectionHeader = (
  bytes: Uint8Array,
  wide: boolean,
  littleEndian: boolean,
): Result<
  MachoSectionHeader,
  { readonly kind: "malformed"; readonly message: string }
> => {
  if (bytes.byteLength < machoSectionHeaderSize(wide))
    return err({
      kind: "malformed",
      message: "Mach-O section header is truncated",
    });
  const reader = new BinaryReader(
    Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    littleEndian,
    "macho",
  );
  const bits = wide ? 64 : 32;
  return ok({
    nameBytes: Buffer.from(reader.range(0, 16, "Mach-O section name")),
    segmentNameBytes: Buffer.from(
      reader.range(16, 16, "Mach-O section segment name"),
    ),
    address: reader.word(32, bits),
    size: reader.word(wide ? 40 : 36, bits),
    offset: reader.u32(wide ? 48 : 40),
    relocationOffset: reader.u32(wide ? 56 : 48),
    relocationCount: reader.u32(wide ? 60 : 52),
    flags: reader.u32(wide ? 64 : 56),
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
