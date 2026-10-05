/** Build a minimal ELF header for binary-target parser tests. */
export const elf = (
  class_: number,
  endian: number,
  machine: number,
): Buffer => {
  const bytes = Buffer.alloc(20);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, class_, endian]);
  if (endian === 1) bytes.writeUInt16LE(machine, 18);
  else bytes.writeUInt16BE(machine, 18);
  return bytes;
};

/** Build a minimal thin Mach-O header for binary-target parser tests. */
export const thinMach = (magic: number, cpu: number): Buffer => {
  const bytes = Buffer.alloc(8);
  bytes.writeUInt32BE(magic, 0);
  if (magic === 0xcefaedfe || magic === 0xcffaedfe) bytes.writeUInt32LE(cpu, 4);
  else bytes.writeUInt32BE(cpu, 4);
  return bytes;
};

/** Build a minimal FAT Mach-O table for binary-target parser tests. */
export const fat = (
  cpus: readonly number[],
  declared = cpus.length,
): Buffer => {
  const bytes = Buffer.alloc(8 + cpus.length * 20);
  bytes.writeUInt32BE(0xcafebabe, 0);
  bytes.writeUInt32BE(declared, 4);
  cpus.forEach((cpu, index) => bytes.writeUInt32BE(cpu, 8 + index * 20));
  return bytes;
};

/** Build a bounded PE image with optional managed metadata. */
export const pe = (
  machine: number,
  offset = 64,
  characteristics = 0x0002,
  managed = false,
): Buffer => {
  const optionalHeaderSize =
    machine === 0x014c || machine === 0x01c0 ? 224 : 240;
  const bytes = Buffer.alloc(Math.max(512, offset + 24 + optionalHeaderSize));
  bytes.write("MZ", 0, "ascii");
  bytes.writeUInt32LE(offset, 0x3c);
  bytes.write("PE\0\0", offset, "binary");
  bytes.writeUInt16LE(machine, offset + 4);
  bytes.writeUInt16LE(optionalHeaderSize, offset + 20);
  bytes.writeUInt16LE(characteristics, offset + 22);
  const optionalHeader = offset + 24;
  const pe32 = machine === 0x014c || machine === 0x01c0;
  bytes.writeUInt16LE(pe32 ? 0x10b : 0x20b, optionalHeader);
  const directoryOffset = pe32 ? 96 : 112;
  bytes.writeUInt32LE(16, optionalHeader + directoryOffset - 4);
  if (managed) {
    bytes.writeUInt32LE(0x2000, optionalHeader + directoryOffset + 14 * 8);
    bytes.writeUInt32LE(72, optionalHeader + directoryOffset + 14 * 8 + 4);
  }
  return bytes;
};

/** Build a DOS MZ image with a 32-byte header and a 16-bit entry point. */
export const dosMz = (moduleSize = 128): Buffer => {
  const size = 32 + moduleSize;
  const bytes = Buffer.alloc(size);
  bytes.write("MZ", 0, "ascii");
  bytes.writeUInt16LE(size % 512, 2);
  bytes.writeUInt16LE(Math.ceil(size / 512), 4);
  bytes.writeUInt16LE(2, 8);
  bytes.writeUInt16LE(0xffff, 12);
  bytes.writeUInt16LE(28, 24);
  bytes.set([0xb8, 0x00, 0x4c, 0xcd, 0x21], 32);
  // This is module data, not an e_lfanew field in a Windows DOS stub.
  if (size >= 64) bytes.writeUInt32LE(0xfedcba98, 60);
  return bytes;
};
