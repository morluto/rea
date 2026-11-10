/**
 * Minimal synthetic binary AndroidManifest.xml (AXML) bytes for tests: a
 * string pool plus the root `<manifest>` start-element chunk, with optional
 * required-split attributes. This is a test fixture, not a manifest author;
 * it encodes exactly the attributes the split reader consumes.
 */

export const axmlManifestBytes = (options: {
  readonly utf16?: boolean;
  readonly requiredSplitTypes?: string;
  readonly splitRequired?: boolean;
  readonly rootName?: string;
} = {}): Buffer => {
  const strings: string[] = [];
  const intern = (value: string): number => {
    const existing = strings.indexOf(value);
    if (existing >= 0) return existing;
    strings.push(value);
    return strings.length - 1;
  };
  const rootIndex = intern(options.rootName ?? "manifest");
  const attributes: {
    name: number;
    raw: number;
    dataType: number;
    data: number;
  }[] = [];
  if (options.requiredSplitTypes !== undefined) {
    const value = intern(options.requiredSplitTypes);
    attributes.push({
      name: intern("requiredSplitTypes"),
      raw: value,
      dataType: 0x03,
      data: value,
    });
  }
  if (options.splitRequired !== undefined)
    attributes.push({
      name: intern("isSplitRequired"),
      raw: -1,
      dataType: 0x12,
      data: options.splitRequired ? 1 : 0,
    });

  const varint = (value: number): Buffer =>
    value < 0x80
      ? Buffer.from([value])
      : Buffer.from([(value >> 8) | 0x80, value & 0xff]);
  const encodedStrings = strings.map((value) => {
    if (options.utf16 === true) {
      const units = Buffer.from(value, "utf16le");
      const length = Buffer.alloc(2);
      length.writeUInt16LE(value.length, 0);
      return Buffer.concat([length, units, Buffer.from([0, 0])]);
    }
    const utf8 = Buffer.from(value, "utf8");
    return Buffer.concat([
      varint(value.length),
      varint(utf8.length),
      utf8,
      Buffer.from([0]),
    ]);
  });
  const offsets: number[] = [];
  let cursor = 0;
  for (const encoded of encodedStrings) {
    offsets.push(cursor);
    cursor += encoded.length;
  }
  const poolHeaderSize = 28;
  const stringsStart = poolHeaderSize + 4 * strings.length;
  const poolSize = stringsStart + cursor;
  const pool = Buffer.alloc(poolSize);
  pool.writeUInt16LE(0x0001, 0);
  pool.writeUInt16LE(poolHeaderSize, 2);
  pool.writeUInt32LE(poolSize, 4);
  pool.writeUInt32LE(strings.length, 8);
  pool.writeUInt32LE(0, 12);
  pool.writeUInt32LE(options.utf16 === true ? 0 : 0x100, 16);
  pool.writeUInt32LE(stringsStart, 20);
  pool.writeUInt32LE(0, 24);
  offsets.forEach((offset, index) =>
    pool.writeUInt32LE(offset, poolHeaderSize + index * 4),
  );
  let at = stringsStart;
  for (const encoded of encodedStrings) {
    encoded.copy(pool, at);
    at += encoded.length;
  }

  const elementHeaderSize = 36;
  const elementSize = elementHeaderSize + 20 * attributes.length;
  const element = Buffer.alloc(elementSize);
  element.writeUInt16LE(0x0102, 0);
  element.writeUInt16LE(elementHeaderSize, 2);
  element.writeUInt32LE(elementSize, 4);
  element.writeUInt32LE(1, 8);
  element.writeInt32LE(-1, 12);
  element.writeInt32LE(-1, 16);
  element.writeInt32LE(rootIndex, 20);
  element.writeUInt16LE(elementHeaderSize, 24);
  element.writeUInt16LE(20, 26);
  element.writeUInt16LE(attributes.length, 28);
  element.writeUInt16LE(0xffff, 30);
  element.writeUInt16LE(0xffff, 32);
  element.writeUInt16LE(0xffff, 34);
  attributes.forEach((attribute, index) => {
    const start = elementHeaderSize + index * 20;
    element.writeInt32LE(-1, start);
    element.writeInt32LE(attribute.name, start + 4);
    element.writeInt32LE(attribute.raw, start + 8);
    element.writeUInt16LE(8, start + 12);
    element.writeUInt8(0, start + 14);
    element.writeUInt8(attribute.dataType, start + 15);
    element.writeUInt32LE(attribute.data, start + 16);
  });

  const total = 8 + poolSize + elementSize;
  const bytes = Buffer.alloc(total);
  bytes.writeUInt16LE(0x0003, 0);
  bytes.writeUInt16LE(8, 2);
  bytes.writeUInt32LE(total, 4);
  pool.copy(bytes, 8);
  element.copy(bytes, 8 + poolSize);
  return bytes;
};
