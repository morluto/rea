export const EXTENDED_CTOR_SECTION = 0xfff1;

/** Sparse, valid ELF32/ELF64 ET_REL directory whose actual section number equals SHN_ABS. */
export const extendedSymbolInitializers = (bits: 32 | 64): Buffer => {
  const wide = bits === 64;
  const word = bits / 8;
  const headerSize = wide ? 64 : 40;
  const count = EXTENDED_CTOR_SECTION + 1;
  const bytes = Buffer.alloc(0x1000 + count * headerSize);
  const put = (at: number, value: number): void => {
    if (wide) bytes.writeBigUInt64LE(BigInt(value), at);
    else bytes.writeUInt32LE(value, at);
  };
  bytes.set([0x7f, 0x45, 0x4c, 0x46, wide ? 2 : 1, 1, 1]);
  bytes.writeUInt16LE(1, 16);
  bytes.writeUInt16LE(wide ? 62 : 3, 18);
  bytes.writeUInt32LE(1, 20);
  put(wide ? 40 : 32, 0x1000);
  bytes.writeUInt16LE(wide ? 64 : 52, wide ? 52 : 40);
  bytes.writeUInt16LE(headerSize, wide ? 58 : 46);
  bytes.writeUInt16LE(5, wide ? 62 : 50);
  bytes[0x100] = 0xc3; // Inert return instruction; never executed.
  bytes[0x110] = 0xc3;
  const symbolSize = wide ? 24 : 16;
  for (let index = 1; index <= 2; index += 1) {
    const at = 0x240 + (index - 1) * (wide ? 24 : 8);
    put(at, (index - 1) * word);
    if (wide) bytes.writeBigUInt64LE((BigInt(index) << 32n) | 1n, at + 8);
    else bytes.writeUInt32LE((index << 8) | 1, at + 4);
    const symbol = 0x300 + index * symbolSize;
    bytes.writeUInt32LE(index === 1 ? 1 : 11, symbol);
    bytes[symbol + (wide ? 4 : 12)] = 0x12;
    bytes.writeUInt16LE(index === 1 ? 0xffff : 7, symbol + (wide ? 6 : 14));
    put(symbol + (wide ? 16 : 8), 1);
  }
  bytes.writeUInt32LE(EXTENDED_CTOR_SECTION, 0x384);
  const strings = Buffer.from("\0high_ctor\0local_ctor\0");
  strings.copy(bytes, 0x400);
  const names = [
    "",
    ".init_array",
    wide ? ".rela.init_array" : ".rel.init_array",
    ".symtab",
    ".strtab",
    ".shstrtab",
    ".symtab_shndx",
    ".text.local_ctor",
    ".text.high_ctor",
  ];
  const shstr = Buffer.from(`${names.join("\0")}\0`);
  shstr.copy(bytes, 0x500);
  const section = (
    index: number,
    name: number,
    type: number,
    flags: number,
    offset: number,
    size: number,
    link = 0,
    info = 0,
    entry = 0,
  ): void => {
    const at = 0x1000 + index * headerSize;
    bytes.writeUInt32LE(name, at);
    bytes.writeUInt32LE(type, at + 4);
    put(at + 8, flags);
    put(at + (wide ? 24 : 16), offset);
    put(at + (wide ? 32 : 20), size);
    bytes.writeUInt32LE(link, at + (wide ? 40 : 24));
    bytes.writeUInt32LE(info, at + (wide ? 44 : 28));
    put(at + (wide ? 48 : 32), word);
    put(at + (wide ? 56 : 36), entry);
  };
  const offsets = names.map((_, index) =>
    names.slice(0, index).reduce((n, name) => n + name.length + 1, 0),
  );
  // e_shnum=0 stores the real count in section zero; other unused headers are SHT_NULL.
  section(0, 0, 0, 0, 0, count);
  section(1, offsets[1]!, 14, 3, 0x200, 2 * word, 0, 0, word);
  section(
    2,
    offsets[2]!,
    wide ? 4 : 9,
    0,
    0x240,
    wide ? 48 : 16,
    3,
    1,
    wide ? 24 : 8,
  );
  section(3, offsets[3]!, 2, 0, 0x300, 3 * symbolSize, 4, 1, symbolSize);
  section(4, offsets[4]!, 3, 0, 0x400, strings.length);
  section(5, offsets[5]!, 3, 0, 0x500, shstr.length);
  section(6, offsets[6]!, 18, 0, 0x380, 12, 3, 0, 4);
  section(7, offsets[7]!, 1, 6, 0x110, 1);
  section(EXTENDED_CTOR_SECTION, offsets[8]!, 1, 6, 0x100, 1);
  return bytes;
};
