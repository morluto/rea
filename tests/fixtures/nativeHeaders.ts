/**
 * Minimal native headers that decode as inventory and target admission
 * require: a complete ELF64 fixed header, or a thin Mach-O header with an
 * empty load-command table. They carry no code and are never executed.
 */

/** Write an ELF64 little-endian x86-64 fixed header into `bytes` (at least 64 bytes). */
export const writeMinimalElfHeader = (bytes: Uint8Array): void => {
  if (bytes.length < 64) throw new RangeError("An ELF64 header needs 64 bytes");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
  view.setUint16(16, 2, true); // ET_EXEC
  view.setUint16(18, 62, true); // EM_X86_64
  view.setUint32(20, 1, true); // EV_CURRENT
  view.setUint16(52, 64, true); // e_ehsize
};

/** A buffer of `size` bytes beginning with a minimal ELF64 header. */
export const minimalElfImage = (size = 64): Buffer => {
  const bytes = Buffer.alloc(size);
  writeMinimalElfHeader(bytes);
  return bytes;
};

/** Write a thin 64-bit arm64 Mach-O header with no load commands into `bytes`. */
export const writeMinimalMachoHeader = (bytes: Uint8Array): void => {
  if (bytes.length < 32)
    throw new RangeError("A 64-bit Mach-O header needs 32 bytes");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(0, 0xfeedfacf, true);
  view.setUint32(4, 0x0100000c, true); // CPU_TYPE_ARM64
  view.setUint32(12, 2, true); // MH_EXECUTE
};

/** A buffer of `size` bytes beginning with a minimal thin Mach-O header. */
export const minimalMachoImage = (size = 32): Buffer => {
  const bytes = Buffer.alloc(size);
  writeMinimalMachoHeader(bytes);
  return bytes;
};
