/** Encode one sBPF word: opcode, register pair, i16 offset, i32 immediate. */
const word = (
  opcode: number,
  dst: number,
  src: number,
  offset: number,
  imm: number,
): Buffer => {
  const bytes = Buffer.alloc(8);
  bytes[0] = opcode;
  bytes[1] = dst | (src << 4);
  bytes.writeInt16LE(offset, 2);
  bytes.writeUInt32LE(imm >>> 0, 4);
  return bytes;
};

/**
 * Minimal little-endian sBPF ELF whose .text dispatches on the
 * create_config Anchor discriminator (c9cff3724b6f2fbd) through the
 * lddw + register-compare idiom, then exits.
 */
export const solanaDispatchElf = (): Buffer => {
  const text = Buffer.concat([
    word(0x79, 3, 2, 0, 0),
    word(0x18, 4, 0, 0, 0x72f3cfc9),
    word(0x00, 0, 0, 0, 0xbd2f6f4b),
    word(0x1d, 3, 4, 5, 0),
    word(0x95, 0, 0, 0, 0),
  ]);
  const shstrtab = Buffer.from("\0.text\0.shstrtab\0", "latin1");
  const textOffset = 64;
  const shstrtabOffset = textOffset + text.length;
  const sectionHeaderOffset = shstrtabOffset + shstrtab.length;
  const bytes = Buffer.alloc(sectionHeaderOffset + 3 * 64);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
  bytes.writeUInt16LE(3, 16);
  bytes.writeUInt16LE(263, 18);
  bytes.writeBigUInt64LE(0x100n, 24);
  bytes.writeBigUInt64LE(BigInt(sectionHeaderOffset), 40);
  bytes.writeUInt16LE(56, 54);
  bytes.writeUInt16LE(64, 58);
  bytes.writeUInt16LE(3, 60);
  bytes.writeUInt16LE(2, 62);
  text.copy(bytes, textOffset);
  shstrtab.copy(bytes, shstrtabOffset);
  const section = (
    index: number,
    name: number,
    address: number,
    offset: number,
    size: number,
  ): void => {
    const base = sectionHeaderOffset + index * 64;
    bytes.writeUInt32LE(name, base);
    bytes.writeUInt32LE(1, base + 4);
    bytes.writeBigUInt64LE(6n, base + 8);
    bytes.writeBigUInt64LE(BigInt(address), base + 16);
    bytes.writeBigUInt64LE(BigInt(offset), base + 24);
    bytes.writeBigUInt64LE(BigInt(size), base + 32);
  };
  section(1, 1, 0x100, textOffset, text.length);
  section(2, 7, 0, shstrtabOffset, shstrtab.length);
  return bytes;
};
