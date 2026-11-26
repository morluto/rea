import { createHash } from "node:crypto";

import { lz4LiteralBlock } from "../../tests/fixtures/lz4LiteralBlock.js";

export const MODULE_ID = Buffer.from(
  "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
  "hex",
);

export interface NsoFixtureOptions {
  /** Loaded bytes for text, rodata, data. */
  readonly segments?: readonly [Buffer, Buffer, Buffer];
  readonly compress?: readonly [boolean, boolean, boolean];
  readonly hashCheck?: readonly [boolean, boolean, boolean];
  /** Store a wrong SHA-256 for this segment index. */
  readonly corruptHash?: number;
  readonly extraFlags?: number;
  /** Drop this many bytes from the end of the file. */
  readonly truncateBy?: number;
}

/** Text starts with a branch and the MOD0 offset at text+4. */
export const defaultText = (): Buffer => {
  const text = Buffer.alloc(32, 0x11);
  text.writeUInt32LE(0x14000002, 0);
  text.writeUInt32LE(0x10, 4);
  text.write("MOD0", 0x10, "latin1");
  return text;
};

export const buildNso = (options: NsoFixtureOptions = {}): Buffer => {
  const segments = options.segments ?? [
    defaultText(),
    Buffer.from("read-only data segment"),
    Buffer.from("writable data"),
  ];
  const compress = options.compress ?? [true, false, true];
  const hashCheck = options.hashCheck ?? [true, true, true];
  const header = Buffer.alloc(0x100);
  header.write("NSO0", 0, "latin1");
  let flags = options.extraFlags ?? 0;
  const stored: Buffer[] = [];
  let fileOffset = 0x100;
  let memoryOffset = 0;
  segments.forEach((loaded, index) => {
    if (compress[index]) flags |= 1 << index;
    if (hashCheck[index]) flags |= 1 << (index + 3);
    const bytes = compress[index] ? lz4LiteralBlock(loaded) : loaded;
    const at = 0x10 + index * 0x10;
    header.writeUInt32LE(fileOffset, at);
    header.writeUInt32LE(memoryOffset, at + 4);
    header.writeUInt32LE(loaded.length, at + 8);
    header.writeUInt32LE(bytes.length, 0x60 + index * 4);
    const digest = createHash("sha256").update(loaded).digest();
    if (options.corruptHash === index)
      digest.writeUInt8(digest.readUInt8(0) ^ 0xff, 0);
    digest.copy(header, 0xa0 + index * 0x20);
    stored.push(bytes);
    fileOffset += bytes.length;
    memoryOffset += 0x1000;
  });
  header.writeUInt32LE(flags >>> 0, 0x0c);
  header.writeUInt32LE(0x40, 0x3c);
  MODULE_ID.copy(header, 0x40);
  const file = Buffer.concat([header, ...stored]);
  return file.subarray(0, file.length - (options.truncateBy ?? 0));
};

export interface NroFixtureOptions {
  readonly assets?: {
    readonly icon?: Buffer;
    readonly nacp?: Buffer;
    readonly romfs?: Buffer;
  };
  readonly trailing?: Buffer;
  readonly truncateBy?: number;
}

export const buildNro = (options: NroFixtureOptions = {}): Buffer => {
  const header = Buffer.alloc(0x80);
  const text = Buffer.alloc(0x20, 0x22);
  text.write("MOD0", 0, "latin1");
  const rodata = Buffer.from("nro rodata");
  const data = Buffer.from("nro data");
  header.writeUInt32LE(0x80, 0x04);
  header.write("NRO0", 0x10, "latin1");
  const textOffset = 0x80;
  const rodataOffset = textOffset + text.length;
  const dataOffset = rodataOffset + rodata.length;
  const size = dataOffset + data.length;
  header.writeUInt32LE(size, 0x18);
  header.writeUInt32LE(textOffset, 0x20);
  header.writeUInt32LE(text.length, 0x24);
  header.writeUInt32LE(rodataOffset, 0x28);
  header.writeUInt32LE(rodata.length, 0x2c);
  header.writeUInt32LE(dataOffset, 0x30);
  header.writeUInt32LE(data.length, 0x34);
  header.writeUInt32LE(0x100, 0x38);
  MODULE_ID.copy(header, 0x40);
  const parts: Buffer[] = [header, text, rodata, data];
  if (options.assets !== undefined) {
    const aset = Buffer.alloc(0x38);
    aset.write("ASET", 0, "latin1");
    let relative = 0x38;
    const payloads: Buffer[] = [];
    (["icon", "nacp", "romfs"] as const).forEach((name, index) => {
      const bytes = options.assets?.[name];
      if (bytes === undefined) return;
      aset.writeBigUInt64LE(BigInt(relative), 0x08 + index * 0x10);
      aset.writeBigUInt64LE(BigInt(bytes.length), 0x10 + index * 0x10);
      payloads.push(bytes);
      relative += bytes.length;
    });
    parts.push(aset, ...payloads);
  }
  if (options.trailing !== undefined) parts.push(options.trailing);
  const file = Buffer.concat(parts);
  return file.subarray(0, file.length - (options.truncateBy ?? 0));
};
