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
  /** Typed value for attributes a literal cannot express, e.g. a `@bool/` resource reference. */
  readonly typedValue?: { readonly dataType: number; readonly data: number };
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

/**
 * ResStringPool length prefix. A value of 0x8000 or more carries its high bits
 * in the first word (marker bit set, low 15 bits of the value) and its low bits
 * in a second word; smaller values use one word. Both forms are public AXML.
 */
const lengthPrefix16 = (units: number): readonly number[] =>
  units >= 0x8000
    ? [...bytes16((units >> 16) | 0x8000), ...bytes16(units & 0xffff)]
    : bytes16(units);

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
    data.push(...lengthPrefix16(value.length), ...Array.from(encoded), 0, 0);
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

interface Row {
  readonly namespaceIndex: number;
  readonly nameIndex: number;
  readonly rawIndex: number;
  readonly dataType: number;
  readonly data: number;
  readonly resourceId: number | undefined;
}

/** A start element and its matching end element, ready to be nested in a document. */
const element = (
  nameIndex: number,
  rows: readonly Row[],
): { readonly start: number[]; readonly end: number[] } => ({
  start: chunk(0x0102, 16, [
    ...bytes32(0xffffffff), // lineNumber
    ...bytes32(0xffffffff), // comment
    ...bytes32(0xffffffff), // attrExt.ns
    ...bytes32(nameIndex),
    ...bytes16(20), // attrExt.attributeStart, relative to attrExt
    ...bytes16(20), // attrExt.attributeSize
    ...bytes16(rows.length),
    ...bytes16(0),
    ...bytes16(0),
    ...bytes16(0),
    ...flatten(
      rows.map((row) => [
        ...bytes32(row.namespaceIndex),
        ...bytes32(row.nameIndex),
        ...bytes32(row.rawIndex),
        ...bytes16(8),
        0,
        row.dataType,
        ...bytes32(row.data),
      ]),
    ),
  ]),
  end: chunk(0x0103, 16, [
    ...bytes32(0xffffffff),
    ...bytes32(0xffffffff),
    ...bytes32(0xffffffff),
    ...bytes32(nameIndex),
  ]),
});

/**
 * <manifest> with the given attributes, optionally wrapping an <application>
 * child with its own attributes. Elements nest in document order.
 */
export const binaryManifestFixture = (input: {
  readonly attributes: readonly BinaryManifestAttributeInput[];
  readonly application?: readonly BinaryManifestAttributeInput[];
  /**
   * Emit a second `<manifest>` start element after the first, before the
   * matching end element. Only malformed input carries a repeated root; the
   * reader must treat its declarations as ambiguous rather than let the later
   * chunk win.
   */
  readonly repeatedRootAttributes?: readonly BinaryManifestAttributeInput[];
}): Buffer => {
  const strings = [ANDROID_NS, "manifest"];
  const intern = (value: string): number => {
    const found = strings.indexOf(value);
    if (found >= 0) return found;
    strings.push(value);
    return strings.length - 1;
  };
  const rowsOf = (attributes: readonly BinaryManifestAttributeInput[]): Row[] =>
    attributes.map((attribute) => ({
      namespaceIndex:
        attribute.namespace === null ? 0xffffffff : intern(attribute.namespace),
      nameIndex: intern(attribute.name),
      rawIndex:
        attribute.stringValue === undefined
          ? 0xffffffff
          : intern(attribute.stringValue),
      dataType:
        attribute.typedValue !== undefined
          ? attribute.typedValue.dataType
          : attribute.booleanValue === undefined
            ? 0x03
            : 0x12,
      data:
        attribute.typedValue !== undefined
          ? attribute.typedValue.data
          : attribute.booleanValue !== undefined
            ? attribute.booleanValue
              ? 0xffffffff
              : 0
            : attribute.stringValue === undefined
              ? 0
              : intern(attribute.stringValue),
      resourceId: attribute.resourceId,
    }));
  const rootRows = rowsOf(input.attributes);
  const repeatedRows =
    input.repeatedRootAttributes === undefined
      ? undefined
      : rowsOf(input.repeatedRootAttributes);
  const applicationRows =
    input.application === undefined ? undefined : rowsOf(input.application);
  // The resource map is indexed by string-pool index, not by attribute order:
  // slot N holds the framework ID of the attribute name interned at N. Rows
  // without an ID leave their slot as 0 so later slots keep their alignment.
  const resourceMap: number[] = [];
  for (const row of [
    ...rootRows,
    ...(repeatedRows ?? []),
    ...(applicationRows ?? []),
  ]) {
    if (row.resourceId === undefined) continue;
    while (resourceMap.length < row.nameIndex) resourceMap.length++;
    resourceMap[row.nameIndex] = row.resourceId;
  }
  const resourceMapBytes = flatten(
    Array.from({ length: resourceMap.length }, (_, index) =>
      bytes32(resourceMap[index] ?? 0),
    ),
  );
  const applicationName = intern("application");
  const root = element(1, rootRows);
  const repeatedRoot =
    repeatedRows === undefined
      ? []
      : (() => {
          const child = element(1, repeatedRows);
          return [...child.start, ...child.end];
        })();
  const application =
    applicationRows === undefined
      ? []
      : (() => {
          const child = element(applicationName, applicationRows);
          return [...child.start, ...child.end];
        })();
  // Every name is interned now; only then is the pool's offset table meaningful.
  const pool = stringPool(strings);
  const body = [
    ...pool,
    ...(resourceMap.length === 0 ? [] : chunk(0x0180, 8, resourceMapBytes)),
    ...root.start,
    ...repeatedRoot,
    ...application,
    ...root.end,
  ];
  return Buffer.from([
    ...bytes16(0x0003),
    ...bytes16(8),
    ...bytes32(8 + body.length),
    ...body,
  ]);
};
