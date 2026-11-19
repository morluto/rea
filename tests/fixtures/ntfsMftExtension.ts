/** Source-built FILE records; no production decoder is used to construct them. */
export const residentMftAttribute = (
  type: number,
  id: number,
  value: Buffer,
  name = "",
): Buffer => {
  const encodedName = Buffer.from(name, "utf16le");
  const valueOffset = Math.ceil((24 + encodedName.length) / 8) * 8;
  const attribute = Buffer.alloc(
    Math.ceil((valueOffset + value.length) / 8) * 8,
  );
  attribute.writeUInt32LE(type);
  attribute.writeUInt32LE(attribute.length, 4);
  attribute.writeUInt8(name.length, 9);
  attribute.writeUInt16LE(24, 10);
  attribute.writeUInt16LE(id, 14);
  attribute.writeUInt32LE(value.length, 16);
  attribute.writeUInt16LE(valueOffset, 20);
  encodedName.copy(attribute, 24);
  value.copy(attribute, valueOffset);
  return attribute;
};

export const mftListEntry = (
  type: number,
  id: number,
  index: number,
  sequence: number,
  name = "",
  lowestVcn = 0n,
): Buffer => {
  const encodedName = Buffer.from(name, "utf16le");
  const entry = Buffer.alloc(Math.ceil((26 + encodedName.length) / 8) * 8);
  entry.writeUInt32LE(type);
  entry.writeUInt16LE(entry.length, 4);
  entry.writeUInt8(name.length, 6);
  entry.writeUInt8(26, 7);
  entry.writeBigUInt64LE(lowestVcn, 8);
  entry.writeBigUInt64LE((BigInt(sequence) << 48n) | BigInt(index), 16);
  entry.writeUInt16LE(id, 24);
  encodedName.copy(entry, 26);
  return entry;
};

export const mftFileNameAttribute = (id: number, name: string): Buffer => {
  const encodedName = Buffer.from(name, "utf16le");
  const value = Buffer.alloc(66 + encodedName.length);
  value.writeBigUInt64LE((4n << 48n) | 9n);
  value.writeBigUInt64LE(133000000000000001n, 8);
  value.writeBigUInt64LE(9007199254740993n, 48);
  value.writeUInt32LE(0x20, 56);
  value.writeUInt8(name.length, 64);
  value.writeUInt8(1, 65);
  encodedName.copy(value, 66);
  return residentMftAttribute(0x30, id, value);
};

export const mftFileRecord = (
  index: number,
  sequence: number,
  attributes: readonly Buffer[],
  { baseReference = 0n, recordBytes = 1024 } = {},
): Buffer => {
  const record = Buffer.alloc(recordBytes);
  const sectors = recordBytes / 512;
  const first = Math.ceil((48 + (sectors + 1) * 2) / 8) * 8;
  record.write("FILE");
  record.writeUInt16LE(48, 4);
  record.writeUInt16LE(sectors + 1, 6);
  record.writeUInt16LE(sequence, 16);
  record.writeUInt16LE(1, 18);
  record.writeUInt16LE(first, 20);
  record.writeUInt16LE(1, 22);
  record.writeUInt32LE(recordBytes, 28);
  record.writeBigUInt64LE(baseReference, 32);
  record.writeUInt16LE(
    attributes.reduce(
      (next, attribute) => Math.max(next, attribute.readUInt16LE(14) + 1),
      0,
    ),
    40,
  );
  record.writeUInt32LE(index, 44);
  let cursor = first;
  for (const attribute of attributes) {
    if (cursor + attribute.length + 8 > recordBytes)
      throw new Error("Fixture exceeds FILE record");
    attribute.copy(record, cursor);
    cursor += attribute.length;
  }
  record.writeUInt32LE(0xffffffff, cursor);
  record.writeUInt32LE(cursor + 8, 24);
  record.writeUInt16LE(0xa55a, 48);
  for (let sector = 0; sector < sectors; sector += 1) {
    const trailer = (sector + 1) * 512 - 2;
    record.writeUInt16LE(record.readUInt16LE(trailer), 50 + sector * 2);
    record.writeUInt16LE(0xa55a, trailer);
  }
  return record;
};

export const linkedMftFixture = (): Buffer =>
  Buffer.concat([
    mftFileRecord(0, 2, [
      mftFileNameAttribute(1, "local"),
      residentMftAttribute(0x20, 2, mftListEntry(0x30, 3, 1, 7)),
    ]),
    mftFileRecord(1, 7, [mftFileNameAttribute(3, "linked")], {
      baseReference: 2n << 48n,
    }),
  ]);
