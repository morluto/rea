/** SysV ELF hash used by GNU version aux records. */
export const elfHash = (name: string): number => {
  let h = 0;
  for (const byte of Buffer.from(name, "latin1")) {
    h = ((h << 4) + byte) >>> 0;
    const g = h & 0xf0000000;
    if (g !== 0) h ^= g >>> 24;
    h = (h & ~g) >>> 0;
  }
  return h;
};

const concat = (...parts: readonly Buffer[]): Buffer => Buffer.concat(parts);

const write16 = (
  bytes: Buffer,
  offset: number,
  value: number,
  little: boolean,
): void => {
  if (little) bytes.writeUInt16LE(value, offset);
  else bytes.writeUInt16BE(value, offset);
};

const write32 = (
  bytes: Buffer,
  offset: number,
  value: number,
  little: boolean,
): void => {
  if (little) bytes.writeUInt32LE(value, offset);
  else bytes.writeUInt32BE(value, offset);
};

const writeWord = (
  bytes: Buffer,
  offset: number,
  value: number,
  bits: 32 | 64,
  little: boolean,
): void => {
  if (bits === 64) {
    const wide = BigInt(value);
    if (little) bytes.writeBigUInt64LE(wide, offset);
    else bytes.writeBigUInt64BE(wide, offset);
    return;
  }
  write32(bytes, offset, value, little);
};

export interface ElfDependencyImportSpec {
  readonly name: string;
  readonly binding?: number;
  readonly type?: number;
  readonly version?: number;
}

export interface ElfDependencyVersionSpec {
  readonly name: string;
  readonly index: number;
  readonly flags?: number;
  readonly hash?: number;
}

export interface ElfDependencyVerneedSpec {
  readonly file: string;
  readonly versions: readonly ElfDependencyVersionSpec[];
}

export interface ElfDependencyVerdefSpec {
  readonly name: string;
  readonly index: number;
  readonly flags?: number;
}

export interface ElfDependencyFixtureOptions {
  readonly bits?: 32 | 64;
  readonly little?: boolean;
  readonly type?: number;
  readonly machine?: number;
  readonly interpreter?: string | null;
  readonly needed?: readonly string[];
  /** Replaces the first DT_NEEDED and the DT_SONAME string offsets. */
  readonly wideNameOffset?: number;
  readonly soname?: string | null;
  readonly rpath?: string | null;
  readonly runpath?: string | null;
  readonly flags?: number | null;
  readonly flags1?: number | null;
  readonly imports?: readonly ElfDependencyImportSpec[];
  readonly verneed?: readonly ElfDependencyVerneedSpec[];
  readonly verdef?: readonly ElfDependencyVerdefSpec[];
  readonly stripped?: boolean;
  readonly omitDynamic?: boolean;
  readonly omitHash?: boolean;
  readonly gnuHash?: boolean;
  readonly gnuBucketBelowFirstSymbol?: boolean;
  readonly cyclicVerneed?: boolean;
  readonly cyclicVernaux?: boolean;
  /** Gives the final record of this chain a nonzero link past its count. */
  readonly danglingVersionLink?: "verneed" | "vernaux" | "verdef";
  /** Writes revision 0 into the first record of this table. */
  readonly unsupportedVersionRevision?: "verneed" | "verdef";
  readonly truncateDynstr?: boolean;
  readonly duplicateSoname?: boolean;
  /** Declares this section's size past the end of the file. */
  readonly oversizedSection?: string;
  /** Places this section's file offset past the end of the file. */
  readonly displacedSection?: string;
  /** Keeps the .hash section but leaves DT_HASH out of the dynamic table. */
  readonly omitHashTag?: boolean;
}

const defaultNeeded = (): string[] => [
  "libstdc++.so.6",
  "libm.so.6",
  "libc.so.6",
];

const defaultImports = (): ElfDependencyImportSpec[] => [
  { name: "printf", version: 3 },
  { name: "memcpy", version: 2 },
  { name: "_ZSt4cout", type: 1, version: 4 },
  { name: "abort", version: 1 },
  { name: "_exit", version: 0x8002 },
];

const defaultVerneed = (): ElfDependencyVerneedSpec[] => [
  {
    file: "libc.so.6",
    versions: [
      { name: "GLIBC_2.2.5", index: 2 },
      { name: "GLIBC_2.34", index: 3 },
    ],
  },
  {
    file: "libstdc++.so.6",
    versions: [{ name: "GLIBCXX_3.4.29", index: 4 }],
  },
];

const defaultVerdef = (): ElfDependencyVerdefSpec[] => [
  { name: "libdemo.so.1", index: 1, flags: 1 },
];

class StringTable {
  readonly #parts: Buffer[] = [Buffer.from([0])];
  readonly #offsets = new Map<string, number>([["", 0]]);
  #size = 1;

  intern(value: string): number {
    const existing = this.#offsets.get(value);
    if (existing !== undefined) return existing;
    const offset = this.#size;
    const encoded = Buffer.from(`${value}\0`, "latin1");
    this.#parts.push(encoded);
    this.#offsets.set(value, offset);
    this.#size += encoded.length;
    return offset;
  }

  bytes(options: { readonly dropLastNul?: boolean } = {}): Buffer {
    const table = Buffer.concat(this.#parts);
    if (options.dropLastNul === true && table.length > 1)
      return table.subarray(0, table.length - 1);
    return table;
  }
}

const symbolBytes = (
  nameOffset: number,
  info: number,
  sectionIndex: number,
  bits: 32 | 64,
  little: boolean,
): Buffer => {
  const bytes = Buffer.alloc(bits === 64 ? 24 : 16);
  write32(bytes, 0, nameOffset, little);
  if (bits === 64) {
    bytes[4] = info;
    bytes[5] = 0;
    write16(bytes, 6, sectionIndex, little);
    return bytes;
  }
  write32(bytes, 4, 0, little);
  write32(bytes, 8, 0, little);
  bytes[12] = info;
  bytes[13] = 0;
  write16(bytes, 14, sectionIndex, little);
  return bytes;
};

const dynamicEntry = (
  tag: number,
  value: number,
  bits: 32 | 64,
  little: boolean,
): Buffer => {
  const bytes = Buffer.alloc(bits === 64 ? 16 : 8);
  writeWord(bytes, 0, tag, bits, little);
  writeWord(bytes, bits === 64 ? 8 : 4, value, bits, little);
  return bytes;
};

const verneedRecord = (
  fileOffset: number,
  versions: readonly ElfDependencyVersionSpec[],
  nameOffsets: readonly number[],
  next: number,
  little: boolean,
  cyclicAux: boolean,
  finalAuxLink = 0,
  revision = 1,
): Buffer => {
  const header = Buffer.alloc(16);
  write16(header, 0, revision, little);
  write16(header, 2, versions.length, little);
  write32(header, 4, fileOffset, little);
  write32(header, 8, 16, little);
  write32(header, 12, next, little);
  const aux = versions.map((version, index) => {
    const record = Buffer.alloc(16);
    write32(record, 0, version.hash ?? elfHash(version.name), little);
    write16(record, 4, version.flags ?? 0, little);
    write16(record, 6, version.index, little);
    write32(record, 8, nameOffsets[index] ?? 0, little);
    const last = index + 1 === versions.length;
    const auxLink = last ? finalAuxLink : 16;
    write32(record, 12, cyclicAux && index === 0 ? 0 : auxLink, little);
    return record;
  });
  return concat(header, ...aux);
};

const verdefRecord = (
  nameOffset: number,
  index: number,
  flags: number,
  hash: number,
  next: number,
  little: boolean,
  revision = 1,
): Buffer => {
  const bytes = Buffer.alloc(28);
  write16(bytes, 0, revision, little);
  write16(bytes, 2, flags, little);
  write16(bytes, 4, index, little);
  write16(bytes, 6, 1, little);
  write32(bytes, 8, hash, little);
  write32(bytes, 12, 20, little);
  write32(bytes, 16, next, little);
  write32(bytes, 20, nameOffset, little);
  write32(bytes, 24, 0, little);
  return bytes;
};

const sysvHash = (symbolCount: number, little: boolean): Buffer => {
  const bytes = Buffer.alloc(8 + 4 + 4 * symbolCount);
  write32(bytes, 0, 1, little);
  write32(bytes, 4, symbolCount, little);
  return bytes;
};

/** Minimal GNU hash whose nchain walk yields `symbolCount` including the null entry. */
const gnuHashTable = (
  symbolCount: number,
  bits: 32 | 64,
  little: boolean,
  bucketBelowFirstSymbol: boolean,
): Buffer => {
  const firstSymbol = bucketBelowFirstSymbol
    ? Math.min(2, symbolCount)
    : Math.min(1, symbolCount);
  const hashed = Math.max(0, symbolCount - firstSymbol);
  const header = Buffer.alloc(16);
  write32(header, 0, 1, little);
  write32(header, 4, firstSymbol, little);
  write32(header, 8, 1, little);
  write32(header, 12, 0, little);
  const bloom = Buffer.alloc(bits === 64 ? 8 : 4);
  const buckets = Buffer.alloc(4);
  write32(
    buckets,
    0,
    bucketBelowFirstSymbol ? 1 : hashed === 0 ? 0 : firstSymbol,
    little,
  );
  const chains = Buffer.alloc(hashed * 4);
  if (hashed > 0) write32(chains, (hashed - 1) * 4, 1, little);
  return concat(header, bloom, buckets, chains);
};

const writeProgramHeader = (
  bytes: Buffer,
  at: number,
  bits: 32 | 64,
  little: boolean,
  type: number,
  flags: number,
  offset: number,
  size: number,
  align: number,
  vaddr = offset,
): void => {
  write32(bytes, at, type, little);
  if (bits === 64) {
    write32(bytes, at + 4, flags, little);
    writeWord(bytes, at + 8, offset, bits, little);
    writeWord(bytes, at + 16, vaddr, bits, little);
    writeWord(bytes, at + 24, vaddr, bits, little);
    writeWord(bytes, at + 32, size, bits, little);
    writeWord(bytes, at + 40, size, bits, little);
    writeWord(bytes, at + 48, align, bits, little);
    return;
  }
  writeWord(bytes, at + 4, offset, bits, little);
  writeWord(bytes, at + 8, vaddr, bits, little);
  writeWord(bytes, at + 12, vaddr, bits, little);
  writeWord(bytes, at + 16, size, bits, little);
  writeWord(bytes, at + 20, size, bits, little);
  write32(bytes, at + 24, flags, little);
  writeWord(bytes, at + 28, align, bits, little);
};

const writeSectionHeader = (
  bytes: Buffer,
  at: number,
  bits: 32 | 64,
  little: boolean,
  nameOffset: number,
  type: number,
  flags: number,
  addr: number,
  offset: number,
  size: number,
  link: number,
  info: number,
  entsize: number,
): void => {
  write32(bytes, at, nameOffset, little);
  write32(bytes, at + 4, type, little);
  writeWord(bytes, at + 8, flags, bits, little);
  writeWord(bytes, at + (bits === 64 ? 16 : 12), addr, bits, little);
  writeWord(bytes, at + (bits === 64 ? 24 : 16), offset, bits, little);
  writeWord(bytes, at + (bits === 64 ? 32 : 20), size, bits, little);
  write32(bytes, at + (bits === 64 ? 40 : 24), link, little);
  write32(bytes, at + (bits === 64 ? 44 : 28), info, little);
  writeWord(bytes, at + (bits === 64 ? 48 : 32), 1, bits, little);
  writeWord(bytes, at + (bits === 64 ? 56 : 36), entsize, bits, little);
};

interface FixtureConfig {
  readonly bits: 32 | 64;
  readonly little: boolean;
  readonly type: number;
  readonly machine: number;
  readonly omitDynamic: boolean;
  readonly stripped: boolean;
  readonly needed: readonly string[];
  readonly imports: readonly ElfDependencyImportSpec[];
  readonly verneed: readonly ElfDependencyVerneedSpec[];
  readonly verdef: readonly ElfDependencyVerdefSpec[];
  readonly interpreter: string | null;
  readonly soname: string | null;
  readonly runpath: string | null;
  readonly rpath: string | null;
  readonly flags: number | null;
  readonly flags1: number | null;
  readonly omitHash: boolean;
  readonly gnuHash: boolean;
  readonly gnuBucketBelowFirstSymbol: boolean;
  readonly cyclicVerneed: boolean;
  readonly cyclicVernaux: boolean;
  readonly danglingVersionLink: ElfDependencyFixtureOptions["danglingVersionLink"];
  readonly unsupportedVersionRevision: ElfDependencyFixtureOptions["unsupportedVersionRevision"];
  readonly truncateDynstr: boolean;
  readonly duplicateSoname: boolean;
  readonly wideNameOffset: number | undefined;
  readonly oversizedSection: string | undefined;
  readonly displacedSection: string | undefined;
  readonly omitHashTag: boolean;
}

interface DependencyTables {
  readonly neededOffsets: readonly number[];
  readonly sonameOffset: number;
  readonly runpathOffset: number;
  readonly rpathOffset: number;
  readonly dynstrBytes: Buffer;
  readonly dynsym: Buffer;
  readonly versym: Buffer;
  readonly hash: Buffer;
  readonly gnuHashBytes: Buffer;
  readonly verneedBytes: Buffer;
  readonly verdefBytes: Buffer;
  readonly interpBytes: Buffer;
}

interface DependencyLayout {
  readonly headerSize: number;
  readonly phent: number;
  readonly shent: number;
  readonly programCount: number;
  readonly phoff: number;
  readonly interpOff: number;
  readonly hashOff: number;
  readonly gnuHashOff: number;
  readonly dynsymOff: number;
  readonly dynstrOff: number;
  readonly versymOff: number;
  readonly verneedOff: number;
  readonly verdefOff: number;
  readonly dynamicBytes: Buffer;
  readonly dynamicOff: number;
  readonly shstr: StringTable;
  readonly shstrBytes: Buffer;
  readonly shstrOff: number;
  readonly shnum: number;
  readonly shoff: number;
  readonly fileSize: number;
}

const SECTION_NAMES = [
  ".interp",
  ".hash",
  ".dynsym",
  ".dynstr",
  ".gnu.version",
  ".gnu.version_r",
  ".gnu.version_d",
  ".dynamic",
  ".shstrtab",
] as const;

const fixtureConfig = (options: ElfDependencyFixtureOptions): FixtureConfig => {
  const bits = options.bits ?? 64;
  const little = options.little ?? true;
  return {
    bits,
    little,
    type: options.type ?? 3,
    machine: options.machine ?? (bits === 64 ? 62 : little ? 3 : 8),
    omitDynamic: options.omitDynamic === true,
    stripped: options.stripped === true,
    needed: [...(options.needed ?? defaultNeeded())],
    imports: [...(options.imports ?? defaultImports())],
    verneed: [...(options.verneed ?? defaultVerneed())],
    verdef: [...(options.verdef ?? defaultVerdef())],
    interpreter:
      options.interpreter === null
        ? null
        : (options.interpreter ??
          (bits === 64 ? "/lib64/ld-linux-x86-64.so.2" : "/lib/ld-linux.so.2")),
    soname: options.soname === null ? null : (options.soname ?? "libdemo.so.1"),
    runpath:
      options.runpath === null ? null : (options.runpath ?? "$ORIGIN/../lib"),
    rpath: options.rpath ?? null,
    flags: options.flags === undefined ? 0x9 : options.flags,
    flags1: options.flags1 === undefined ? 0x08000881 : options.flags1,
    omitHash: options.omitHash === true,
    gnuHash: options.gnuHash === true,
    gnuBucketBelowFirstSymbol: options.gnuBucketBelowFirstSymbol === true,
    cyclicVerneed: options.cyclicVerneed === true,
    cyclicVernaux: options.cyclicVernaux === true,
    danglingVersionLink: options.danglingVersionLink,
    unsupportedVersionRevision: options.unsupportedVersionRevision,
    truncateDynstr: options.truncateDynstr === true,
    duplicateSoname: options.duplicateSoname === true,
    wideNameOffset: options.wideNameOffset,
    oversizedSection: options.oversizedSection,
    displacedSection: options.displacedSection,
    omitHashTag: options.omitHashTag === true,
  };
};

const buildDependencyTables = (config: FixtureConfig): DependencyTables => {
  const { bits, little, imports, verneed, verdef } = config;
  const dynstr = new StringTable();
  const neededOffsets = config.needed.map((name) => dynstr.intern(name));
  const sonameOffset =
    config.soname === null ? 0 : dynstr.intern(config.soname);
  const runpathOffset =
    config.runpath === null ? 0 : dynstr.intern(config.runpath);
  const rpathOffset = config.rpath === null ? 0 : dynstr.intern(config.rpath);
  const importOffsets = imports.map((entry) => dynstr.intern(entry.name));
  const verneedFileOffsets = verneed.map((entry) => dynstr.intern(entry.file));
  const verneedNameOffsets = verneed.map((entry) =>
    entry.versions.map((version) => dynstr.intern(version.name)),
  );
  const verdefNameOffsets = verdef.map((entry) => dynstr.intern(entry.name));
  const symbols = [
    symbolBytes(0, 0, 0, bits, little),
    ...imports.map((entry, index) =>
      symbolBytes(
        importOffsets[index] ?? 0,
        ((entry.binding ?? 1) << 4) | (entry.type ?? 2),
        0,
        bits,
        little,
      ),
    ),
  ];
  const versym = Buffer.alloc(symbols.length * 2);
  write16(versym, 0, 0, little);
  imports.forEach((entry, index) => {
    write16(versym, (index + 1) * 2, entry.version ?? 1, little);
  });
  const verneedBytes = concat(
    ...verneed.map((entry, index) => {
      const auxBytes = 16 * entry.versions.length;
      const last = index + 1 === verneed.length;
      const dangling = last && config.danglingVersionLink === "verneed";
      const next =
        config.cyclicVerneed && index === 0
          ? 0
          : dangling
            ? 32
            : last
              ? 0
              : 16 + auxBytes;
      return verneedRecord(
        verneedFileOffsets[index] ?? 0,
        entry.versions,
        verneedNameOffsets[index] ?? [],
        next,
        little,
        config.cyclicVernaux && index === 0,
        last && config.danglingVersionLink === "vernaux" ? 16 : 0,
        index === 0 && config.unsupportedVersionRevision === "verneed" ? 0 : 1,
      );
    }),
  );
  return {
    neededOffsets,
    sonameOffset,
    runpathOffset,
    rpathOffset,
    dynstrBytes: dynstr.bytes({ dropLastNul: config.truncateDynstr }),
    dynsym: Buffer.concat(symbols),
    versym,
    hash: config.omitHash ? Buffer.alloc(0) : sysvHash(symbols.length, little),
    gnuHashBytes: config.gnuHash
      ? gnuHashTable(
          symbols.length,
          bits,
          little,
          config.gnuBucketBelowFirstSymbol,
        )
      : Buffer.alloc(0),
    verneedBytes,
    verdefBytes: concat(
      ...verdef.map((entry, index) =>
        verdefRecord(
          verdefNameOffsets[index] ?? 0,
          entry.index,
          entry.flags ?? 0,
          elfHash(entry.name),
          index + 1 < verdef.length || config.danglingVersionLink === "verdef"
            ? 28
            : 0,
          little,
          index === 0 && config.unsupportedVersionRevision === "verdef" ? 0 : 1,
        ),
      ),
    ),
    interpBytes:
      config.interpreter === null
        ? Buffer.alloc(0)
        : Buffer.from(`${config.interpreter}\0`, "latin1"),
  };
};

const buildDynamicTags = (
  config: FixtureConfig,
  tables: DependencyTables,
  offsets: {
    readonly hashOff: number;
    readonly gnuHashOff: number;
    readonly dynsymOff: number;
    readonly dynstrOff: number;
    readonly versymOff: number;
    readonly verneedOff: number;
    readonly verdefOff: number;
  },
): Buffer => {
  const { bits, little } = config;
  const tags: Buffer[] = [];
  const addTag = (tag: number, value: number): void => {
    tags.push(dynamicEntry(tag, value, bits, little));
  };
  tables.neededOffsets.forEach((offset, index) =>
    addTag(1, index === 0 ? (config.wideNameOffset ?? offset) : offset),
  );
  if (config.soname !== null) {
    addTag(14, config.wideNameOffset ?? tables.sonameOffset);
    if (config.duplicateSoname) addTag(14, tables.sonameOffset);
  }
  if (config.rpath !== null) addTag(15, tables.rpathOffset);
  if (config.runpath !== null) addTag(29, tables.runpathOffset);
  if (config.flags !== null) addTag(30, config.flags);
  if (tables.hash.length !== 0 && !config.omitHashTag)
    addTag(4, offsets.hashOff);
  if (tables.gnuHashBytes.length !== 0) addTag(0x6ffffef5, offsets.gnuHashOff);
  addTag(5, offsets.dynstrOff);
  addTag(6, offsets.dynsymOff);
  addTag(10, tables.dynstrBytes.length);
  addTag(11, bits === 64 ? 24 : 16);
  addTag(0x6ffffff0, offsets.versymOff);
  if (tables.verneedBytes.length !== 0) {
    addTag(0x6ffffffe, offsets.verneedOff);
    addTag(
      0x6fffffff,
      config.cyclicVerneed
        ? Math.max(config.verneed.length, 2)
        : config.verneed.length,
    );
  }
  if (tables.verdefBytes.length !== 0) {
    addTag(0x6ffffffc, offsets.verdefOff);
    addTag(0x6ffffffd, config.verdef.length);
  }
  if (config.flags1 !== null) addTag(0x6ffffffb, config.flags1);
  addTag(0, 0);
  return concat(...tags);
};

const layoutDependencyImage = (
  config: FixtureConfig,
  tables: DependencyTables,
): DependencyLayout => {
  const headerSize = config.bits === 64 ? 64 : 52;
  const phent = config.bits === 64 ? 56 : 32;
  const shent = config.bits === 64 ? 64 : 40;
  const programCount =
    (config.interpreter === null ? 0 : 1) + 1 + (config.omitDynamic ? 0 : 1);
  const phoff = headerSize;
  let cursor = phoff + programCount * phent;
  const place = (size: number): number => {
    const offset = cursor;
    cursor += size;
    return offset;
  };
  const interpOff =
    config.interpreter === null ? 0 : place(tables.interpBytes.length);
  const hashOff = tables.hash.length === 0 ? 0 : place(tables.hash.length);
  const gnuHashOff =
    tables.gnuHashBytes.length === 0 ? 0 : place(tables.gnuHashBytes.length);
  const dynsymOff = place(tables.dynsym.length);
  const dynstrOff = place(tables.dynstrBytes.length);
  const versymOff = place(tables.versym.length);
  const verneedOff =
    tables.verneedBytes.length === 0 ? 0 : place(tables.verneedBytes.length);
  const verdefOff =
    tables.verdefBytes.length === 0 ? 0 : place(tables.verdefBytes.length);
  const dynamicBytes = config.omitDynamic
    ? Buffer.alloc(0)
    : buildDynamicTags(config, tables, {
        hashOff,
        gnuHashOff,
        dynsymOff,
        dynstrOff,
        versymOff,
        verneedOff,
        verdefOff,
      });
  const dynamicOff = config.omitDynamic ? 0 : place(dynamicBytes.length);
  const shstr = new StringTable();
  for (const name of SECTION_NAMES) shstr.intern(name);
  const shstrBytes = shstr.bytes();
  const shstrOff = config.stripped ? 0 : place(shstrBytes.length);
  const shnum = config.stripped ? 0 : 10;
  const shoff = config.stripped ? 0 : place(shnum * shent);
  return {
    headerSize,
    phent,
    shent,
    programCount,
    phoff,
    interpOff,
    hashOff,
    gnuHashOff,
    dynsymOff,
    dynstrOff,
    versymOff,
    verneedOff,
    verdefOff,
    dynamicBytes,
    dynamicOff,
    shstr,
    shstrBytes,
    shstrOff,
    shnum,
    shoff,
    fileSize: cursor,
  };
};

const writeElfIdent = (
  bytes: Buffer,
  config: FixtureConfig,
  layout: DependencyLayout,
): void => {
  const { bits, little } = config;
  bytes.writeUInt32LE(0x464c457f, 0);
  bytes[4] = bits === 64 ? 2 : 1;
  bytes[5] = little ? 1 : 2;
  bytes[6] = 1;
  write16(bytes, 16, config.type, little);
  write16(bytes, 18, config.machine, little);
  write32(bytes, 20, 1, little);
  writeWord(bytes, bits === 64 ? 32 : 28, layout.phoff, bits, little);
  writeWord(bytes, bits === 64 ? 40 : 32, layout.shoff, bits, little);
  write16(bytes, bits === 64 ? 52 : 40, layout.headerSize, little);
  write16(bytes, bits === 64 ? 54 : 42, layout.phent, little);
  write16(bytes, bits === 64 ? 56 : 44, layout.programCount, little);
  write16(bytes, bits === 64 ? 58 : 46, layout.shent, little);
  write16(bytes, bits === 64 ? 60 : 48, layout.shnum, little);
  write16(
    bytes,
    bits === 64 ? 62 : 50,
    config.stripped ? 0 : layout.shnum - 1,
    little,
  );
};

const copyDependencyPayloads = (
  bytes: Buffer,
  config: FixtureConfig,
  tables: DependencyTables,
  layout: DependencyLayout,
): void => {
  if (config.interpreter !== null)
    tables.interpBytes.copy(bytes, layout.interpOff);
  if (tables.hash.length !== 0) tables.hash.copy(bytes, layout.hashOff);
  if (tables.gnuHashBytes.length !== 0)
    tables.gnuHashBytes.copy(bytes, layout.gnuHashOff);
  tables.dynsym.copy(bytes, layout.dynsymOff);
  tables.dynstrBytes.copy(bytes, layout.dynstrOff);
  tables.versym.copy(bytes, layout.versymOff);
  if (tables.verneedBytes.length !== 0)
    tables.verneedBytes.copy(bytes, layout.verneedOff);
  if (tables.verdefBytes.length !== 0)
    tables.verdefBytes.copy(bytes, layout.verdefOff);
  if (!config.omitDynamic) layout.dynamicBytes.copy(bytes, layout.dynamicOff);
  if (!config.stripped) layout.shstrBytes.copy(bytes, layout.shstrOff);
};

const writeDependencyPrograms = (
  bytes: Buffer,
  config: FixtureConfig,
  tables: DependencyTables,
  layout: DependencyLayout,
): void => {
  let programIndex = 0;
  const add = (
    kind: number,
    flags: number,
    offset: number,
    size: number,
    align: number,
  ): void => {
    writeProgramHeader(
      bytes,
      layout.phoff + programIndex * layout.phent,
      config.bits,
      config.little,
      kind,
      flags,
      offset,
      size,
      align,
    );
    programIndex += 1;
  };
  if (config.interpreter !== null)
    add(3, 4, layout.interpOff, tables.interpBytes.length, 1);
  add(1, 5, 0, layout.fileSize, 0x1000);
  if (!config.omitDynamic)
    add(2, 6, layout.dynamicOff, layout.dynamicBytes.length, 8);
};

const writeDependencySections = (
  bytes: Buffer,
  config: FixtureConfig,
  tables: DependencyTables,
  layout: DependencyLayout,
): void => {
  if (config.stripped) return;
  const alloc = 2;
  const { bits, little } = config;
  const rows: readonly (readonly [
    string,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ])[] = [
    ["", 0, 0, 0, 0, 0, 0, 0, 0],
    [
      ".interp",
      1,
      alloc,
      layout.interpOff,
      layout.interpOff,
      tables.interpBytes.length,
      0,
      0,
      0,
    ],
    [
      ".hash",
      5,
      alloc,
      layout.hashOff,
      layout.hashOff,
      tables.hash.length,
      3,
      0,
      4,
    ],
    [
      ".dynsym",
      11,
      alloc,
      layout.dynsymOff,
      layout.dynsymOff,
      tables.dynsym.length,
      4,
      1,
      bits === 64 ? 24 : 16,
    ],
    [
      ".dynstr",
      3,
      alloc,
      layout.dynstrOff,
      layout.dynstrOff,
      tables.dynstrBytes.length,
      0,
      0,
      0,
    ],
    [
      ".gnu.version",
      0x6fffffff,
      alloc,
      layout.versymOff,
      layout.versymOff,
      tables.versym.length,
      3,
      0,
      2,
    ],
    [
      ".gnu.version_r",
      0x6ffffffe,
      alloc,
      layout.verneedOff,
      layout.verneedOff,
      tables.verneedBytes.length,
      4,
      config.verneed.length,
      0,
    ],
    [
      ".gnu.version_d",
      0x6ffffffd,
      alloc,
      layout.verdefOff,
      layout.verdefOff,
      tables.verdefBytes.length,
      4,
      config.verdef.length,
      0,
    ],
    [
      ".dynamic",
      6,
      alloc,
      layout.dynamicOff,
      layout.dynamicOff,
      layout.dynamicBytes.length,
      4,
      0,
      bits === 64 ? 16 : 8,
    ],
    [".shstrtab", 3, 0, 0, layout.shstrOff, layout.shstrBytes.length, 0, 0, 0],
  ];
  rows.forEach((row, index) => {
    writeSectionHeader(
      bytes,
      layout.shoff + index * layout.shent,
      bits,
      little,
      row[0] === "" ? 0 : layout.shstr.intern(row[0]),
      row[1],
      row[2],
      row[3],
      row[0] === config.displacedSection ? layout.fileSize * 2 : row[4],
      // A multiple of both symbol entry sizes, so the size stays a plausible count.
      row[0] === config.oversizedSection ? layout.fileSize * 48 : row[5],
      row[6],
      row[7],
      row[8],
    );
  });
};

/**
 * Synthetic ET_EXEC/ET_DYN image with identity-mapped PT_LOAD so DT_* virtual
 * addresses equal file offsets. Section headers are optional.
 */
export const elfDependencyFixture = (
  options: ElfDependencyFixtureOptions = {},
): Buffer => {
  const config = fixtureConfig(options);
  const tables = buildDependencyTables(config);
  const layout = layoutDependencyImage(config, tables);
  const bytes = Buffer.alloc(layout.fileSize);
  writeElfIdent(bytes, config, layout);
  writeDependencyPrograms(bytes, config, tables, layout);
  copyDependencyPayloads(bytes, config, tables, layout);
  writeDependencySections(bytes, config, tables, layout);
  return bytes;
};
