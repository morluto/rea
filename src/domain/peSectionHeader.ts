import { err, ok } from "./result.js";

export const PE_SECTION_HEADER_BYTES = 40;

/** Locate the COFF section table from the declared optional-header span. */
export const peSectionTableExtent = (
  optionalHeaderOffset: number,
  optionalHeaderSize: number,
  sectionCount: number,
) => ({
  sectionTableOffset: optionalHeaderOffset + optionalHeaderSize,
  sectionTableBytes: sectionCount * PE_SECTION_HEADER_BYTES,
});

/** Observe the declared combined header extent separately from the available prefix. */
export const observePeHeaderExtent = ({
  optionalHeaderOffset,
  optionalHeaderSize,
  sectionCount,
  sizeOfHeaders,
  fileSize,
}: {
  readonly optionalHeaderOffset: number;
  readonly optionalHeaderSize: number;
  readonly sectionCount: number;
  readonly sizeOfHeaders: number;
  readonly fileSize: number;
}) => {
  // These offsets and counts come from the fixed-width PE and COFF readers.
  const { sectionTableOffset, sectionTableBytes } = peSectionTableExtent(
    optionalHeaderOffset,
    optionalHeaderSize,
    sectionCount,
  );
  const sizeOfHeadersState =
    sizeOfHeaders < sectionTableOffset + sectionTableBytes
      ? "before-section-table-end"
      : sizeOfHeaders > fileSize
        ? "past-file-end"
        : "valid";
  return { sectionTableOffset, sectionTableBytes, sizeOfHeadersState };
};

/** Fixed COFF section facts; callers own file/range and mapping admission. */
export const readPeSectionHeader = (bytes: Buffer) => {
  if (bytes.length < PE_SECTION_HEADER_BYTES)
    return err({
      kind: "malformed" as const,
      message: "PE section header is truncated",
    });
  const name = bytes.subarray(0, 8);
  const nul = name.indexOf(0);
  const virtual_size = bytes.readUInt32LE(8);
  const raw_size = bytes.readUInt32LE(16);
  return ok({
    name: name.toString("latin1", 0, nul < 0 ? name.length : nul),
    virtual_size,
    virtual_address: bytes.readUInt32LE(12),
    raw_size,
    offset: bytes.readUInt32LE(20),
    characteristics: bytes.readUInt32LE(36),
    // Content excludes file-alignment padding; raw_size remains available to
    // consumers that validate physical file ranges.
    size: virtual_size === 0 ? raw_size : Math.min(virtual_size, raw_size),
  });
};
