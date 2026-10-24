import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";

export const peFailure = (message: string): never => {
  throw new ArtifactReaderFailure("format", message);
};

export const requirePeRange = (
  bytes: Buffer,
  offset: number,
  length: number,
): void => requirePeExtent(bytes.length, offset, length);

const requirePeExtent = (
  fileSize: number,
  offset: number,
  length: number,
): void => {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset > fileSize - length
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

// RVA ownership follows the declared virtual extent. Raw size describes
// initialized file bytes and can include file-alignment padding; loaders may
// map page-rounded tails, but those bytes are outside the declared section.
const virtualExtent = (section: Section): number =>
  section.virtualSize === 0 ? section.size : section.virtualSize;

// Intersection normalized with those ownership rules: a section without
// virtual extent owns no byte and never conflicts, while an empty resource
// owns exactly its start point, so a positive-extent section starting there
// conflicts with header-backed ownership of the same RVA.
const intersectsResource = (
  section: Section,
  rva: number,
  size: number,
): boolean => {
  const extent = virtualExtent(section);
  return (
    extent > 0 &&
    section.rva < rva + Math.max(size, 1) &&
    rva < section.rva + extent
  );
};

/**
 * Shared PE header admission: signature, optional header, data directories,
 * and a section table that fits inside SizeOfHeaders. `bytes` may be a file
 * prefix that holds the header structures; file-space ranges are checked
 * against `fileSize`.
 */
export const readPeHeaders = (bytes: Buffer, fileSize = bytes.length) => {
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
  if (headerSize < table + sectionCount * 40 || headerSize > fileSize)
    peFailure("Invalid PE SizeOfHeaders.");
  return {
    pe,
    sectionCount,
    optional,
    magic,
    directoriesAt,
    directoryCount,
    headerSize,
    table,
  };
};

/** Header admission and unambiguous file-backed RVA mapping, independent of section names. */
export const readPeResourceLayout = (
  bytes: Buffer,
  fileSize = bytes.length,
) => {
  const {
    pe,
    sectionCount,
    optional,
    magic,
    directoriesAt,
    directoryCount,
    headerSize,
    table,
  } = readPeHeaders(bytes, fileSize);
  const sections: Section[] = [];
  for (let index = 0; index < sectionCount; index++) {
    const at = table + index * 40;
    const section = {
      rva: bytes.readUInt32LE(at + 12),
      virtualSize: bytes.readUInt32LE(at + 8),
      offset: bytes.readUInt32LE(at + 20),
      size: bytes.readUInt32LE(at + 16),
    };
    if (section.rva + virtualExtent(section) > 0x100000000)
      peFailure("PE section RVA range overflows.");
    if (section.size > 0) {
      requirePeExtent(fileSize, section.offset, section.size);
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
    const containing = sections.filter(
      (section) =>
        rva >= section.rva && rva - section.rva < virtualExtent(section),
    );
    // An empty interval reads no bytes, so the Windows resource loader also
    // resolves it exactly at a section's virtual end. A section starting at
    // that RVA still owns it.
    const candidates =
      size === 0 && containing.length === 0
        ? sections.filter(
            (section) =>
              virtualExtent(section) > 0 &&
              rva - section.rva === virtualExtent(section),
          )
        : containing;
    if (rva < headerSize) {
      if (
        sections.some((section) => intersectsResource(section, rva, size)) ||
        size > headerSize - rva
      )
        peFailure("Ambiguous resource header RVA mapping.");
      requirePeExtent(fileSize, rva, size);
      return rva;
    }
    if (candidates.length !== 1)
      peFailure("Resource RVA has missing or overlapping section mappings.");
    const section = candidates[0];
    if (section === undefined) return peFailure("Missing resource section.");
    const within = rva - section.rva;
    if (size > virtualExtent(section) - within)
      peFailure("Resource range leaves its section's virtual size.");
    if (within > section.size || size > section.size - within)
      peFailure("Resource range is not entirely file-backed in one section.");
    // A second section with virtual extent inside the requested interval is
    // ambiguous too; a zero-extent section owns no byte there.
    if (
      sections.some(
        (other) => other !== section && intersectsResource(other, rva, size),
      )
    )
      peFailure("Resource interval intersects overlapping virtual sections.");
    const offset = section.offset + within;
    requirePeExtent(fileSize, offset, size);
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

/**
 * Bounded admission probe: whether the root type directory holds a `typeId`
 * subdirectory naming `name`. Reads only the header prefix and the
 * directories on that path; an unadmitted layout or malformed tree reports
 * false so callers can leave full resource parsing to confirmed carriers.
 */
export const hasPeResourceName = async (
  headers: Buffer,
  fileSize: number,
  read: (offset: number, length: number) => Promise<Buffer | undefined>,
  typeId: number,
  name: string,
  maxEntries: number,
): Promise<boolean> => {
  let layout: ReturnType<typeof readPeResourceLayout>;
  let root: number;
  try {
    layout = readPeResourceLayout(headers, fileSize);
    if (layout.size < 16) return false;
    root = layout.map(layout.rva, layout.size);
  } catch (cause) {
    if (cause instanceof ArtifactReaderFailure && cause.reason === "format")
      return false;
    throw cause;
  }
  const { size } = layout;
  const relative = (at: number, length: number) =>
    at < 0 || at > size - length
      ? Promise.resolve(undefined)
      : read(root + at, length);
  let examined = 0;
  const directory = async (at: number): Promise<Buffer | undefined> => {
    const header = await relative(at, 16);
    if (header === undefined) return undefined;
    const entries = header.readUInt16LE(12) + header.readUInt16LE(14);
    if (entries > maxEntries - examined) return undefined;
    examined += entries;
    return relative(at + 16, entries * 8);
  };
  const types = await directory(0);
  if (types === undefined) return false;
  const expected = Buffer.from(name, "utf16le");
  for (let at = 0; at < types.length; at += 8) {
    if (types.readUInt32LE(at) !== typeId) continue;
    const target = types.readUInt32LE(at + 4);
    if ((target & 0x80000000) === 0) continue;
    const names = await directory(target & 0x7fffffff);
    if (names === undefined) continue;
    for (let entry = 0; entry < names.length; entry += 8) {
      const encoded = names.readUInt32LE(entry);
      if ((encoded & 0x80000000) === 0) continue;
      const nameAt = encoded & 0x7fffffff;
      const length = await relative(nameAt, 2);
      if (length?.readUInt16LE(0) !== name.length) continue;
      const candidate = await relative(nameAt + 2, expected.length);
      if (candidate?.equals(expected)) return true;
    }
  }
  return false;
};
