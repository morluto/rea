import { err, ok, type Result } from "./result.js";

/** IMG version 2 stores offsets and sizes in 2048-byte sectors. */
export const IMG_V2_SECTOR_BYTES = 2048;
/** `VER2` followed by a little-endian u32 entry count. */
export const IMG_V2_HEADER_BYTES = 8;
/** u32 offset, u16 streaming size, u16 archive size, char[24] name. */
export const IMG_V2_DIRECTORY_ENTRY_BYTES = 32;
const NAME_BYTES = 24;
const NAME_OFFSET = 8;

/** Whether bytes start with an IMG version 2 (`VER2`) header. */
export const hasImgV2Header = (bytes: Uint8Array): boolean =>
  bytes.length >= IMG_V2_HEADER_BYTES &&
  bytes[0] === 0x56 &&
  bytes[1] === 0x45 &&
  bytes[2] === 0x52 &&
  bytes[3] === 0x32;

/** One directory row with its sector fields and the byte range they select. */
export interface ImgV2DirectoryEntry {
  readonly index: number;
  readonly name: string;
  readonly offsetSectors: number;
  readonly streamingSectors: number;
  readonly archiveSectors: number;
  /** First byte of the member in the archive. */
  readonly byteOffset: number;
  /** Selected member size: the archive size, or the streaming size when it is 0. */
  readonly byteLength: number;
}

/** Declared entry count of an admitted 8-byte `VER2` header. */
export const readImgV2EntryCount = (header: Uint8Array): number =>
  new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(
    4,
    true,
  );

/** Bytes the directory occupies after the header, or an error when it cannot fit. */
export const imgV2DirectoryBytes = (
  entryCount: number,
  fileSize: number,
): Result<number, string> => {
  const bytes = entryCount * IMG_V2_DIRECTORY_ENTRY_BYTES;
  return bytes > fileSize - IMG_V2_HEADER_BYTES
    ? err(
        `declared ${String(entryCount)} directory entries need ${String(bytes)} bytes; the file has ${String(Math.max(0, fileSize - IMG_V2_HEADER_BYTES))} after its header`,
      )
    : ok(bytes);
};

/**
 * Decode every directory row. A row whose name is not NUL-terminated, is not a
 * single path component, or whose sectors leave the file or overlap the
 * directory fails the whole directory instead of being repaired.
 */
export const parseImgV2Directory = (
  directory: Uint8Array,
  fileSize: number,
): Result<readonly ImgV2DirectoryEntry[], string> => {
  if (directory.length % IMG_V2_DIRECTORY_ENTRY_BYTES !== 0)
    return err("directory is not a whole number of 32-byte entries");
  const view = new DataView(
    directory.buffer,
    directory.byteOffset,
    directory.byteLength,
  );
  const directoryEnd = IMG_V2_HEADER_BYTES + directory.length;
  const entries: ImgV2DirectoryEntry[] = [];
  for (
    let index = 0;
    index * IMG_V2_DIRECTORY_ENTRY_BYTES < directory.length;
    index += 1
  ) {
    const row = index * IMG_V2_DIRECTORY_ENTRY_BYTES;
    const name = entryName(
      directory.subarray(row + NAME_OFFSET, row + NAME_OFFSET + NAME_BYTES),
    );
    if (!name.ok) return err(`entry ${String(index)} ${name.error}`);
    const offsetSectors = view.getUint32(row, true);
    const streamingSectors = view.getUint16(row + 4, true);
    const archiveSectors = view.getUint16(row + 6, true);
    const sizeSectors =
      archiveSectors === 0 ? streamingSectors : archiveSectors;
    const byteOffset = offsetSectors * IMG_V2_SECTOR_BYTES;
    const byteLength = sizeSectors * IMG_V2_SECTOR_BYTES;
    if (byteOffset > fileSize || byteLength > fileSize - byteOffset)
      return err(
        `entry ${String(index)} (${name.value}) spans bytes ${String(byteOffset)}..${String(byteOffset + byteLength)}, beyond the ${String(fileSize)}-byte file`,
      );
    if (byteLength > 0 && byteOffset < directoryEnd)
      return err(
        `entry ${String(index)} (${name.value}) starts at byte ${String(byteOffset)}, inside the directory ending at ${String(directoryEnd)}`,
      );
    entries.push({
      index,
      name: name.value,
      offsetSectors,
      streamingSectors,
      archiveSectors,
      byteOffset,
      byteLength,
    });
  }
  return ok(entries);
};

/** Names are byte strings; latin1 keeps every byte without a lossy repair. */
const entryName = (raw: Uint8Array): Result<string, string> => {
  const end = raw.indexOf(0);
  if (end === -1) return err("name is not NUL-terminated within 24 bytes");
  const name = Buffer.from(raw.subarray(0, end)).toString("latin1");
  if (name.length === 0) return err("has an empty name");
  if (name === "." || name === ".." || /[/\\]/u.test(name))
    return err(`name is not a single path component: ${JSON.stringify(name)}`);
  return ok(name);
};
