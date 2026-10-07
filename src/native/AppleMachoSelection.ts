/** One mapped Mach-O segment with file-backed VA range. */
export interface Segment {
  address: bigint;
  size: bigint;
  offset: number;
  executable: boolean;
}

/** Named Mach-O section within a loaded segment. */
export interface Section {
  name: string;
  address: bigint;
  size: number;
}

/** Selected thin slice bounds inside a Mach-O or FAT container. */
export interface MachoSlice {
  slice: number;
  sliceEnd: number;
}

/** Parsed little-endian 64-bit Mach-O layout for the selected architecture slice. */
export interface MachoLayout {
  segments: Segment[];
  sections: Section[];
  /** Map a virtual address range onto a file offset within the selected slice. */
  offset(address: bigint, size?: number): number;
}

const hex = (value: bigint) => `0x${value.toString(16)}`;

/** Classify a FAT magic word; thin Mach-O returns null. */
export const fatHeaderFormat = (
  magic: number,
): { readonly littleEndian: boolean; readonly fat64: boolean } | null => {
  switch (magic) {
    case 0xcafebabe:
      return { littleEndian: false, fat64: false };
    case 0xcafebabf:
      return { littleEndian: false, fat64: true };
    case 0xbebafeca:
      return { littleEndian: true, fat64: false };
    case 0xbfbafeca:
      return { littleEndian: true, fat64: true };
    default:
      return null;
  }
};

/** Select the thin Mach-O slice for `architecture` inside a FAT or thin container. */
export const selectMachoSlice = (
  bytes: Buffer,
  architecture: string,
): MachoSlice => {
  const magic = bytes.readUInt32BE(0);
  const header = fatHeaderFormat(magic);
  if (header === null) return { slice: 0, sliceEnd: bytes.length };
  const { littleEndian, fat64 } = header;
  const stride = fat64 ? 32 : 20;
  const readUInt32 = littleEndian
    ? (offset: number) => bytes.readUInt32LE(offset)
    : (offset: number) => bytes.readUInt32BE(offset);
  const readUInt64 = littleEndian
    ? (offset: number) => bytes.readBigUInt64LE(offset)
    : (offset: number) => bytes.readBigUInt64BE(offset);
  const byteOrder = littleEndian ? "little-endian" : "big-endian";
  const malformed = (reason: string) =>
    new RangeError(`${reason} (FAT header byte order: ${byteOrder})`);
  const invalid = (reason: string) =>
    new TypeError(`${reason} (FAT header byte order: ${byteOrder})`);
  if (bytes.length < 8) throw malformed("Malformed FAT architecture table");
  const count = readUInt32(4);
  const headerEnd = 8 + count * stride;
  if (count > 128 || headerEnd > bytes.length)
    throw malformed("Malformed FAT architecture table");
  const cpu = architecture === "arm64" ? 0x0100000c : 0x01000007;
  let selected: MachoSlice | undefined;
  for (let index = 0; index < count; index++) {
    const offset = 8 + index * stride;
    if (readUInt32(offset) !== cpu) continue;
    if (selected !== undefined)
      throw invalid("Ambiguous FAT architecture slice");
    const start = fat64
      ? readUInt64(offset + 8)
      : BigInt(readUInt32(offset + 8));
    const size = fat64
      ? readUInt64(offset + 16)
      : BigInt(readUInt32(offset + 12));
    if (start < BigInt(headerEnd) || start + size > BigInt(bytes.length))
      throw malformed("FAT slice exceeds file");
    selected = { slice: Number(start), sliceEnd: Number(start + size) };
  }
  if (selected === undefined)
    throw invalid("Requested FAT architecture is absent");
  return selected;
};

/** Parse segments/sections for a little-endian 64-bit Mach-O architecture slice. */
export const parseMachoLayout = (
  bytes: Buffer,
  architecture: string,
): MachoLayout => {
  if (bytes.length < 4) throw new RangeError("Truncated Mach-O header");
  const { slice, sliceEnd } = selectMachoSlice(bytes, architecture);
  if (slice === 0 && sliceEnd === bytes.length && bytes.length < 32)
    throw new RangeError("Truncated Mach-O header");
  if (slice + 32 > sliceEnd || bytes.readUInt32LE(slice) !== 0xfeedfacf)
    throw new TypeError(
      "Only little-endian 64-bit Mach-O metadata is supported",
    );
  const commands = bytes.readUInt32LE(slice + 16);
  const commandEnd = slice + 32 + bytes.readUInt32LE(slice + 20);
  if (commands > 4096 || commandEnd > sliceEnd)
    throw new RangeError("Malformed Mach-O command bounds");
  const segments: Segment[] = [];
  const sections: Section[] = [];
  let cursor = slice + 32;
  for (let index = 0; index < commands; index++) {
    if (cursor + 8 > commandEnd) throw new RangeError("Truncated load command");
    const kind = bytes.readUInt32LE(cursor),
      size = bytes.readUInt32LE(cursor + 4);
    if (size < 8 || cursor + size > commandEnd)
      throw new RangeError("Invalid load command size");
    if (kind === 0x19) {
      if (size < 72) throw new RangeError("Truncated segment command");
      const address = bytes.readBigUInt64LE(cursor + 24),
        fileSize = bytes.readBigUInt64LE(cursor + 48),
        fileOffset = bytes.readBigUInt64LE(cursor + 40);
      if (fileOffset + fileSize > BigInt(sliceEnd - slice))
        throw new RangeError("Segment file range exceeds target bytes");
      segments.push({
        address,
        size: fileSize,
        offset: slice + Number(fileOffset),
        executable: (bytes.readUInt32LE(cursor + 60) & 4) !== 0,
      });
      const count = bytes.readUInt32LE(cursor + 64);
      if (72 + count * 80 > size)
        throw new RangeError("Truncated section table");
      for (let section = 0; section < count; section++) {
        const position = cursor + 72 + section * 80;
        const sectionSize = bytes.readBigUInt64LE(position + 40);
        if (sectionSize > BigInt(Number.MAX_SAFE_INTEGER))
          throw new RangeError("Section size exceeds exact numeric range");
        sections.push({
          name: bytes
            .subarray(position, position + 16)
            .toString("ascii")
            .replace(/\0.*$/u, ""),
          address: bytes.readBigUInt64LE(position + 32),
          size: Number(sectionSize),
        });
      }
    }
    cursor += size;
  }
  const offset = (address: bigint, size = 1): number => {
    const matches = segments.filter(
      (segment) =>
        address >= segment.address &&
        address + BigInt(size) <= segment.address + segment.size,
    );
    if (matches.length !== 1)
      throw new RangeError(
        `Unmapped or ambiguous metadata pointer ${hex(address)}`,
      );
    const segment = matches[0];
    if (segment === undefined) throw new RangeError("Missing metadata segment");
    return segment.offset + Number(address - segment.address);
  };
  return { segments, sections, offset };
};
