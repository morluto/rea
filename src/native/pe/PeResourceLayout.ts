import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";

export const peFailure = (message: string): never => {
  throw new ArtifactReaderFailure("format", message);
};

export const requirePeRange = (
  bytes: Buffer,
  offset: number,
  length: number,
): void => {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset > bytes.length - length
  )
    peFailure(
      `PE range ${String(offset)} + ${String(length)} leaves the artifact.`,
    );
};

interface Section {
  readonly rva: number;
  readonly virtualSize: number;
  readonly offset: number;
  readonly size: number;
}

/** Header admission and unambiguous file-backed RVA mapping, independent of section names. */
export const readPeResourceLayout = (bytes: Buffer) => {
  requirePeRange(bytes, 0, 64);
  if (bytes.readUInt16LE(0) !== 0x5a4d) peFailure("Expected an MZ PE image.");
  const pe = bytes.readUInt32LE(60);
  requirePeRange(bytes, pe, 24);
  if (bytes.readUInt32LE(pe) !== 0x4550) peFailure("Expected a PE signature.");
  const sectionCount = bytes.readUInt16LE(pe + 6);
  const optionalSize = bytes.readUInt16LE(pe + 20);
  const optional = pe + 24;
  requirePeRange(bytes, optional, optionalSize);
  if (optionalSize < 64) peFailure("Truncated PE optional header.");
  const magic = bytes.readUInt16LE(optional);
  if (magic !== 0x10b && magic !== 0x20b)
    peFailure("Unsupported PE optional header magic.");
  const countAt = magic === 0x10b ? 92 : 108;
  const directoriesAt = countAt + 4;
  if (optionalSize < directoriesAt)
    peFailure("Truncated PE data directory count.");
  const directoryCount = bytes.readUInt32LE(optional + countAt);
  if (directoryCount > Math.floor((optionalSize - directoriesAt) / 8))
    peFailure("PE directory count exceeds its optional header.");
  const headerSize = bytes.readUInt32LE(optional + 60);
  const table = optional + optionalSize;
  requirePeRange(bytes, table, sectionCount * 40);
  if (headerSize < table + sectionCount * 40 || headerSize > bytes.length)
    peFailure("Invalid PE SizeOfHeaders.");
  const sections: Section[] = [];
  for (let index = 0; index < sectionCount; index++) {
    const at = table + index * 40;
    const section = {
      rva: bytes.readUInt32LE(at + 12),
      virtualSize: bytes.readUInt32LE(at + 8),
      offset: bytes.readUInt32LE(at + 20),
      size: bytes.readUInt32LE(at + 16),
    };
    if (section.rva + Math.max(section.virtualSize, section.size) > 0x100000000)
      peFailure("PE section RVA range overflows.");
    if (section.size > 0) {
      requirePeRange(bytes, section.offset, section.size);
      if (section.offset < headerSize)
        peFailure("PE section raw bytes overlap headers.");
    }
    sections.push(section);
  }
  const backed = sections
    .filter(({ size }) => size > 0)
    .sort((left, right) => left.offset - right.offset);
  for (let index = 1; index < backed.length; index++) {
    const previous = backed[index - 1];
    const current = backed[index];
    if (
      previous !== undefined &&
      current !== undefined &&
      current.offset < previous.offset + previous.size
    )
      peFailure("PE sections have overlapping raw file ranges.");
  }
  const map = (rva: number, size: number): number => {
    if (rva + size > 0x100000000) peFailure("Resource RVA range overflows.");
    const candidates = sections.filter(
      (section) =>
        rva >= section.rva &&
        rva - section.rva < Math.max(section.size, section.virtualSize),
    );
    if (rva < headerSize) {
      if (
        sections.some(
          (section) =>
            section.rva < rva + size &&
            section.rva + Math.max(section.size, section.virtualSize) > rva,
        ) ||
        size > headerSize - rva
      )
        peFailure("Ambiguous resource header RVA mapping.");
      requirePeRange(bytes, rva, size);
      return rva;
    }
    if (candidates.length !== 1)
      peFailure("Resource RVA has missing or overlapping section mappings.");
    const section = candidates[0];
    if (section === undefined) return peFailure("Missing resource section.");
    const within = rva - section.rva;
    if (within > section.size || size > section.size - within)
      peFailure("Resource range is not entirely file-backed in one section.");
    // A second section starting inside the requested interval is ambiguous too.
    if (
      sections.some(
        (other) =>
          other !== section &&
          other.rva < rva + size &&
          other.rva + Math.max(other.size, other.virtualSize) > rva,
      )
    )
      peFailure("Resource interval intersects overlapping virtual sections.");
    const offset = section.offset + within;
    requirePeRange(bytes, offset, size);
    return offset;
  };
  const directoryAt = optional + directoriesAt + 16;
  const rva = directoryCount > 2 ? bytes.readUInt32LE(directoryAt) : 0;
  const size = directoryCount > 2 ? bytes.readUInt32LE(directoryAt + 4) : 0;
  if ((rva === 0) !== (size === 0))
    peFailure("Inconsistent PE resource directory RVA/size.");
  return {
    format: magic === 0x10b ? ("pe32" as const) : ("pe32-plus" as const),
    machine: bytes.readUInt16LE(pe + 4),
    directoryAt,
    rva,
    size,
    map,
  };
};
