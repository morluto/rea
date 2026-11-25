/** Synthetic PE32+ images with an authored x64 exception directory. */

export const PE_UNWIND_FIXTURE = {
  imageBase: 0x140000000n,
  textRva: 0x1000,
  rdataRva: 0x2000,
  pdataRva: 0x3000,
  sectionBytes: 0x1000,
} as const;

const FILE_HEADER_BYTES = 0x400;
const fileOffsetOf = (rva: number): number =>
  FILE_HEADER_BYTES + (rva - PE_UNWIND_FIXTURE.textRva);

export interface PeUnwindFixtureEntry {
  readonly begin: number;
  readonly end: number;
  readonly unwind: number;
}

export interface PeUnwindFixtureOptions {
  readonly entries: readonly PeUnwindFixtureEntry[];
  /** UNWIND_INFO (or RUNTIME_FUNCTION) blobs placed at their RVA in .rdata. */
  readonly blobs?: readonly { readonly rva: number; readonly bytes: Buffer }[];
  readonly machine?: number;
  /** Declared exception-directory size; defaults to the entries' bytes. */
  readonly directorySize?: number;
  readonly directoryRva?: number;
  /** Cut the file to this many bytes after building it. */
  readonly truncateTo?: number;
}

/** x64 UNWIND_INFO header (version 1), codes, and an optional chained RUNTIME_FUNCTION. */
export const unwindInfo = (
  flags: number,
  codeCount: number,
  chained?: PeUnwindFixtureEntry,
): Buffer => {
  const slots = (codeCount + 1) & ~1;
  const bytes = Buffer.alloc(4 + slots * 2 + (chained === undefined ? 0 : 12));
  bytes[0] = (flags << 3) | 1;
  bytes[2] = codeCount;
  if (chained !== undefined) {
    const at = 4 + slots * 2;
    bytes.writeUInt32LE(chained.begin, at);
    bytes.writeUInt32LE(chained.end, at + 4);
    bytes.writeUInt32LE(chained.unwind, at + 8);
  }
  return bytes;
};

/** A RUNTIME_FUNCTION record, for indirect (low-bit) unwind references. */
export const runtimeFunction = (entry: PeUnwindFixtureEntry): Buffer => {
  const bytes = Buffer.alloc(12);
  bytes.writeUInt32LE(entry.begin, 0);
  bytes.writeUInt32LE(entry.end, 4);
  bytes.writeUInt32LE(entry.unwind, 8);
  return bytes;
};

const writeSection = (
  bytes: Buffer,
  at: number,
  {
    name,
    rva,
    characteristics,
  }: { name: string; rva: number; characteristics: number },
): void => {
  bytes.write(name, at, "ascii");
  bytes.writeUInt32LE(PE_UNWIND_FIXTURE.sectionBytes, at + 8);
  bytes.writeUInt32LE(rva, at + 12);
  bytes.writeUInt32LE(PE_UNWIND_FIXTURE.sectionBytes, at + 16);
  bytes.writeUInt32LE(fileOffsetOf(rva), at + 20);
  bytes.writeUInt32LE(characteristics, at + 36);
};

export const peUnwindImage = (options: PeUnwindFixtureOptions): Buffer => {
  const layout = PE_UNWIND_FIXTURE;
  const bytes = Buffer.alloc(FILE_HEADER_BYTES + 3 * layout.sectionBytes);
  bytes.write("MZ", 0, "ascii");
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write("PE\0\0", 0x80, "ascii");
  bytes.writeUInt16LE(options.machine ?? 0x8664, 0x84);
  bytes.writeUInt16LE(3, 0x86);
  const optionalSize = 112 + 16 * 8;
  bytes.writeUInt16LE(optionalSize, 0x94);
  bytes.writeUInt16LE(0x22, 0x96);
  const optional = 0x98;
  bytes.writeUInt16LE(0x20b, optional);
  bytes.writeUInt32LE(layout.textRva, optional + 16);
  bytes.writeBigUInt64LE(layout.imageBase, optional + 24);
  bytes.writeUInt32LE(0x1000, optional + 32);
  bytes.writeUInt32LE(0x200, optional + 36);
  bytes.writeUInt32LE(0x4000, optional + 56);
  bytes.writeUInt32LE(FILE_HEADER_BYTES, optional + 60);
  bytes.writeUInt16LE(3, optional + 68);
  bytes.writeUInt32LE(16, optional + 108);
  const directories = optional + 112;
  bytes.writeUInt32LE(
    options.directoryRva ?? layout.pdataRva,
    directories + 24,
  );
  bytes.writeUInt32LE(
    options.directorySize ?? options.entries.length * 12,
    directories + 28,
  );
  const sections = optional + optionalSize;
  writeSection(bytes, sections, {
    name: ".text",
    rva: layout.textRva,
    characteristics: 0x60000020,
  });
  writeSection(bytes, sections + 40, {
    name: ".rdata",
    rva: layout.rdataRva,
    characteristics: 0x40000040,
  });
  writeSection(bytes, sections + 80, {
    name: ".pdata",
    rva: layout.pdataRva,
    characteristics: 0x40000040,
  });
  options.entries.forEach((entry, index) => {
    runtimeFunction(entry).copy(
      bytes,
      fileOffsetOf(layout.pdataRva) + index * 12,
    );
  });
  for (const blob of options.blobs ?? [])
    blob.bytes.copy(bytes, fileOffsetOf(blob.rva));
  return options.truncateTo === undefined
    ? bytes
    : bytes.subarray(0, options.truncateTo);
};
