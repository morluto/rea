/** Hand-authored NE bytes, independent of the production decoder. */

const SHIFT = 4;
const NE_OFFSET = 0x80;

const pascal = (text: string): Buffer =>
  Buffer.concat([Buffer.from([text.length]), Buffer.from(text, "latin1")]);

const names = (rows: readonly (readonly [string, number])[]): Buffer =>
  Buffer.concat([
    ...rows.map(([text, ordinal]) => {
      const ordinalBytes = Buffer.alloc(2);
      ordinalBytes.writeUInt16LE(ordinal);
      return Buffer.concat([pascal(text), ordinalBytes]);
    }),
    Buffer.from([0]),
  ]);

export interface NeFixture {
  readonly bytes: Buffer;
  readonly ne: number;
  readonly segmentTable: number;
  readonly resourceTable: number;
  readonly residentNames: number;
  readonly moduleReferences: number;
  readonly importedNames: number;
  readonly entryTable: number;
  readonly nonresidentNames: number;
  readonly codeSegment: number;
  readonly dataSegment: number;
  readonly iconResource: number;
  readonly customResource: number;
}

/**
 * A two-segment library: code (with two relocation records) and data, an
 * integer-typed icon and a name-typed resource, resident and non-resident
 * exports, two module references and fixed, unused and movable entry bundles.
 */
export const neFixture = (): NeFixture => {
  const segmentTableBytes = 2 * 8;
  const resourceTable = Buffer.alloc(2 + 8 + 12 + 8 + 12 + 2);
  // Resource names follow the type list: "CUSTOM" names a type, "HELLO" a resource.
  const resourceNames = Buffer.concat([
    pascal("CUSTOM"),
    pascal("HELLO"),
    Buffer.from([0]),
  ]);
  const resident = names([
    ["SAMPLE", 0],
    ["ENTRYONE", 1],
  ]);
  const imported = Buffer.concat([
    Buffer.from([0]),
    pascal("KERNEL"),
    pascal("USER"),
  ]);
  const moduleReferences = Buffer.alloc(4);
  moduleReferences.writeUInt16LE(1, 0);
  moduleReferences.writeUInt16LE(1 + 7, 2);
  // Fixed bundle (segment 1): ordinals 1-2; unused bundle: ordinal 3;
  // movable bundle: ordinal 4 in segment 2; terminator.
  const entryTable = Buffer.from([
    2, 1, 0x01, 0x10, 0x00, 0x00, 0x20, 0x00, 1, 0, 1, 0xff, 0x03, 0xcd, 0x3f,
    2, 0x34, 0x12, 0,
  ]);
  const nonresident = names([
    ["Sample library", 0],
    ["HIDDENFN", 2],
  ]);

  const segmentTable = 0x40;
  const resourceAt = segmentTable + segmentTableBytes;
  const resourceNamesAt = resourceAt + resourceTable.length;
  const residentAt = resourceNamesAt + resourceNames.length;
  const moduleReferencesAt = residentAt + resident.length;
  const importedAt = moduleReferencesAt + moduleReferences.length;
  const entryAt = importedAt + imported.length;
  const nonresidentAt = NE_OFFSET + entryAt + entryTable.length;
  const align = (value: number): number =>
    Math.ceil(value / (1 << SHIFT)) * (1 << SHIFT);
  const codeAt = align(nonresidentAt + nonresident.length);
  const code = Buffer.from("CODECODECODE");
  const relocationsAt = codeAt + code.length;
  const relocations = Buffer.alloc(2 + 2 * 8);
  relocations.writeUInt16LE(2, 0);
  const dataAt = align(relocationsAt + relocations.length);
  const data = Buffer.from("DATA");
  const iconAt = align(dataAt + data.length);
  const icon = Buffer.alloc(32, 0x11);
  const customAt = align(iconAt + icon.length);
  const custom = Buffer.alloc(16, 0x22);
  const total = customAt + custom.length;

  const bytes = Buffer.alloc(total);
  bytes.write("MZ", 0, "latin1");
  bytes.writeUInt16LE(4, 8);
  bytes.writeUInt32LE(NE_OFFSET, 0x3c);

  const ne = NE_OFFSET;
  bytes.write("NE", ne, "latin1");
  bytes[ne + 2] = 5;
  bytes[ne + 3] = 10;
  bytes.writeUInt16LE(entryAt, ne + 0x04);
  bytes.writeUInt16LE(entryTable.length, ne + 0x06);
  bytes.writeUInt32LE(0x12345678, ne + 0x08);
  bytes.writeUInt16LE(0x8000 | 0x0002, ne + 0x0c);
  bytes.writeUInt16LE(2, ne + 0x0e);
  bytes.writeUInt16LE(0x400, ne + 0x10);
  bytes.writeUInt16LE(0, ne + 0x12);
  bytes.writeUInt16LE(0x10, ne + 0x14);
  bytes.writeUInt16LE(1, ne + 0x16);
  bytes.writeUInt16LE(2, ne + 0x1c);
  bytes.writeUInt16LE(2, ne + 0x1e);
  bytes.writeUInt16LE(nonresident.length, ne + 0x20);
  bytes.writeUInt16LE(segmentTable, ne + 0x22);
  bytes.writeUInt16LE(resourceAt, ne + 0x24);
  bytes.writeUInt16LE(residentAt, ne + 0x26);
  bytes.writeUInt16LE(moduleReferencesAt, ne + 0x28);
  bytes.writeUInt16LE(importedAt, ne + 0x2a);
  bytes.writeUInt32LE(nonresidentAt, ne + 0x2c);
  bytes.writeUInt16LE(1, ne + 0x30);
  bytes.writeUInt16LE(SHIFT, ne + 0x32);
  bytes[ne + 0x36] = 2;
  bytes[ne + 0x3e] = 0;
  bytes[ne + 0x3f] = 3;

  const segmentRow = (
    index: number,
    at: number,
    length: number,
    flags: number,
    minimum: number,
  ) => {
    const row = ne + segmentTable + index * 8;
    bytes.writeUInt16LE(at >> SHIFT, row);
    bytes.writeUInt16LE(length, row + 2);
    bytes.writeUInt16LE(flags, row + 4);
    bytes.writeUInt16LE(minimum, row + 6);
  };
  segmentRow(0, codeAt, code.length, 0x0100 | 0x0010, 0x20);
  segmentRow(1, dataAt, data.length, 0x0001, 0);

  resourceTable.writeUInt16LE(SHIFT, 0);
  resourceTable.writeUInt16LE(0x8003, 2);
  resourceTable.writeUInt16LE(1, 4);
  resourceTable.writeUInt16LE(iconAt >> SHIFT, 10);
  resourceTable.writeUInt16LE(icon.length >> SHIFT, 12);
  resourceTable.writeUInt16LE(0x0030, 14);
  resourceTable.writeUInt16LE(0x8001, 16);
  const customType = 2 + 8 + 12;
  resourceTable.writeUInt16LE(resourceNamesAt - resourceAt, customType);
  resourceTable.writeUInt16LE(1, customType + 2);
  resourceTable.writeUInt16LE(customAt >> SHIFT, customType + 8);
  resourceTable.writeUInt16LE(custom.length >> SHIFT, customType + 10);
  resourceTable.writeUInt16LE(0x0010, customType + 12);
  resourceTable.writeUInt16LE(
    resourceNamesAt - resourceAt + 7,
    customType + 14,
  );

  for (const [at, part] of [
    [ne + resourceAt, resourceTable],
    [ne + resourceNamesAt, resourceNames],
    [ne + residentAt, resident],
    [ne + moduleReferencesAt, moduleReferences],
    [ne + importedAt, imported],
    [ne + entryAt, entryTable],
    [nonresidentAt, nonresident],
    [codeAt, code],
    [relocationsAt, relocations],
    [dataAt, data],
    [iconAt, icon],
    [customAt, custom],
  ] as const)
    part.copy(bytes, at);

  return {
    bytes,
    ne,
    segmentTable: ne + segmentTable,
    resourceTable: ne + resourceAt,
    residentNames: ne + residentAt,
    moduleReferences: ne + moduleReferencesAt,
    importedNames: ne + importedAt,
    entryTable: ne + entryAt,
    nonresidentNames: nonresidentAt,
    codeSegment: codeAt,
    dataSegment: dataAt,
    iconResource: iconAt,
    customResource: customAt,
  };
};
