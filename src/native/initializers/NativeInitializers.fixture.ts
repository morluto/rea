/** Synthetic ELF and Mach-O images with known initializer slots. */

const elfIdent = (
  file: Buffer,
  bits: 32 | 64,
  type: number,
  machine: number,
): void => {
  file.set([0x7f, 0x45, 0x4c, 0x46, bits === 64 ? 2 : 1, 1, 1], 0);
  file.writeUInt16LE(type, 16);
  file.writeUInt16LE(machine, 18);
  file.writeUInt32LE(1, 20);
};

const phdr64 = (
  file: Buffer,
  at: number,
  type: number,
  flags: number,
  offset: number,
  address: number,
  size: number,
): void => {
  file.writeUInt32LE(type, at);
  file.writeUInt32LE(flags, at + 4);
  file.writeBigUInt64LE(BigInt(offset), at + 8);
  file.writeBigUInt64LE(BigInt(address), at + 16);
  file.writeBigUInt64LE(BigInt(address), at + 24);
  file.writeBigUInt64LE(BigInt(size), at + 32);
  file.writeBigUInt64LE(BigInt(size), at + 40);
  file.writeBigUInt64LE(1n, at + 48);
};

const shdr64 = (
  file: Buffer,
  index: number,
  base: number,
  name: number,
  type: number,
  flags: number,
  address: number,
  offset: number,
  size: number,
  link = 0,
  entsize = 0,
  info = 0,
): void => {
  const at = base + index * 64;
  file.writeUInt32LE(name, at);
  file.writeUInt32LE(type, at + 4);
  file.writeBigUInt64LE(BigInt(flags), at + 8);
  file.writeBigUInt64LE(BigInt(address), at + 16);
  file.writeBigUInt64LE(BigInt(offset), at + 24);
  file.writeBigUInt64LE(BigInt(size), at + 32);
  file.writeUInt32LE(link, at + 40);
  file.writeUInt32LE(info, at + 44);
  file.writeBigUInt64LE(1n, at + 48);
  file.writeBigUInt64LE(BigInt(entsize), at + 56);
};

const sym64 = (
  file: Buffer,
  at: number,
  name: number,
  info: number,
  section: number,
  value: number,
): void => {
  file.writeUInt32LE(name, at);
  file.writeUInt8(info, at + 4);
  file.writeUInt16LE(section, at + 6);
  file.writeBigUInt64LE(BigInt(value), at + 8);
};

const dyn64 = (
  file: Buffer,
  index: number,
  tag: number,
  value: number,
): void => {
  const at = 0x300 + index * 16;
  file.writeBigInt64LE(BigInt(tag), at);
  file.writeBigUInt64LE(BigInt(value), at + 8);
};

const rela64 = (
  file: Buffer,
  at: number,
  offset: number,
  symbol: number,
  type: number,
  addend: number,
): void => {
  file.writeBigUInt64LE(BigInt(offset), at);
  file.writeBigUInt64LE((BigInt(symbol) << 32n) | BigInt(type), at + 8);
  file.writeBigInt64LE(BigInt(addend), at + 16);
};

const cStringTable = (
  names: readonly string[],
): { readonly bytes: Buffer; readonly offsets: number[] } => {
  const offsets: number[] = [];
  const parts: Buffer[] = [Buffer.from([0])];
  let at = 1;
  for (const name of names) {
    offsets.push(at);
    const bytes = Buffer.from(`${name}\0`, "utf8");
    parts.push(bytes);
    at += bytes.length;
  }
  return { bytes: Buffer.concat(parts), offsets };
};

/**
 * ELF64 PIE: DT_INIT, RELATIVE init_array, one import, one RELR fini slot.
 * `needed` prepends that many DT_NEEDED entries, which repeat by design.
 */
export const elf64PieInitializers = (needed = 0): Buffer => {
  const file = Buffer.alloc(0xc00);
  const dynstr = cStringTable(["imp_init"]);
  const strtab = cStringTable(["ctor_a", "ctor_b", "fini_fn"]);
  const shstr = cStringTable([
    ".text",
    ".preinit_array",
    ".init_array",
    ".fini_array",
    ".dynamic",
    ".rela.dyn",
    ".dynsym",
    ".dynstr",
    ".symtab",
    ".strtab",
    ".shstrtab",
  ]);
  elfIdent(file, 64, 3, 62);
  file.writeBigUInt64LE(64n, 32);
  file.writeBigUInt64LE(0x800n, 40);
  file.writeUInt16LE(64, 52);
  file.writeUInt16LE(56, 54);
  file.writeUInt16LE(2, 56);
  file.writeUInt16LE(64, 58);
  file.writeUInt16LE(12, 60);
  file.writeUInt16LE(11, 62);
  phdr64(file, 64, 1, 7, 0, 0, file.length);
  phdr64(file, 120, 2, 6, 0x300, 0x300, (19 + needed) * 16);
  file.writeBigUInt64LE(0x120n, 0x220);
  file.writeBigUInt64LE(0x100n, 0x240);
  [
    ...Array.from({ length: needed }, () => [1, dynstr.offsets[0] ?? 1]),
    [12, 0x100],
    [13, 0x120],
    [25, 0x200],
    [27, 24],
    [26, 0x220],
    [28, 8],
    [32, 0x240],
    [33, 8],
    [7, 0x480],
    [8, 96],
    [9, 24],
    [36, 0x500],
    [35, 8],
    [37, 8],
    [6, 0x520],
    [5, 0x560],
    [10, dynstr.bytes.length],
    [11, 24],
    [0, 0],
  ].forEach(([tag, value], index) => dyn64(file, index, tag ?? 0, value ?? 0));
  rela64(file, 0x480, 0, 0, 0, 0);
  rela64(file, 0x498, 0x200, 0, 8, 0x100);
  rela64(file, 0x4b0, 0x208, 0, 8, 0x110);
  rela64(file, 0x4c8, 0x210, 1, 1, 0);
  file.writeBigUInt64LE(0x220n, 0x500);
  sym64(file, 0x538, dynstr.offsets[0] ?? 1, 0x12, 0, 0);
  sym64(file, 0x598, strtab.offsets[0] ?? 1, 0x12, 1, 0x100);
  sym64(file, 0x5b0, strtab.offsets[1] ?? 8, 0x12, 1, 0x110);
  sym64(file, 0x5c8, strtab.offsets[2] ?? 15, 0x12, 1, 0x120);
  dynstr.bytes.copy(file, 0x560);
  strtab.bytes.copy(file, 0x600);
  shstr.bytes.copy(file, 0x680);
  const name = (index: number): number => shstr.offsets[index] ?? 0;
  shdr64(file, 1, 0x800, name(0), 1, 6, 0x100, 0x100, 0x40);
  shdr64(file, 2, 0x800, name(1), 16, 2, 0x240, 0x240, 8);
  shdr64(file, 3, 0x800, name(2), 14, 2, 0x200, 0x200, 24);
  shdr64(file, 4, 0x800, name(3), 15, 2, 0x220, 0x220, 8);
  shdr64(file, 5, 0x800, name(4), 6, 2, 0x300, 0x300, 19 * 16);
  shdr64(file, 6, 0x800, name(5), 4, 2, 0x480, 0x480, 96, 7, 24);
  shdr64(file, 7, 0x800, name(6), 11, 2, 0x520, 0x520, 48, 8, 24);
  shdr64(file, 8, 0x800, name(7), 3, 2, 0x560, 0x560, dynstr.bytes.length);
  shdr64(file, 9, 0x800, name(8), 2, 0, 0x580, 0x580, 96, 10, 24);
  shdr64(file, 10, 0x800, name(9), 3, 0, 0x600, 0x600, strtab.bytes.length);
  shdr64(file, 11, 0x800, name(10), 3, 0, 0, 0x680, shstr.bytes.length);
  return file;
};

const phdr32 = (
  file: Buffer,
  at: number,
  type: number,
  offset: number,
  address: number,
  size: number,
  flags: number,
): void => {
  file.writeUInt32LE(type, at);
  file.writeUInt32LE(offset, at + 4);
  file.writeUInt32LE(address, at + 8);
  file.writeUInt32LE(address, at + 12);
  file.writeUInt32LE(size, at + 16);
  file.writeUInt32LE(size, at + 20);
  file.writeUInt32LE(flags, at + 24);
  file.writeUInt32LE(1, at + 28);
};

const shdr32 = (
  file: Buffer,
  index: number,
  name: number,
  type: number,
  flags: number,
  address: number,
  offset: number,
  size: number,
  link = 0,
  entsize = 0,
): void => {
  const at = 0x280 + index * 40;
  file.writeUInt32LE(name, at);
  file.writeUInt32LE(type, at + 4);
  file.writeUInt32LE(flags, at + 8);
  file.writeUInt32LE(address, at + 12);
  file.writeUInt32LE(offset, at + 16);
  file.writeUInt32LE(size, at + 20);
  file.writeUInt32LE(link, at + 24);
  file.writeUInt32LE(1, at + 32);
  file.writeUInt32LE(entsize, at + 36);
};

/** ELF32 image whose one init_array slot is an in-place R_386_RELATIVE addend. */
export const elf32RelativeInitializers = (): Buffer => {
  const file = Buffer.alloc(0x480);
  const strtab = cStringTable(["ctor"]);
  const shstr = cStringTable([
    ".text",
    ".init_array",
    ".dynamic",
    ".rel.dyn",
    ".symtab",
    ".strtab",
    ".shstrtab",
  ]);
  elfIdent(file, 32, 3, 3);
  file.writeUInt32LE(52, 28);
  file.writeUInt32LE(0x280, 32);
  file.writeUInt16LE(52, 40);
  file.writeUInt16LE(32, 42);
  file.writeUInt16LE(2, 44);
  file.writeUInt16LE(40, 46);
  file.writeUInt16LE(8, 48);
  file.writeUInt16LE(7, 50);
  phdr32(file, 52, 1, 0, 0, file.length, 7);
  phdr32(file, 84, 2, 0x120, 0x120, 48, 6);
  file.writeUInt32LE(0x80, 0x100);
  [25, 0x100, 27, 4, 17, 0x180, 18, 8, 19, 8, 0, 0].forEach((value, index) => {
    if (index % 2 === 0) file.writeInt32LE(value, 0x120 + index * 4);
    else file.writeUInt32LE(value, 0x120 + index * 4);
  });
  file.writeUInt32LE(0x100, 0x180);
  file.writeUInt32LE(8, 0x184);
  file.writeUInt32LE(strtab.offsets[0] ?? 1, 0x1b0);
  file.writeUInt32LE(0x80, 0x1b4);
  file.writeUInt8(0x12, 0x1bc);
  file.writeUInt16LE(1, 0x1be);
  strtab.bytes.copy(file, 0x1d0);
  shstr.bytes.copy(file, 0x200);
  const name = (index: number): number => shstr.offsets[index] ?? 0;
  shdr32(file, 1, name(0), 1, 6, 0x80, 0x80, 4);
  shdr32(file, 2, name(1), 14, 2, 0x100, 0x100, 4);
  shdr32(file, 3, name(2), 6, 2, 0x120, 0x120, 48);
  shdr32(file, 4, name(3), 9, 2, 0x180, 0x180, 8, 0, 8);
  shdr32(file, 5, name(4), 2, 0, 0x1a0, 0x1a0, 32, 6, 16);
  shdr32(file, 6, name(5), 3, 0, 0x1d0, 0x1d0, strtab.bytes.length);
  shdr32(file, 7, name(6), 3, 0, 0, 0x200, shstr.bytes.length);
  return file;
};

/**
 * ET_REL object: every section starts at address 0. `.ctors` holds sentinel -1,
 * one R_X86_64_64 slot against `ctor`, and sentinel 0. `.init_array` holds one
 * slot against the `.text` section symbol plus addend 8, where `init_b` lives.
 */
export const elfRelocatableCtors = (): Buffer => {
  const file = Buffer.alloc(0x740);
  const strtab = cStringTable(["ctor", "init_b"]);
  const shstr = cStringTable([
    ".text",
    ".ctors",
    ".rela.ctors",
    ".symtab",
    ".strtab",
    ".shstrtab",
    ".init_array",
    ".rela.init_array",
  ]);
  elfIdent(file, 64, 1, 62);
  file.writeBigUInt64LE(0x500n, 40);
  file.writeUInt16LE(64, 52);
  file.writeUInt16LE(64, 58);
  file.writeUInt16LE(9, 60);
  file.writeUInt16LE(6, 62);
  file.writeBigUInt64LE(0xffffffffffffffffn, 0x200);
  rela64(file, 0x300, 8, 1, 1, 0);
  rela64(file, 0x318, 0, 2, 1, 8);
  sym64(file, 0x338, strtab.offsets[0] ?? 1, 0x12, 1, 0);
  sym64(file, 0x350, 0, 0x03, 1, 0);
  sym64(file, 0x368, strtab.offsets[1] ?? 6, 0x12, 1, 8);
  strtab.bytes.copy(file, 0x380);
  shstr.bytes.copy(file, 0x400);
  const name = (index: number): number => shstr.offsets[index] ?? 0;
  shdr64(file, 1, 0x500, name(0), 1, 6, 0, 0x100, 16);
  shdr64(file, 2, 0x500, name(1), 1, 3, 0, 0x200, 24);
  shdr64(file, 3, 0x500, name(2), 4, 0x40, 0, 0x300, 24, 4, 24, 2);
  shdr64(file, 4, 0x500, name(3), 2, 0, 0, 0x320, 96, 5, 24, 2);
  shdr64(file, 5, 0x500, name(4), 3, 0, 0, 0x380, strtab.bytes.length);
  shdr64(file, 6, 0x500, name(5), 3, 0, 0, 0x400, shstr.bytes.length);
  shdr64(file, 7, 0x500, name(6), 14, 3, 0, 0x220, 8);
  shdr64(file, 8, 0x500, name(7), 4, 0x40, 0, 0x318, 24, 4, 24, 7);
  return file;
};

const name16 = (text: string): Buffer => {
  const bytes = Buffer.alloc(16);
  bytes.write(text, 0, "utf8");
  return bytes;
};

const segment64 = (
  file: Buffer,
  at: number,
  name: string,
  address: bigint,
  size: number,
  fileOffset: number,
  protection: number,
  sections: number,
): void => {
  file.writeUInt32LE(0x19, at);
  file.writeUInt32LE(72 + sections * 80, at + 4);
  name16(name).copy(file, at + 8);
  file.writeBigUInt64LE(address, at + 24);
  file.writeBigUInt64LE(BigInt(size), at + 32);
  file.writeBigUInt64LE(BigInt(fileOffset), at + 40);
  file.writeBigUInt64LE(BigInt(size), at + 48);
  file.writeUInt32LE(protection, at + 56);
  file.writeUInt32LE(protection, at + 60);
  file.writeUInt32LE(sections, at + 64);
};

const section64 = (
  file: Buffer,
  at: number,
  section: string,
  segment: string,
  address: bigint,
  size: number,
  offset: number,
  flags: number,
): void => {
  name16(section).copy(file, at);
  name16(segment).copy(file, at + 16);
  file.writeBigUInt64LE(address, at + 32);
  file.writeBigUInt64LE(BigInt(size), at + 40);
  file.writeUInt32LE(offset, at + 48);
  file.writeUInt32LE(3, at + 52);
  file.writeUInt32LE(flags, at + 64);
};

/** Little-endian arm64 image with one chained initializer, one offset, one raw terminator. */
export const machoArm64Initializers = (): Buffer => {
  const file = Buffer.alloc(0x8000);
  const base = 0x100000000n;
  file.writeUInt32LE(0xfeedfacf, 0);
  file.writeUInt32LE(0x0100000c, 4);
  file.writeUInt32LE(2, 12);
  file.writeUInt32LE(4, 16);
  file.writeUInt32LE(504, 20);
  segment64(file, 32, "__TEXT", base, 0x4000, 0, 5, 1);
  section64(file, 104, "__text", "__TEXT", base, 0x2000, 0, 0x80000400);
  segment64(file, 184, "__DATA", base + 0x4000n, 0x4000, 0x4000, 3, 3);
  section64(
    file,
    256,
    "__mod_init_func",
    "__DATA",
    base + 0x4000n,
    8,
    0x4000,
    0x9,
  );
  section64(
    file,
    336,
    "__init_offsets",
    "__DATA",
    base + 0x4010n,
    4,
    0x4010,
    0x16,
  );
  section64(
    file,
    416,
    "__mod_term_func",
    "__DATA",
    base + 0x4020n,
    8,
    0x4020,
    0xa,
  );
  file.writeUInt32LE(0x80000034, 496);
  file.writeUInt32LE(16, 500);
  file.writeUInt32LE(0x3200, 504);
  const starts = Buffer.alloc(36);
  starts.writeUInt32LE(2, 0);
  starts.writeUInt32LE(0, 4);
  starts.writeUInt32LE(12, 8);
  starts.writeUInt32LE(24, 12);
  starts.writeUInt16LE(0x4000, 16);
  starts.writeUInt16LE(6, 18);
  starts.writeBigUInt64LE(0x4000n, 20);
  starts.writeUInt16LE(1, 32);
  const header = Buffer.alloc(28);
  header.writeUInt32LE(28, 4);
  header.writeUInt32LE(28 + starts.length, 8);
  header.writeUInt32LE(28 + starts.length, 12);
  header.writeUInt32LE(1, 20);
  const chained = Buffer.concat([header, starts, Buffer.from([0])]);
  file.writeUInt32LE(chained.length, 508);
  chained.copy(file, 0x3200);
  file.writeUInt32LE(0x2, 512);
  file.writeUInt32LE(24, 516);
  file.writeUInt32LE(0x3000, 520);
  file.writeUInt32LE(2, 524);
  file.writeUInt32LE(0x3100, 528);
  const strings = Buffer.from("\0_init\0_term\0", "utf8");
  file.writeUInt32LE(strings.length, 532);
  strings.copy(file, 0x3100);
  const nlist = (at: number, strx: number, value: bigint): void => {
    file.writeUInt32LE(strx, at);
    file.writeUInt8(0x0f, at + 4);
    file.writeUInt8(1, at + 5);
    file.writeBigUInt64LE(value, at + 8);
  };
  nlist(0x3000, 1, base + 0x1000n);
  nlist(0x3010, 7, base + 0x1100n);
  file.writeBigUInt64LE(0x1000n, 0x4000);
  file.writeUInt32LE(0x1000, 0x4010);
  file.writeBigUInt64LE(base + 0x1100n, 0x4020);
  return file;
};

/** Universal Mach-O whose arm64 slice is `machoArm64Initializers`. */
export const machoArm64FatInitializers = (): Buffer => {
  const thin = machoArm64Initializers();
  const file = Buffer.alloc(0x1000 + thin.length);
  file.writeUInt32BE(0xcafebabe, 0);
  file.writeUInt32BE(1, 4);
  file.writeUInt32BE(0x0100000c, 8);
  file.writeUInt32BE(0, 12);
  file.writeUInt32BE(0x1000, 16);
  file.writeUInt32BE(thin.length, 20);
  file.writeUInt32BE(12, 24);
  thin.copy(file, 0x1000);
  return file;
};

/**
 * The arm64 image with LC_DYLD_INFO_ONLY in place of chained fixups: a legacy
 * rebase opcode covers the `__mod_init_func` slot, which stores its target.
 */
export const machoArm64LegacyRebaseInitializers = (): Buffer => {
  const file = machoArm64Initializers();
  // Turn LC_DYLD_CHAINED_FIXUPS into a 16-byte LC_SOURCE_VERSION.
  file.writeUInt32LE(0x2a, 496);
  file.writeBigUInt64LE(0n, 504);
  // Append LC_DYLD_INFO_ONLY after LC_SYMTAB.
  file.writeUInt32LE(5, 16);
  file.writeUInt32LE(504 + 48, 20);
  file.writeUInt32LE(0x80000022, 536);
  file.writeUInt32LE(48, 540);
  file.writeUInt32LE(0x3300, 544);
  // SET_TYPE_IMM(pointer), SET_SEGMENT_AND_OFFSET_ULEB(__DATA, 0), DO_REBASE_IMM_TIMES(1), DONE.
  const rebase = Buffer.from([0x11, 0x21, 0x00, 0x51, 0x00]);
  file.writeUInt32LE(rebase.length, 548);
  rebase.copy(file, 0x3300);
  file.writeBigUInt64LE(0x100001000n, 0x4000);
  return file;
};

/**
 * i386 MH_EXECUTE with one `__mod_init_func` slot storing `_init` and an
 * LC_DYLD_INFO_ONLY whose bind stream has `bindSize` bytes. 32-bit images have
 * no fixup decoder here.
 */
export const macho32Initializers = (bindSize: number): Buffer => {
  const file = Buffer.alloc(0x2000);
  file.writeUInt32LE(0xfeedface, 0);
  file.writeUInt32LE(7, 4);
  file.writeUInt32LE(3, 8);
  file.writeUInt32LE(2, 12);
  file.writeUInt32LE(4, 16);
  file.writeUInt32LE(320, 20);
  const segment = (
    at: number,
    name: string,
    address: number,
    fileOffset: number,
    protection: number,
  ): void => {
    file.writeUInt32LE(0x1, at);
    file.writeUInt32LE(56 + 68, at + 4);
    name16(name).copy(file, at + 8);
    file.writeUInt32LE(address, at + 24);
    file.writeUInt32LE(0x1000, at + 28);
    file.writeUInt32LE(fileOffset, at + 32);
    file.writeUInt32LE(0x1000, at + 36);
    file.writeUInt32LE(protection, at + 40);
    file.writeUInt32LE(protection, at + 44);
    file.writeUInt32LE(1, at + 48);
  };
  const section = (
    at: number,
    name: string,
    segmentName: string,
    address: number,
    size: number,
    offset: number,
    flags: number,
  ): void => {
    name16(name).copy(file, at);
    name16(segmentName).copy(file, at + 16);
    file.writeUInt32LE(address, at + 32);
    file.writeUInt32LE(size, at + 36);
    file.writeUInt32LE(offset, at + 40);
    file.writeUInt32LE(2, at + 44);
    file.writeUInt32LE(flags, at + 56);
  };
  segment(28, "__TEXT", 0x1000, 0, 5);
  section(84, "__text", "__TEXT", 0x1100, 0x100, 0x100, 0x80000400);
  segment(152, "__DATA", 0x2000, 0x1000, 3);
  section(208, "__mod_init_func", "__DATA", 0x2000, 4, 0x1000, 0x9);
  file.writeUInt32LE(0x80000022, 276);
  file.writeUInt32LE(48, 280);
  file.writeUInt32LE(0x1800, 292);
  file.writeUInt32LE(bindSize, 296);
  file.writeUInt32LE(0x2, 324);
  file.writeUInt32LE(24, 328);
  file.writeUInt32LE(0x1900, 332);
  file.writeUInt32LE(1, 336);
  file.writeUInt32LE(0x1910, 340);
  const strings = Buffer.from("\0_init\0", "utf8");
  file.writeUInt32LE(strings.length, 344);
  file.writeUInt32LE(1, 0x1900);
  file.writeUInt8(0x0f, 0x1904);
  file.writeUInt8(1, 0x1905);
  file.writeUInt32LE(0x1100, 0x1908);
  strings.copy(file, 0x1910);
  file.writeUInt32LE(0x1100, 0x1000);
  return file;
};

/**
 * x86-64 MH_OBJECT: `_before` at 0x0 and `_startup` at 0x10 in `__text`. The
 * first `__mod_init_func` slot stores 0 under an external
 * X86_64_RELOC_UNSIGNED against `_startup`; the second stores 0 under a
 * section-ordinal entry, so its stored address names `_before`.
 */
export const machoX8664ObjectInitializers = (): Buffer => {
  const file = Buffer.alloc(0x300);
  file.writeUInt32LE(0xfeedfacf, 0);
  file.writeUInt32LE(0x01000007, 4);
  file.writeUInt32LE(3, 8);
  file.writeUInt32LE(1, 12);
  file.writeUInt32LE(2, 16);
  file.writeUInt32LE(72 + 2 * 80 + 24, 20);
  segment64(file, 32, "", 0n, 0x30, 0x200, 7, 2);
  section64(file, 104, "__text", "__TEXT", 0n, 0x20, 0x200, 0x80000400);
  section64(file, 184, "__mod_init_func", "__DATA", 0x20n, 16, 0x220, 0x9);
  file.writeUInt32LE(0x240, 184 + 56);
  file.writeUInt32LE(2, 184 + 60);
  // r_address 0, r_symbolnum 1 (_startup), r_length 3, r_extern 1, UNSIGNED.
  file.writeUInt32LE(0, 0x240);
  file.writeUInt32LE(1 | (3 << 25) | (1 << 27), 0x244);
  // r_address 8, r_symbolnum 1 (section __text), r_length 3, r_extern 0.
  file.writeUInt32LE(8, 0x248);
  file.writeUInt32LE(1 | (3 << 25), 0x24c);
  file.writeUInt32LE(0x2, 264);
  file.writeUInt32LE(24, 268);
  file.writeUInt32LE(0x250, 272);
  file.writeUInt32LE(2, 276);
  file.writeUInt32LE(0x270, 280);
  const strings = Buffer.from("\0_before\0_startup\0", "utf8");
  file.writeUInt32LE(strings.length, 284);
  const nlist = (at: number, strx: number, value: bigint): void => {
    file.writeUInt32LE(strx, at);
    file.writeUInt8(0x0e, at + 4);
    file.writeUInt8(1, at + 5);
    file.writeBigUInt64LE(value, at + 8);
  };
  nlist(0x250, 1, 0n);
  nlist(0x260, 9, 0x10n);
  strings.copy(file, 0x270);
  return file;
};

/** Sparse bind runs bracket the initializer slots without binding any of them. */
export const machoSparseBindInitializers = (count: number): Buffer => {
  const uleb = (value: number): Buffer => {
    let n = BigInt(value);
    const out: number[] = [];
    do {
      const byte = Number(n & 127n);
      n >>= 7n;
      out.push(byte | (n > 0n ? 128 : 0));
    } while (n > 0n);
    return Buffer.from(out);
  };
  const parts: Buffer[] = [Buffer.from([0x51, 0x40, 0x5f, 0x78, 0])];
  for (let index = 0; index < count; index++)
    parts.push(
      Buffer.from([0x71]),
      uleb(index * 8),
      Buffer.from([0xc0]),
      uleb(2),
      uleb(count * 32 - 8),
    );
  parts.push(Buffer.from([0]));
  const stream = Buffer.concat(parts);
  const dataSize = count * 64;
  const bindOffset = 0x4000 + dataSize;
  const image = Buffer.alloc(bindOffset + stream.length);
  machoArm64LegacyRebaseInitializers().copy(image);
  image.writeBigUInt64LE(BigInt(dataSize), 184 + 32);
  image.writeBigUInt64LE(BigInt(dataSize), 184 + 48);
  image.writeBigUInt64LE(0x100004000n + BigInt(count * 8), 256 + 32);
  image.writeBigUInt64LE(BigInt(count * 8), 256 + 40);
  image.writeUInt32LE(0x4000 + count * 8, 256 + 48);
  image.writeUInt32LE(0, 548);
  image.writeUInt32LE(bindOffset, 552);
  image.writeUInt32LE(stream.length, 556);
  stream.copy(image, bindOffset);
  return image;
};
