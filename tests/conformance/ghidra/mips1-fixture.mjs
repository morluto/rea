import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Source-owned explicit-o32 MIPS I refusal control. Its integer words do not establish load-delay semantics. */
export async function buildMips1Fixture(directory, byteOrder) {
  if (!["little", "big"].includes(byteOrder))
    throw new Error("Unknown fixture byte order");
  const image = Buffer.alloc(0x1188);
  const u16 = (offset, value) =>
    byteOrder === "little"
      ? image.writeUInt16LE(value, offset)
      : image.writeUInt16BE(value, offset);
  const u32 = (offset, value) =>
    byteOrder === "little"
      ? image.writeUInt32LE(value, offset)
      : image.writeUInt32BE(value, offset);
  image.set([0x7f, 0x45, 0x4c, 0x46, 1, byteOrder === "little" ? 1 : 2, 1]);
  u16(16, 2);
  u16(18, 8);
  u32(20, 1);
  u32(24, 0x401000);
  u32(28, 52);
  u32(32, 0x10c0);
  u32(36, 0x1001);
  u16(40, 52);
  u16(42, 32);
  u16(44, 1);
  u16(46, 40);
  u16(48, 5);
  u16(50, 4);
  u32(52, 1);
  u32(56, 0);
  u32(60, 0x400000);
  u32(64, 0x400000);
  u32(68, image.length);
  u32(72, image.length);
  u32(76, 5);
  u32(80, 0x1000);
  // addiu v0,a0,7; beq a0,zero,done; sll v0,v0,1 (delay slot);
  // addiu v0,v0,3; done: jr ra; nop.
  const words = [0x24820007, 0x10800002, 0x00021040, 0x24420003, 0x03e00008, 0];
  words.forEach((word, index) => u32(0x1000 + index * 4, word));
  image.write("\0rea_mips1_entry\0", 0x1040, "ascii");
  u32(0x1070, 1);
  u32(0x1074, 0x401000);
  u32(0x1078, 24);
  image[0x107c] = 0x12;
  u16(0x107e, 1);
  const names = "\0.text\0.symtab\0.strtab\0.shstrtab\0";
  image.write(names, 0x1080, "ascii");
  const section = (
    index,
    name,
    type,
    flags,
    address,
    offset,
    size,
    link,
    info,
    align,
    entrySize,
  ) => {
    const base = 0x10c0 + index * 40;
    [
      names.indexOf(name),
      type,
      flags,
      address,
      offset,
      size,
      link,
      info,
      align,
      entrySize,
    ].forEach((value, n) => u32(base + n * 4, value));
  };
  section(1, ".text", 1, 6, 0x401000, 0x1000, 24, 0, 0, 4, 0);
  section(2, ".symtab", 2, 0, 0, 0x1060, 32, 3, 1, 4, 16);
  section(3, ".strtab", 3, 0, 0, 0x1040, 17, 0, 0, 1, 0);
  section(4, ".shstrtab", 3, 0, 0, 0x1080, names.length, 0, 0, 1, 0);
  const path = join(directory, `mips1-${byteOrder}.elf`);
  await writeFile(path, image);
  return {
    path,
    sha256: createHash("sha256").update(image).digest("hex"),
    byte_order: byteOrder,
    entry: "0x401000",
    words,
  };
}
