import { crc32 } from "node:zlib";
/** Synthetic descriptor ABI fixture; deliberately no production firmware identifiers. */
export function structuredRasterFixture(): Buffer {
  const table = Buffer.alloc(12 * 12);
  const payload: number[] = [];
  for (let i = 0; i < 12; i++) {
    const width = 9 + i,
      height = 8 + (i % 3),
      at = i * 12;
    table[at] = 5;
    table.writeUInt16LE(width, at + 2);
    table.writeUInt16LE(height, at + 4);
    table.writeUInt32LE(payload.length, at + 8);
    for (let j = 0; j < Math.ceil(width / 8) * height; j++)
      payload.push(j % 251);
  }
  return Buffer.concat([table, Buffer.from(payload)]);
}
export function fgsRecordFixture(
  bytes: Uint8Array,
  logicalBase = 4096,
): Buffer {
  const padded = Buffer.alloc(Math.ceil(bytes.length / 4) * 4);
  padded.set(bytes);
  const chunks: Buffer[] = [];
  for (let at = 0; at < padded.length; at += 44) {
    const length = Math.min(44, padded.length - at),
      header = Buffer.alloc(12);
    header.set([255, 255, 255, 0x24]);
    header.writeUInt32LE(length, 4);
    header.writeUInt32LE(logicalBase + at, 8);
    chunks.push(header, padded.subarray(at, at + length));
  }
  const footer = Buffer.alloc(16);
  footer.set([0xce, 0xde, 0xad, 0xce, 0x31, 0x21, 0x52, 0x31]);
  const body = Buffer.concat([...chunks, footer]);
  body.writeUInt32LE(body.length, body.length - 8);
  body.writeUInt32LE(crc32(body.subarray(0, body.length - 4)), body.length - 4);
  return body;
}
