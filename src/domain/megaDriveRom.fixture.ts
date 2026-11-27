import {
  MEGA_DRIVE_SMD_BLOCK_BYTES,
  MEGA_DRIVE_SMD_HEADER_BYTES,
  megaDriveWordSum,
} from "./megaDriveRom.js";

export interface MegaDriveRomBuild {
  readonly imageBytes?: number;
  readonly system?: string;
  readonly copyright?: string;
  readonly domesticTitle?: string;
  readonly overseasTitle?: string;
  readonly serial?: string;
  readonly revision?: string;
  readonly devices?: string;
  readonly regions?: string;
  readonly modem?: string;
  readonly memo?: string;
  readonly romStart?: number;
  readonly romEnd?: number;
  readonly ramStart?: number;
  readonly ramEnd?: number;
  readonly initialSsp?: number;
  readonly resetPc?: number;
  /** Stored checksum. Omitted, the word sum of this image is written. */
  readonly checksum?: number;
  /** Twelve bytes at 0x1B0. Omitted, the field stays zero and RAM is absent. */
  readonly externalRam?: Uint8Array;
}

const writeAscii = (
  image: Buffer,
  offset: number,
  length: number,
  text: string,
): void => {
  image.fill(0x20, offset, offset + length);
  image.write(text.slice(0, length), offset, "ascii");
};

/** A synthetic linear Mega Drive image. No copyrighted ROM bytes. */
export const megaDriveRom = (build: MegaDriveRomBuild = {}): Buffer => {
  const imageBytes = build.imageBytes ?? 0x400;
  if (imageBytes < 0x200)
    throw new Error(
      "megaDriveRom image must cover the vector table and header",
    );
  const image = Buffer.alloc(imageBytes, 0);
  const initialSsp = build.initialSsp ?? 0x00ff_0000;
  const resetPc = build.resetPc ?? 0x200;
  image.writeUInt32BE(initialSsp, 0);
  image.writeUInt32BE(resetPc, 4);
  for (let index = 2; index < 64; index += 1)
    image.writeUInt32BE(0x1000 + index * 4, index * 4);
  writeAscii(image, 0x100, 16, build.system ?? "SEGA MEGA DRIVE");
  writeAscii(image, 0x110, 16, build.copyright ?? "(C)REA 2026.11");
  writeAscii(image, 0x120, 48, build.domesticTitle ?? "SYNTHETIC DOMESTIC");
  writeAscii(image, 0x150, 48, build.overseasTitle ?? "SYNTHETIC OVERSEAS");
  writeAscii(image, 0x180, 12, build.serial ?? "GM 00000000");
  writeAscii(image, 0x18c, 2, build.revision ?? "00");
  writeAscii(image, 0x190, 16, build.devices ?? "J");
  const romStart = build.romStart ?? 0;
  const romEnd = build.romEnd ?? imageBytes - 1;
  image.writeUInt32BE(romStart >>> 0, 0x1a0);
  image.writeUInt32BE(romEnd >>> 0, 0x1a4);
  image.writeUInt32BE((build.ramStart ?? 0x00ff_0000) >>> 0, 0x1a8);
  image.writeUInt32BE((build.ramEnd ?? 0x00ff_ffff) >>> 0, 0x1ac);
  if (build.externalRam !== undefined) {
    const field = image.subarray(0x1b0, 0x1bc);
    field.set(build.externalRam.subarray(0, field.length));
  }
  writeAscii(image, 0x1bc, 12, build.modem ?? "");
  writeAscii(image, 0x1c8, 40, build.memo ?? "");
  writeAscii(image, 0x1f0, 16, build.regions ?? "JUE");
  for (let offset = 0x200; offset < image.length; offset += 1)
    image[offset] = offset & 0xff;
  image.writeUInt16BE(
    build.checksum ??
      megaDriveWordSum(image, (romEnd & 0x00ff_ffff) >>> 0).computed,
    0x18e,
  );
  return image;
};

/** Twelve-byte external RAM field with the `RA` marker and a known type byte. */
export const megaDriveExternalRam = (
  type: number,
  start: number,
  end: number,
): Buffer => {
  const bytes = Buffer.alloc(12, 0x20);
  bytes[0] = 0x52;
  bytes[1] = 0x41;
  bytes[2] = type & 0xff;
  bytes.writeUInt32BE(start >>> 0, 4);
  bytes.writeUInt32BE(end >>> 0, 8);
  return bytes;
};

/**
 * Interleave a linear image into an SMD copier dump. `plain.length` must be a
 * multiple of 16 KiB. Byte 0 is the block count modulo 256, byte 1 is the
 * copier ID `0x03`, and byte 2 is the split flag (`0x40` means more parts
 * follow).
 */
export const interleaveMegaDriveSmd = (
  plain: Uint8Array,
  splitFlag = 0,
): Buffer => {
  if (plain.length % MEGA_DRIVE_SMD_BLOCK_BYTES !== 0)
    throw new Error("SMD fixture image must be a multiple of 16 KiB");
  const blocks = plain.length / MEGA_DRIVE_SMD_BLOCK_BYTES;
  const file = Buffer.alloc(MEGA_DRIVE_SMD_HEADER_BYTES + plain.length);
  file[0] = blocks & 0xff;
  file[1] = 0x03;
  file[2] = splitFlag & 0xff;
  file[8] = 0xaa;
  file[9] = 0xbb;
  const half = MEGA_DRIVE_SMD_BLOCK_BYTES / 2;
  for (let block = 0; block < blocks; block += 1) {
    const src = block * MEGA_DRIVE_SMD_BLOCK_BYTES;
    const dst = MEGA_DRIVE_SMD_HEADER_BYTES + src;
    for (let index = 0; index < half; index += 1) {
      file[dst + index] = plain[src + index * 2 + 1] ?? 0;
      file[dst + half + index] = plain[src + index * 2] ?? 0;
    }
  }
  return file;
};
