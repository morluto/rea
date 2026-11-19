/** Inert RV32/RV64 ELF with RELA constructors and a RELR finalizer. */
export const riscvInitializers = (
  bits: 32 | 64,
  {
    definedSymbolIsTls = false,
  }: { readonly definedSymbolIsTls?: boolean } = {},
): Buffer => {
  const bytes = Buffer.alloc(0xc00);
  const word = bits / 8;
  const wide = bits === 64;
  const put = (at: number, value: number): void => {
    if (wide) bytes.writeBigUInt64LE(BigInt(value), at);
    else bytes.writeUInt32LE(value, at);
  };
  bytes.set([0x7f, 0x45, 0x4c, 0x46, wide ? 2 : 1, 1, 1]);
  bytes.writeUInt16LE(3, 16);
  bytes.writeUInt16LE(243, 18);
  bytes.writeUInt32LE(1, 20);
  put(wide ? 32 : 28, wide ? 64 : 52);
  put(wide ? 40 : 32, 0x800);
  for (const [at, value] of [
    [wide ? 52 : 40, wide ? 64 : 52],
    [wide ? 54 : 42, wide ? 56 : 32],
    [wide ? 56 : 44, 2],
    [wide ? 58 : 46, wide ? 64 : 40],
    [wide ? 60 : 48, 9],
    [wide ? 62 : 50, 8],
  ] as const)
    bytes.writeUInt16LE(value, at);
  const tags = [
    [25, 0x200],
    [27, 3 * word], // INIT_ARRAY/SZ
    [26, 0x200 + 3 * word],
    [28, word], // FINI_ARRAY/SZ
    [7, 0x400],
    [8, 9 * word],
    [9, 3 * word], // RELA/SZ/ENT
    [36, 0x500],
    [35, word],
    [37, word], // RELR/SZ/ENT
    [6, 0x600],
    [11, wide ? 24 : 16],
    [5, 0x680],
    [10, 26],
    [0, 0],
  ];
  for (let index = 0; index < 2; index += 1) {
    const at = (wide ? 64 : 52) + index * (wide ? 56 : 32);
    bytes.writeUInt32LE(index === 0 ? 1 : 2, at);
    if (wide) bytes.writeUInt32LE(index === 0 ? 7 : 6, at + 4);
    put(at + (wide ? 8 : 4), index === 0 ? 0 : 0x300);
    put(at + (wide ? 16 : 8), index === 0 ? 0 : 0x300);
    put(at + (wide ? 24 : 12), index === 0 ? 0 : 0x300);
    put(
      at + (wide ? 32 : 16),
      index === 0 ? bytes.length : tags.length * word * 2,
    );
    put(
      at + (wide ? 40 : 20),
      index === 0 ? bytes.length : tags.length * word * 2,
    );
    if (!wide) bytes.writeUInt32LE(index === 0 ? 7 : 6, at + 24);
    put(at + (wide ? 48 : 28), word);
  }
  bytes.writeUInt32LE(0x8067, 0x100); // jalr zero, 0(ra); never executed.
  put(0x200 + 3 * word, 0x100);
  tags.forEach(([tag, value], index) => {
    put(0x300 + index * word * 2, tag!);
    put(0x300 + index * word * 2 + word, value!);
  });
  const relocations = [
    [0x200, 0, 3, 0x100], // RELATIVE
    [0x200 + word, 1, wide ? 2 : 1, 0], // Defined absolute
    [0x200 + 2 * word, 2, wide ? 2 : 1, 0], // Imported absolute
  ] as const;
  relocations.forEach(([offset, symbol, kind, addend], index) => {
    const at = 0x400 + index * 3 * word;
    put(at, offset);
    if (wide)
      bytes.writeBigUInt64LE((BigInt(symbol) << 32n) | BigInt(kind), at + word);
    else bytes.writeUInt32LE((symbol << 8) | kind, at + word);
    put(at + 2 * word, addend);
  });
  put(0x500, 0x200 + 3 * word);
  const symbolSize = wide ? 24 : 16;
  for (let index = 1; index <= 2; index += 1) {
    const at = 0x600 + index * symbolSize;
    bytes.writeUInt32LE(index === 1 ? 1 : 12, at);
    bytes[at + (wide ? 4 : 12)] =
      index === 1 && definedSymbolIsTls ? 0x16 : 0x12;
    bytes.writeUInt16LE(index === 1 ? 1 : 0, at + (wide ? 6 : 14));
    put(at + (wide ? 8 : 4), index === 1 ? 0x100 : 0);
  }
  const strings = Buffer.from("\0local_ctor\0external_ctor\0");
  strings.copy(bytes, 0x680);
  const names = [
    "",
    ".text",
    ".init_array",
    ".fini_array",
    ".dynamic",
    ".rela.dyn",
    ".dynsym",
    ".dynstr",
    ".shstrtab",
  ];
  const shstr = Buffer.from(`${names.join("\0")}\0`);
  shstr.copy(bytes, 0x700);
  const sections = [
    [1, 6, 0x100, 4, 0, 0],
    [14, 3, 0x200, 3 * word, 0, word],
    [15, 3, 0x200 + 3 * word, word, 0, word],
    [6, 3, 0x300, tags.length * 2 * word, 7, 2 * word],
    [4, 2, 0x400, 9 * word, 6, 3 * word],
    [11, 2, 0x600, 3 * symbolSize, 7, symbolSize],
    [3, 2, 0x680, strings.length, 0, 0],
    [3, 0, 0x700, shstr.length, 0, 0],
  ];
  let nameOffset = 1;
  sections.forEach(([type, flags, offset, size, link, entry], index) => {
    const at = 0x800 + (index + 1) * (wide ? 64 : 40);
    bytes.writeUInt32LE(nameOffset, at);
    bytes.writeUInt32LE(type!, at + 4);
    put(at + 8, flags!);
    put(at + (wide ? 16 : 12), flags === 0 ? 0 : offset!);
    put(at + (wide ? 24 : 16), offset!);
    put(at + (wide ? 32 : 20), size!);
    bytes.writeUInt32LE(link!, at + (wide ? 40 : 24));
    bytes.writeUInt32LE(index === 5 ? 1 : 0, at + (wide ? 44 : 28));
    put(at + (wide ? 48 : 32), word);
    put(at + (wide ? 56 : 36), entry!);
    nameOffset += names[index + 1]!.length + 1;
  });
  return bytes;
};
