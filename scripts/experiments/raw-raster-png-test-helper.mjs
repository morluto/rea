// Test-only, independent complete-file validator for the encoder's RGBA8 profile.
// Uses Node's CRC implementation, not the production encoder's checksum code.
import assert from "node:assert/strict";
import { crc32, inflateSync } from "node:zlib";

export function decodePreviewPng(png) {
  assert.deepEqual(
    png.subarray(0, 8),
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );
  let offset = 8;
  const chunks = [];
  while (offset < png.length) {
    assert.ok(png.length - offset >= 12, "truncated PNG chunk");
    const length = png.readUInt32BE(offset);
    assert.ok(length <= png.length - offset - 12, "truncated PNG data");
    const type = png.toString("ascii", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    assert.equal(
      png.readUInt32BE(offset + 8 + length),
      crc32(png.subarray(offset + 4, offset + 8 + length)),
      `${type} checksum`,
    );
    chunks.push({ type, data });
    offset += length + 12;
  }
  assert.deepEqual(
    chunks.map(({ type }) => type),
    ["IHDR", "IDAT", "IEND"],
  );
  const header = chunks[0].data;
  assert.equal(header.length, 13);
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  assert.ok(width > 0 && height > 0);
  assert.deepEqual([...header.subarray(8)], [8, 6, 0, 0, 0]);
  assert.equal(chunks[2].data.length, 0);
  const raw = inflateSync(chunks[1].data);
  assert.equal(raw.length, height * (1 + width * 4));
  const rgba = [];
  for (let y = 0; y < height; y++) {
    const start = y * (1 + width * 4);
    assert.equal(raw[start], 0, "expected unfiltered scanline");
    rgba.push(...raw.subarray(start + 1, start + 1 + width * 4));
  }
  return { width, height, rgba };
}
