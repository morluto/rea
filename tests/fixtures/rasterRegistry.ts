/** Independent numerical registry fixture, never copied from a firmware image. */
export function registryFixture(shift = 0, bias = 0x240000, count = 10) {
  const bytes = new Uint8Array(shift + 12288).fill(255);
  const v = new DataView(bytes.buffer),
    start = shift + 256;
  const table = shift + 1536,
    lookup = shift + 4096;
  const palettes = [6144, 7424, 8704, 9984].map((x) => x + shift);
  let payload = 0;
  for (let i = 0; i < count; i++) {
    const at = table + i * 12,
      width = 17 + i;
    bytes[at] = 1;
    bytes[at + 1] = i % 2;
    v.setUint16(at + 2, width, true);
    v.setUint16(at + 4, 3, true);
    v.setUint16(at + 6, 0, true);
    v.setUint32(at + 8, payload, true);
    payload += Math.ceil(width / 8) * 3;
  }
  for (let i = 0; i < 4; i++)
    v.setUint16(lookup + i * 2, i === 1 ? 0x8000 : i, true);
  for (let i = 0; i < 3; i++) {
    const at = start + i * 28,
      countAt = shift + 512 + i * 4;
    [
      table + bias,
      lookup + bias,
      0,
      0,
      table + count * 12 + bias,
      i === 1 ? shift + 560 + bias : 0,
      countAt + bias,
    ].forEach((word, j) => v.setUint32(at + j * 4, word, true));
    v.setUint16(countAt, count, true);
  }
  for (let i = 0; i < 8; i++) {
    v.setUint32(start - 72 + i * 8, palettes[i % 4]! + bias, true);
    v.setUint32(start - 68 + i * 8, 1, true);
  }
  v.setUint32(start - 8, 0, true);
  v.setUint32(start - 4, 1, true);
  return { bytes, start, table, lookup, palettes, bias, count };
}
