/**
 * Hand-authored binary AndroidManifest.xml. AXML is a published Android
 * resource format, so this fixture encodes it directly rather than asserting
 * the reader against its own output. Layout: ResChunk_header, ResStringPool_header,
 * ResXMLTree_node + ResXMLTree_attrExt, ResXMLTree_attribute + Res_value.
 */
export const ANDROID_NS = "http://schemas.android.com/apk/res/android";

export interface BinaryManifestAttributeInput {
  readonly namespace: string | null;
  readonly name: string;
  /** Optional framework ID, published at the string pool index of the attribute name. */
  readonly resourceId?: number;
  readonly stringValue?: string;
  readonly booleanValue?: boolean;
}

const bytes16 = (value: number): readonly number[] => [
  value & 0xff,
  (value >> 8) & 0xff,
];
const bytes32 = (value: number): readonly number[] => [
  value & 0xff,
  (value >> 8) & 0xff,
  (value >> 16) & 0xff,
  (value >>> 24) & 0xff,
];
const flatten = (parts: readonly (readonly number[])[]): number[] =>
  parts.reduce<number[]>((all, part) => all.concat(part), []);

const chunk = (
  type: number,
  headerSize: number,
  body: readonly number[],
): number[] => [
  ...bytes16(type),
  ...bytes16(headerSize),
  ...bytes32(8 + body.length),
  ...body,
];

const stringPool = (values: readonly string[]): number[] => {
  const data: number[] = [];
  const offsets: number[] = [];
  for (const value of values) {
    offsets.push(data.length);
    const encoded = Buffer.from(value, "utf16le");
    data.push(...bytes16(value.length), ...Array.from(encoded), 0, 0);
  }
  const headerSize = 28;
  return chunk(0x0001, headerSize, [
    ...bytes32(values.length),
    ...bytes32(0),
    ...bytes32(0), // UTF-16, neither SORTED nor UTF8
    ...bytes32(headerSize + offsets.length * 4),
    ...bytes32(0),
    ...flatten(offsets.map(bytes32)),
    ...data,
  ]);
};

/** <manifest> with the given attributes, followed by its matching end element. */
export const binaryManifestFixture = (input: {
  readonly attributes: readonly BinaryManifestAttributeInput[];
}): Buffer => {
  const strings = [ANDROID_NS, "manifest"];
  const intern = (value: string): number => {
    const found = strings.indexOf(value);
    if (found >= 0) return found;
    strings.push(value);
    return strings.length - 1;
  };
  const rows = input.attributes.map((attribute) => ({
    namespaceIndex:
      attribute.namespace === null ? 0xffffffff : intern(attribute.namespace),
    nameIndex: intern(attribute.name),
    rawIndex:
      attribute.stringValue === undefined
        ? 0xffffffff
        : intern(attribute.stringValue),
    dataType: attribute.booleanValue === undefined ? 0x03 : 0x12,
    data:
      attribute.booleanValue !== undefined
        ? attribute.booleanValue
          ? 0xffffffff
          : 0
        : attribute.stringValue === undefined
          ? 0
          : intern(attribute.stringValue),
    resourceId: attribute.resourceId,
  }));
  const resourceMap = flatten(
    rows
      .flatMap((row) =>
        row.resourceId === undefined ? [] : bytes32(row.resourceId),
      )
      .map((value) => [value]),
  );
  // Every name is interned now; only then is the pool's offset table meaningful.
  const pool = stringPool(strings);
  const attributeTable = flatten(
    rows.map((row) => [
      ...bytes32(row.namespaceIndex),
      ...bytes32(row.nameIndex),
      ...bytes32(row.rawIndex),
      ...bytes16(8),
      0,
      row.dataType,
      ...bytes32(row.data),
    ]),
  );
  const startElement = chunk(0x0102, 16, [
    ...bytes32(0xffffffff), // lineNumber
    ...bytes32(0xffffffff), // comment
    ...bytes32(0xffffffff), // attrExt.ns
    ...bytes32(1), // attrExt.name = "manifest"
    ...bytes16(20), // attrExt.attributeStart, relative to attrExt
    ...bytes16(20), // attrExt.attributeSize
    ...bytes16(rows.length),
    ...bytes16(0),
    ...bytes16(0),
    ...bytes16(0),
    ...attributeTable,
  ]);
  const endElement = chunk(0x0103, 16, [
    ...bytes32(0xffffffff),
    ...bytes32(0xffffffff),
    ...bytes32(0xffffffff),
    ...bytes32(1),
  ]);
  const body = [
    ...pool,
    ...(resourceMap.length === 0 ? [] : chunk(0x0180, 8, resourceMap)),
    ...startElement,
    ...endElement,
  ];
  return Buffer.from([
    ...bytes16(0x0003),
    ...bytes16(8),
    ...bytes32(8 + body.length),
    ...body,
  ]);
};
