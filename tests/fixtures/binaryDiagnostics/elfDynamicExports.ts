/** Authored ELF load image whose export tables are declared only by PT_DYNAMIC. */
export const elfDynamicExportsImage = (
  options: {
    readonly bits?: 32 | 64;
    readonly little?: boolean;
    readonly hash?: "sysv" | "gnu" | "both" | "none";
    readonly versions?: readonly number[];
    readonly emptyGnuBuckets?: boolean;
  } = {},
): Buffer => {
  const bits = options.bits ?? 64;
  const little = options.little ?? true;
  const wide = bits === 64;
  const wordBytes = wide ? 8 : 4;
  const symbolWidth = wide ? 24 : 16;
  const programWidth = wide ? 56 : 32;
  const dynamicWidth = wordBytes * 2;
  const headerBytes = wide ? 64 : 52;
  const bytes = Buffer.alloc(0x800);
  const base = 0x10000;
  const u16 = (at: number, value: number): void => {
    if (little) bytes.writeUInt16LE(value, at);
    else bytes.writeUInt16BE(value, at);
  };
  const u32 = (at: number, value: number): void => {
    if (little) bytes.writeUInt32LE(value, at);
    else bytes.writeUInt32BE(value, at);
  };
  const word = (at: number, value: number): void => {
    if (!wide) u32(at, value);
    else if (little) bytes.writeBigUInt64LE(BigInt(value), at);
    else bytes.writeBigUInt64BE(BigInt(value), at);
  };
  bytes.set([0x7f, 0x45, 0x4c, 0x46, wide ? 2 : 1, little ? 1 : 2, 1]);
  u16(16, 3);
  u16(18, wide ? (little ? 62 : 21) : 40);
  u32(20, 1);
  word(wide ? 32 : 28, headerBytes);
  u16(wide ? 52 : 40, headerBytes);
  u16(wide ? 54 : 42, programWidth);
  u16(wide ? 56 : 44, 2);
  u16(wide ? 58 : 46, wide ? 64 : 40);

  const program = (
    index: number,
    type: number,
    offset: number,
    size: number,
  ) => {
    const at = headerBytes + index * programWidth;
    u32(at, type);
    if (wide) u32(at + 4, 4);
    word(at + (wide ? 8 : 4), offset);
    word(at + (wide ? 16 : 8), base + offset);
    word(at + (wide ? 24 : 12), base + offset);
    word(at + (wide ? 32 : 16), size);
    word(at + (wide ? 40 : 20), size);
    if (!wide) u32(at + 24, 4);
    word(at + (wide ? 48 : 28), wordBytes);
  };
  program(0, 1, 0, bytes.length);

  const symbols = 0x200;
  const strings = 0x280;
  const sysv = 0x300;
  const gnu = 0x340;
  const versions = 0x380;
  const dynamic = 0x400;
  const names = ["exported_answer", "exported_state"];
  let nameOffset = 1;
  for (const [index, name] of names.entries()) {
    const at = symbols + (index + 1) * symbolWidth;
    u32(at, nameOffset);
    bytes[at + (wide ? 4 : 12)] = 0x10 | (index === 0 ? 2 : 1);
    u16(at + (wide ? 6 : 14), 1);
    word(at + (wide ? 8 : 4), base + 0x700 + index * 16);
    word(at + (wide ? 16 : 8), index === 0 ? 16 : 4);
    bytes.write(`${name}\0`, strings + nameOffset, "utf8");
    nameOffset += Buffer.byteLength(name) + 1;
  }
  // One SysV bucket and three chains, including STN_UNDEF at index zero.
  u32(sysv, 1);
  u32(sysv + 4, 3);
  u32(sysv + 8, 1);
  u32(sysv + 16, 2);
  // One GNU bucket with the two exported symbols in its contiguous chain.
  u32(gnu, 1);
  u32(gnu + 4, 1);
  u32(gnu + 8, 1);
  u32(gnu + 12, 5);
  const hashes = names.map((name) => {
    let hash = 5381;
    for (const byte of Buffer.from(name)) hash = (hash * 33 + byte) >>> 0;
    return hash;
  });
  let bloom = 0n;
  for (const hash of hashes)
    bloom |= (1n << BigInt(hash % bits)) | (1n << BigInt((hash >>> 5) % bits));
  if (!wide) u32(gnu + 16, Number(bloom));
  else if (little) bytes.writeBigUInt64LE(bloom, gnu + 16);
  else bytes.writeBigUInt64BE(bloom, gnu + 16);
  u32(gnu + 16 + wordBytes, options.emptyGnuBuckets === true ? 0 : 1);
  u32(gnu + 20 + wordBytes, ((hashes[0] ?? 0) & ~1) >>> 0);
  u32(gnu + 24 + wordBytes, ((hashes[1] ?? 0) | 1) >>> 0);
  const tags: [number, number][] = [
    [6, base + symbols],
    [11, symbolWidth],
    [5, base + strings],
    [10, nameOffset],
  ];
  const hash = options.hash ?? "sysv";
  if (hash === "sysv" || hash === "both") tags.push([4, base + sysv]);
  if (hash === "gnu" || hash === "both") tags.push([0x6ffffef5, base + gnu]);
  if (options.versions !== undefined) {
    for (const [index, value] of options.versions.entries())
      u16(versions + index * 2, value);
    tags.push([0x6ffffff0, base + versions]);
  }
  tags.push([0, 0]);
  for (const [index, [tag, value]] of tags.entries()) {
    word(dynamic + index * dynamicWidth, tag);
    word(dynamic + index * dynamicWidth + wordBytes, value);
  }
  program(1, 2, dynamic, tags.length * dynamicWidth);
  return bytes;
};
