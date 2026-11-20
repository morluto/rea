import { BinaryReader } from "../binaryContainer.js";
import { machoSectionHeaderSize } from "./machoSectionHeader.js";
import { err, ok } from "../result.js";

const SG_HIGHVM = 0x1;

/** Fixed byte widths of Apple's segment_command and segment_command_64 records. */
export const machoSegmentHeaderSize = (wide: boolean): 56 | 72 =>
  wide ? 72 : 56;

/** Decode a fixed LC_SEGMENT/LC_SEGMENT_64 record; callers own command and mapping admission. */
export const readMachoSegmentHeader = (
  bytes: Uint8Array,
  wide: boolean,
  littleEndian: boolean,
) => {
  const headerSize = machoSegmentHeaderSize(wide);
  if (bytes.byteLength < headerSize)
    return err({
      kind: "malformed" as const,
      message: "Mach-O segment header is truncated",
    });
  const reader = new BinaryReader(
    Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    littleEndian,
    "macho",
  );
  const bits = wide ? 64 : 32;
  return ok({
    headerSize,
    nameBytes: Buffer.from(reader.range(8, 16, "Mach-O segment name")),
    address: reader.word(24, bits),
    memorySize: reader.word(wide ? 32 : 28, bits),
    fileOffset: reader.word(wide ? 40 : 32, bits),
    fileSize: reader.word(wide ? 48 : 36, bits),
    maxProtection: reader.u32(wide ? 56 : 40),
    protection: reader.u32(wide ? 60 : 44),
    sectionCount: reader.u32(wide ? 64 : 48),
    flags: reader.u32(wide ? 68 : 52),
  });
};

/** Admit VM extents and locate the file-backed and zero-filled spans. */
export const admitMachoSegmentMapping = (
  segment: {
    readonly address: bigint;
    readonly memorySize: bigint;
    readonly fileSize: bigint;
    readonly protection: number;
    readonly flags: number;
  },
  bits: 32 | 64,
) => {
  const { address, memorySize, fileSize, protection, flags } = segment;
  const unmapped = memorySize === 0n && protection === 0;
  if (
    (!unmapped && fileSize > memorySize) ||
    address + memorySize > 1n << BigInt(bits)
  )
    return err({
      kind: "malformed" as const,
      message: "Mach-O segment addresses or sizes are invalid",
    });
  const zeroFillSize = memorySize - fileSize;
  // SG_HIGHVM places the file bytes above, rather than below, the zero-fill.
  const leadingZeroFill =
    fileSize > 0n && zeroFillSize > 0n && (flags & SG_HIGHVM) !== 0;
  return ok({
    unmapped,
    fileAddress: leadingZeroFill ? address + zeroFillSize : address,
    zeroFill:
      zeroFillSize > 0n
        ? {
            address: leadingZeroFill ? address : address + fileSize,
            size: zeroFillSize,
          }
        : null,
  });
};

/** Check that the segment's fixed sections fit inside its declared cmdsize. */
export const machoSegmentSectionTableFits = (
  segment: { readonly headerSize: number; readonly sectionCount: number },
  commandBytes: number,
  wide: boolean,
): boolean =>
  segment.sectionCount <=
  Math.floor(
    (commandBytes - segment.headerSize) / machoSectionHeaderSize(wide),
  );

/** Admit one segment command against its cmdsize and the image that holds it. */
export const admitMachoSegmentCommand = (
  segment: Parameters<typeof admitMachoSegmentMapping>[0] & {
    readonly headerSize: number;
    readonly sectionCount: number;
    readonly fileOffset: bigint;
  },
  commandBytes: number,
  bits: 32 | 64,
  imageBytes: number,
) => {
  const mapping = admitMachoSegmentMapping(segment, bits);
  if (!mapping.ok) return mapping;
  if (!machoSegmentSectionTableFits(segment, commandBytes, bits === 64))
    return err({
      kind: "malformed" as const,
      message: "Mach-O section table exceeds its segment command",
    });
  const image = BigInt(imageBytes);
  if (
    segment.fileSize !== 0n &&
    (segment.fileOffset > image ||
      segment.fileSize > image - segment.fileOffset)
  )
    return err({
      kind: "malformed" as const,
      message: "Mach-O segment range is outside the file",
    });
  return mapping;
};
