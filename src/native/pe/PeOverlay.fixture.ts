const OPTIONAL_HEADER_OFFSET = 0x98;
const PE32_OPTIONAL_BYTES = 224;
const PE32_PLUS_OPTIONAL_BYTES = 240;
const SECTION_HEADER_BYTES = 40;
/** IMAGE_SCN_CNT_CODE | IMAGE_SCN_MEM_EXECUTE | IMAGE_SCN_MEM_READ. */
const CODE_CHARACTERISTICS = 0x60000020;

/** One COFF section the overlay fixture writes into the section table. */
export interface PeOverlayFixtureSection {
  readonly name?: string;
  readonly virtualSize?: number;
  readonly virtualAddress?: number;
  readonly rawSize?: number;
  readonly rawOffset?: number;
  readonly characteristics?: number;
}

/** IMAGE_DIRECTORY_ENTRY_SECURITY as a file offset and byte length. */
export interface PeOverlayFixtureSecurity {
  readonly offset: number;
  readonly size: number;
}

/** Synthetic PE32/PE32+ image whose on-disk tail is the caller's overlay. */
export interface PeOverlayFixtureOptions {
  readonly plus?: boolean;
  readonly sectionAlignment?: number;
  readonly fileAlignment?: number;
  readonly sizeOfHeaders?: number;
  readonly sections?: readonly PeOverlayFixtureSection[];
  readonly security?: PeOverlayFixtureSecurity | null;
  readonly trailing?: Buffer;
  /** Exact file length. A section raw range may extend past it. */
  readonly fileSize?: number;
}

const defaultSection = (): PeOverlayFixtureSection => ({
  name: ".text",
  virtualSize: 0x200,
  virtualAddress: 0x1000,
  rawSize: 0x200,
  rawOffset: 0x200,
  characteristics: CODE_CHARACTERISTICS,
});

/**
 * Minimal PE image. The default file ends at the one `.text` raw range, so
 * it has no overlay. `trailing` is appended after the declared raw end.
 */
export const peOverlayImage = (
  options: PeOverlayFixtureOptions = {},
): Buffer => {
  const plus = options.plus === true;
  const sections = options.sections ?? [defaultSection()];
  const optionalSize = plus ? PE32_PLUS_OPTIONAL_BYTES : PE32_OPTIONAL_BYTES;
  const sectionTable = OPTIONAL_HEADER_OFFSET + optionalSize;
  const headerFloor = sectionTable + sections.length * SECTION_HEADER_BYTES;
  const sizeOfHeaders = options.sizeOfHeaders ?? Math.max(0x200, headerFloor);
  if (sizeOfHeaders < headerFloor)
    throw new Error("Fixture SizeOfHeaders excludes the section table.");
  const declaredEnd = sections.reduce(
    (end, section) =>
      Math.max(end, (section.rawOffset ?? 0) + (section.rawSize ?? 0)),
    sizeOfHeaders,
  );
  const trailing = options.trailing ?? Buffer.alloc(0);
  const length = options.fileSize ?? declaredEnd + trailing.length;
  if (length < sizeOfHeaders)
    throw new Error("Fixture file is shorter than SizeOfHeaders.");
  const bytes = Buffer.alloc(length);
  bytes.writeUInt16LE(0x5a4d, 0);
  bytes.writeUInt32LE(0x80, 60);
  bytes.writeUInt32LE(0x4550, 0x80);
  bytes.writeUInt16LE(plus ? 0x8664 : 0x14c, 0x84);
  bytes.writeUInt16LE(sections.length, 0x86);
  bytes.writeUInt16LE(optionalSize, 0x94);
  bytes.writeUInt16LE(plus ? 0x20b : 0x10b, OPTIONAL_HEADER_OFFSET);
  bytes.writeUInt32LE(
    options.sectionAlignment ?? 0x1000,
    OPTIONAL_HEADER_OFFSET + 32,
  );
  bytes.writeUInt32LE(
    options.fileAlignment ?? 0x200,
    OPTIONAL_HEADER_OFFSET + 36,
  );
  bytes.writeUInt32LE(sizeOfHeaders, OPTIONAL_HEADER_OFFSET + 60);
  bytes.writeUInt32LE(16, OPTIONAL_HEADER_OFFSET + (plus ? 108 : 92));
  if (options.security !== undefined && options.security !== null) {
    const directoryAt = OPTIONAL_HEADER_OFFSET + (plus ? 112 : 96) + 4 * 8;
    bytes.writeUInt32LE(options.security.offset, directoryAt);
    bytes.writeUInt32LE(options.security.size, directoryAt + 4);
  }
  for (const [index, section] of sections.entries()) {
    const at = sectionTable + index * SECTION_HEADER_BYTES;
    const name = Buffer.alloc(8);
    name.write(section.name ?? "", 0, "latin1");
    name.copy(bytes, at);
    bytes.writeUInt32LE(section.virtualSize ?? section.rawSize ?? 0, at + 8);
    bytes.writeUInt32LE(section.virtualAddress ?? 0x1000, at + 12);
    bytes.writeUInt32LE(section.rawSize ?? 0, at + 16);
    bytes.writeUInt32LE(section.rawOffset ?? 0, at + 20);
    bytes.writeUInt32LE(
      section.characteristics ?? CODE_CHARACTERISTICS,
      at + 36,
    );
  }
  if (trailing.length > 0 && declaredEnd + trailing.length <= bytes.length)
    trailing.copy(bytes, declaredEnd);
  return bytes;
};

/** ZIP local-file header. Four signature bytes are enough to name the format. */
export const ZIP_LOCAL_HEADER = Buffer.from([
  0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
]);

/** 7z signature plus a short header. No recognizer names this format. */
export const SEVEN_ZIP_HEADER = Buffer.from([
  0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x00, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00,
]);
