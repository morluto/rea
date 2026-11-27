import { write32, write64 } from "../../native/BinaryInteger.fixture.js";

export const writeMachoName = (
  bytes: Buffer,
  offset: number,
  name: string,
): void => {
  bytes.write(name, offset, Math.min(name.length, 16), "latin1");
};

/** A thin Mach-O image with one segment and one section per payload. */
export const machoSectionCarrier = (
  blobs: readonly Buffer[],
  options: {
    readonly wide: boolean;
    readonly little: boolean;
    readonly cpuType: number;
    readonly segmentName: string;
    readonly sectionName: string;
    readonly maxProtection: number;
    readonly initialProtection: number;
  },
): Buffer => {
  const { wide, little } = options;
  const headerSize = wide ? 32 : 28;
  const segmentHeader = wide ? 72 : 56;
  const sectionSize = wide ? 80 : 68;
  const cmdsize = segmentHeader + blobs.length * sectionSize;
  const payloadAt = headerSize + cmdsize;
  let payloadSize = 0;
  for (const blob of blobs) payloadSize += blob.length;
  const image = Buffer.alloc(payloadAt + payloadSize);
  write32(image, 0, wide ? 0xfeedfacf : 0xfeedface, little);
  write32(image, 4, options.cpuType, little);
  write32(image, 12, 2, little);
  write32(image, 16, 1, little);
  write32(image, 20, cmdsize, little);
  const command = headerSize;
  write32(image, command, wide ? 0x19 : 0x1, little);
  write32(image, command + 4, cmdsize, little);
  writeMachoName(image, command + 8, options.segmentName);
  if (wide) {
    write64(image, command + 32, payloadSize, little);
    write64(image, command + 40, payloadAt, little);
    write64(image, command + 48, payloadSize, little);
    write32(image, command + 56, options.maxProtection, little);
    write32(image, command + 60, options.initialProtection, little);
    write32(image, command + 64, blobs.length, little);
  } else {
    write32(image, command + 28, payloadSize, little);
    write32(image, command + 32, payloadAt, little);
    write32(image, command + 36, payloadSize, little);
    write32(image, command + 40, options.maxProtection, little);
    write32(image, command + 44, options.initialProtection, little);
    write32(image, command + 48, blobs.length, little);
  }
  let fileOffset = payloadAt;
  blobs.forEach((blob, index) => {
    const section = command + segmentHeader + index * sectionSize;
    writeMachoName(image, section, options.sectionName);
    writeMachoName(image, section + 16, options.segmentName);
    if (wide) {
      write64(image, section + 40, blob.length, little);
      write32(image, section + 48, fileOffset, little);
    } else {
      write32(image, section + 36, blob.length, little);
      write32(image, section + 40, fileOffset, little);
    }
    blob.copy(image, fileOffset);
    fileOffset += blob.length;
  });
  return image;
};
