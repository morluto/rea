import { BinaryFormatFailure, BinaryReader } from "../binaryContainer.js";
import type { Devicetree } from "./devicetree.js";

export const FDT_MAX_HEADER_BYTES = 40;
const FDT_MAGIC = 0xd00dfeed;

const malformed = (detail: string): never => {
  throw new BinaryFormatFailure("malformed", detail);
};

export const hasDevicetreeMagic = (prefix: Buffer): boolean =>
  prefix.length >= 4 &&
  new BinaryReader(prefix, false, "devicetree").u32(0) === FDT_MAGIC;

type DevicetreeHeader = Devicetree["header"];

/** Decode header facts even when only a prefix of the blob has been loaded. */
export const readDevicetreeHeader = (
  bytes: Buffer,
): {
  header: DevicetreeHeader;
  structureEnd: number;
  reservationEnd: number;
} => {
  if (bytes.length < 28)
    throw new BinaryFormatFailure("malformed", "Truncated FDT header");
  const reader = new BinaryReader(bytes, false, "devicetree");
  const magic = reader.u32(0);
  if (magic !== FDT_MAGIC)
    throw new BinaryFormatFailure(
      "unsupported",
      "Not a flattened devicetree blob",
    );
  const version = reader.u32(20);
  const lastCompatibleVersion = reader.u32(24);
  // DTSpec 5.1: a later version backwards compatible with version 17 is read
  // with the version 17 header.
  if (version < 16 || (version > 17 && lastCompatibleVersion > 17))
    throw new BinaryFormatFailure(
      "unsupported",
      `FDT version ${version} with last_comp_version ${lastCompatibleVersion} is unsupported; supported versions are 16, 17 and later versions backwards compatible with 17`,
    );
  const headerBytes = version >= 17 ? FDT_MAX_HEADER_BYTES : 36;
  if (bytes.length < headerBytes)
    throw new BinaryFormatFailure("malformed", "Truncated FDT header");
  const header: DevicetreeHeader = {
    magic,
    totalsize: reader.u32(4),
    off_dt_struct: reader.u32(8),
    off_dt_strings: reader.u32(12),
    off_mem_rsvmap: reader.u32(16),
    version,
    last_comp_version: lastCompatibleVersion,
    boot_cpuid_phys: reader.u32(28),
    size_dt_strings: reader.u32(32),
    size_dt_struct: version >= 17 ? reader.u32(36) : null,
  };
  if (header.totalsize < headerBytes || header.last_comp_version > version)
    throw new BinaryFormatFailure(
      "malformed",
      "Invalid FDT header size or compatibility version",
    );

  // v16 has no structure size. Its scan stops at the next occupied block.
  const structureEnd =
    header.size_dt_struct === null
      ? Math.min(
          header.totalsize,
          ...[
            ...(header.size_dt_strings > 0 ? [header.off_dt_strings] : []),
            header.off_mem_rsvmap,
          ].filter((offset) => offset > header.off_dt_struct),
        )
      : header.off_dt_struct + header.size_dt_struct;
  const ranges: { start: number; end: number }[] = [
    { start: 0, end: headerBytes },
  ];
  const range = (start: number, size: number) => {
    if (
      size < 0 ||
      (size > 0 && start < headerBytes) ||
      start > header.totalsize - size
    )
      malformed("FDT block outside totalsize");
    // An empty extent occupies no bytes and cannot overlap another block.
    if (size === 0) return;
    const r = { start, end: start + size };
    if (ranges.some((other) => r.start < other.end && other.start < r.end))
      malformed("Overlapping FDT blocks");
    ranges.push(r);
  };
  if (header.off_dt_struct % 4 || header.off_mem_rsvmap % 8)
    malformed("Misaligned FDT block");
  range(header.off_dt_strings, header.size_dt_strings);
  range(header.off_dt_struct, structureEnd - header.off_dt_struct);
  const reservationEnd = Math.min(
    header.totalsize,
    ...[
      header.off_dt_struct,
      ...(header.size_dt_strings > 0 ? [header.off_dt_strings] : []),
    ].filter((n) => n >= header.off_mem_rsvmap),
  );
  if (
    ranges.some(
      (r) => header.off_mem_rsvmap >= r.start && header.off_mem_rsvmap < r.end,
    )
  )
    malformed("Reservation block overlaps another FDT block");
  if (header.off_mem_rsvmap > reservationEnd - 16)
    malformed("Unterminated or overlapping FDT reservation block");
  return { header, structureEnd, reservationEnd };
};
