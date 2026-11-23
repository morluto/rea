/** Source-authored thin arm64 Mach-O with class, ordinary bind, and raw pointer slots. */
export const nativeObjcClassImportMachO = (
  source: "bind" | "chained" = "bind",
) => {
  const address = "0x100001000";
  const nonClassAddress = "0x100001008";
  const unboundAddress = "0x100001010";
  const bindStream = Buffer.from([
    0x11, // Set dylib ordinal 1.
    0x40,
    ...Buffer.from("_OBJC_CLASS_$_Document\0"),
    0x51, // Set pointer bind type.
    0x71,
    0x00, // Segment 1, offset 0.
    0x90, // Bind class slot and advance.
    0x40,
    ...Buffer.from("_free\0"),
    0x90, // Bind an ordinary symbol at the next slot.
    0x00,
  ]);
  const bindOffset = 0x300;
  const slotOffset = 0x400;
  const bytes = Buffer.alloc(slotOffset + 24);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(0, 0xfeedfacf, true);
  view.setUint32(4, 0x0100000c, true); // CPU_TYPE_ARM64
  view.setUint32(8, 0, true); // CPU_SUBTYPE_ARM64_ALL
  view.setUint32(12, 2, true); // MH_EXECUTE
  view.setUint32(16, 4, true);

  const writeSegment = (
    at: number,
    name: string,
    vmAddress: bigint,
    fileOffset: number,
    fileSize: number,
    protection: number,
  ) => {
    view.setUint32(at, 0x19, true); // LC_SEGMENT_64
    view.setUint32(at + 4, 72, true);
    bytes.write(name, at + 8, "ascii");
    view.setBigUint64(at + 24, vmAddress, true);
    view.setBigUint64(at + 32, BigInt(fileSize), true);
    view.setBigUint64(at + 40, BigInt(fileOffset), true);
    view.setBigUint64(at + 48, BigInt(fileSize), true);
    view.setUint32(at + 56, 7, true);
    view.setUint32(at + 60, protection, true);
  };

  const text = 32;
  writeSegment(text, "__TEXT", 0x100000000n, 0, slotOffset, 5);
  const data = text + 72;
  writeSegment(data, "__DATA", 0x100001000n, slotOffset, 24, 3);

  const dylib = data + 72;
  const library = Buffer.from(
    "/System/Library/Frameworks/AppKit.framework/AppKit\0",
  );
  const dylibSize = Math.ceil((24 + library.length) / 8) * 8;
  view.setUint32(dylib, 0x0c, true); // LC_LOAD_DYLIB
  view.setUint32(dylib + 4, dylibSize, true);
  view.setUint32(dylib + 8, 24, true);
  bytes.set(library, dylib + 24);

  const dyld = dylib + dylibSize;
  view.setUint32(20, 72 + 72 + dylibSize + (source === "bind" ? 48 : 16), true);
  if (source === "bind") {
    view.setUint32(dyld, 0x80000022, true); // LC_DYLD_INFO_ONLY
    view.setUint32(dyld + 4, 48, true);
    view.setUint32(dyld + 16, bindOffset, true);
    view.setUint32(dyld + 20, bindStream.length, true);
    bytes.set(bindStream, bindOffset);
  } else {
    const symbols = Buffer.from("_OBJC_CLASS_$_Document\0");
    const payload = Buffer.alloc(68 + symbols.length);
    payload.writeUInt32LE(28, 4); // Starts table.
    payload.writeUInt32LE(64, 8); // Imports table.
    payload.writeUInt32LE(68, 12); // Symbol pool.
    payload.writeUInt32LE(1, 16); // One import.
    payload.writeUInt32LE(1, 20); // DYLD_CHAINED_IMPORT.
    payload.writeUInt32LE(2, 28); // Two segments.
    payload.writeUInt32LE(12, 36); // Only __DATA has starts.
    payload.writeUInt32LE(24, 40);
    payload.writeUInt16LE(0x1000, 44);
    payload.writeUInt16LE(6, 46); // DYLD_CHAINED_PTR_64_OFFSET.
    payload.writeBigUInt64LE(0x1000n, 48); // __DATA offset from image base.
    payload.writeUInt16LE(1, 60); // One page starting at slot zero.
    payload.writeUInt32LE(1, 64); // Dylib 1, symbol at pool offset zero.
    symbols.copy(payload, 68);
    view.setUint32(dyld, 0x80000034, true); // LC_DYLD_CHAINED_FIXUPS
    view.setUint32(dyld + 4, 16, true);
    view.setUint32(dyld + 8, bindOffset, true);
    view.setUint32(dyld + 12, payload.length, true);
    payload.copy(bytes, bindOffset);
    view.setBigUint64(slotOffset, 1n << 63n, true); // Terminal bind to import 0.
  }

  return {
    bytes,
    address,
    nonClassAddress,
    unboundAddress,
    slotOffset,
    bindOffset,
    dyldCommandOffset: dyld,
  };
};
