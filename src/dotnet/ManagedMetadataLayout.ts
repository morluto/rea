import { managedFailure } from "./ManagedReaderFailure.js";

export const METADATA_TABLE_NAMES = [
  "Module",
  "TypeRef",
  "TypeDef",
  "FieldPtr",
  "Field",
  "MethodPtr",
  "MethodDef",
  "ParamPtr",
  "Param",
  "InterfaceImpl",
  "MemberRef",
  "Constant",
  "CustomAttribute",
  "FieldMarshal",
  "DeclSecurity",
  "ClassLayout",
  "FieldLayout",
  "StandAloneSig",
  "EventMap",
  "EventPtr",
  "Event",
  "PropertyMap",
  "PropertyPtr",
  "Property",
  "MethodSemantics",
  "MethodImpl",
  "ModuleRef",
  "TypeSpec",
  "ImplMap",
  "FieldRVA",
  "ENCLog",
  "ENCMap",
  "Assembly",
  "AssemblyProcessor",
  "AssemblyOS",
  "AssemblyRef",
  "AssemblyRefProcessor",
  "AssemblyRefOS",
  "File",
  "ExportedType",
  "ManifestResource",
  "NestedClass",
  "GenericParam",
  "MethodSpec",
  "GenericParamConstraint",
] as const;

interface MetadataStream {
  readonly name: string;
  readonly offset: number;
  readonly size: number;
}

export interface MetadataTableLayout {
  readonly index: number;
  readonly name: string;
  readonly rowCount: number;
  readonly rowSize: number;
  readonly offset: number;
}

export interface ManagedMetadataLayout {
  readonly rootOffset: number;
  readonly size: number;
  readonly version: string;
  readonly streamNames: readonly string[];
  readonly strings: MetadataStream;
  readonly guid: MetadataStream;
  readonly blob: MetadataStream;
  readonly tables: ReadonlyMap<number, MetadataTableLayout>;
  readonly rowCounts: readonly number[];
  readonly stringIndexSize: 2 | 4;
  readonly guidIndexSize: 2 | 4;
  readonly blobIndexSize: 2 | 4;
  table(index: number): MetadataTableLayout | undefined;
  tableIndexSize(index: number): 2 | 4;
  codedIndexSize(name: CodedIndexName): 2 | 4;
}

type CodedIndexName = keyof typeof CODED_INDEXES;

const CODED_INDEXES = {
  TypeDefOrRef: { bits: 2, tables: [2, 1, 27] },
  HasConstant: { bits: 2, tables: [4, 8, 23] },
  HasCustomAttribute: {
    bits: 5,
    tables: [
      6, 4, 1, 2, 8, 9, 10, 0, 14, 23, 20, 17, 26, 27, 32, 35, 38, 39, 40, 42,
      44, 43,
    ],
  },
  HasFieldMarshal: { bits: 1, tables: [4, 8] },
  HasDeclSecurity: { bits: 2, tables: [2, 6, 32] },
  MemberRefParent: { bits: 3, tables: [2, 1, 26, 6, 27] },
  HasSemantics: { bits: 1, tables: [20, 23] },
  MethodDefOrRef: { bits: 1, tables: [6, 10] },
  MemberForwarded: { bits: 1, tables: [4, 6] },
  Implementation: { bits: 2, tables: [38, 35, 39] },
  CustomAttributeType: { bits: 3, tables: [6, 10] },
  ResolutionScope: { bits: 2, tables: [0, 26, 35, 1] },
  TypeOrMethodDef: { bits: 1, tables: [2, 6] },
} as const;

const SUPPORTED_TABLE_MASK = (1n << BigInt(METADATA_TABLE_NAMES.length)) - 1n;

const requireRange = (
  bytes: Buffer,
  offset: number,
  length: number,
  scope: string,
): void => {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset > bytes.length - length
  )
    throw managedFailure(
      "invalid-metadata-root",
      scope,
      `${scope} leaves the metadata byte range`,
      Number.isSafeInteger(offset) && offset >= 0 ? offset : null,
    );
};

const align4 = (value: number): number => (value + 3) & ~3;

const readStreamName = (
  bytes: Buffer,
  offset: number,
): { readonly name: string; readonly next: number } => {
  const endLimit = Math.min(bytes.length, offset + 32);
  let end = offset;
  while (end < endLimit && bytes[end] !== 0) end += 1;
  if (end === endLimit)
    throw managedFailure(
      "invalid-stream",
      "metadata.stream-name",
      "Metadata stream name is missing a bounded terminator",
      offset,
    );
  const nameBytes = bytes.subarray(offset, end);
  if (nameBytes.some((byte) => byte < 0x20 || byte > 0x7e))
    throw managedFailure(
      "invalid-stream",
      "metadata.stream-name",
      "Metadata stream name is not printable ASCII",
      offset,
    );
  return {
    name: nameBytes.toString("ascii"),
    next: align4(end + 1),
  };
};

const streamByName = (
  streams: ReadonlyMap<string, MetadataStream>,
  names: readonly string[],
): MetadataStream | undefined => {
  for (const name of names) {
    const stream = streams.get(name);
    if (stream !== undefined) return stream;
  }
  return undefined;
};

const requireStream = (
  streams: ReadonlyMap<string, MetadataStream>,
  name: string,
): MetadataStream => {
  const stream = streams.get(name);
  if (stream === undefined)
    throw managedFailure(
      "missing-stream",
      `metadata.${name}`,
      `Required metadata stream ${name} is absent`,
    );
  return stream;
};

const codedSize = (
  name: CodedIndexName,
  rowCounts: readonly number[],
): 2 | 4 => {
  const descriptor = CODED_INDEXES[name];
  let maximum = 0;
  for (const table of descriptor.tables)
    maximum = Math.max(maximum, rowCounts[table] ?? 0);
  return maximum < 2 ** (16 - descriptor.bits) ? 2 : 4;
};

const tableSize = (index: number, rows: readonly number[]): 2 | 4 =>
  (rows[index] ?? 0) < 0x1_0000 ? 2 : 4;

const rowSize = (
  table: number,
  rowCounts: readonly number[],
  heaps: { readonly string: 2 | 4; readonly guid: 2 | 4; readonly blob: 2 | 4 },
): number => {
  const t = (index: number): number => tableSize(index, rowCounts);
  const c = (name: CodedIndexName): number => codedSize(name, rowCounts);
  const { string: s, guid: g, blob: b } = heaps;
  switch (table) {
    case 0:
      return 2 + s + g * 3;
    case 1:
      return c("ResolutionScope") + s * 2;
    case 2:
      return 4 + s * 2 + c("TypeDefOrRef") + t(4) + t(6);
    case 3:
      return t(4);
    case 4:
      return 2 + s + b;
    case 5:
      return t(6);
    case 6:
      return 8 + s + b + t(8);
    case 7:
      return t(8);
    case 8:
      return 4 + s;
    case 9:
      return t(2) + c("TypeDefOrRef");
    case 10:
      return c("MemberRefParent") + s + b;
    case 11:
      return 2 + c("HasConstant") + b;
    case 12:
      return c("HasCustomAttribute") + c("CustomAttributeType") + b;
    case 13:
      return c("HasFieldMarshal") + b;
    case 14:
      return 2 + c("HasDeclSecurity") + b;
    case 15:
      return 6 + t(2);
    case 16:
      return 4 + t(4);
    case 17:
      return b;
    case 18:
      return t(2) + t(20);
    case 19:
      return t(20);
    case 20:
      return 2 + s + c("TypeDefOrRef");
    case 21:
      return t(2) + t(23);
    case 22:
      return t(23);
    case 23:
      return 2 + s + b;
    case 24:
      return 2 + t(6) + c("HasSemantics");
    case 25:
      return t(2) + c("MethodDefOrRef") * 2;
    case 26:
      return s;
    case 27:
      return b;
    case 28:
      return 2 + c("MemberForwarded") + s + t(26);
    case 29:
      return 4 + t(4);
    case 30:
      return 8;
    case 31:
      return 4;
    case 32:
      return 16 + b + s * 2;
    case 33:
      return 4;
    case 34:
      return 12;
    case 35:
      return 12 + b * 2 + s * 2;
    case 36:
      return 4 + t(35);
    case 37:
      return 12 + t(35);
    case 38:
      return 4 + s + b;
    case 39:
      return 8 + s * 2 + c("Implementation");
    case 40:
      return 8 + s + c("Implementation");
    case 41:
      return t(2) * 2;
    case 42:
      return 4 + c("TypeOrMethodDef") + s;
    case 43:
      return c("MethodDefOrRef") + b;
    case 44:
      return t(42) + c("TypeDefOrRef");
    default:
      throw managedFailure(
        "invalid-tables",
        "metadata.tables",
        `Metadata table ${String(table)} is unsupported`,
      );
  }
};

/** Parse ECMA-335 stream and table layout with checked byte extents. */
export const readManagedMetadataLayout = (
  artifact: Buffer,
  rootOffset: number,
  size: number,
  maxTableRows: number,
): ManagedMetadataLayout => {
  if (size < 20 || rootOffset < 0 || rootOffset > artifact.length - size)
    throw managedFailure(
      "invalid-metadata-root",
      "metadata.root",
      "CLI metadata directory leaves the artifact byte range",
      rootOffset,
    );
  const bytes = artifact.subarray(rootOffset, rootOffset + size);
  if (bytes.readUInt32LE(0) !== 0x424a_5342)
    throw managedFailure(
      "invalid-metadata-root",
      "metadata.signature",
      "CLI metadata signature is not BSJB",
      rootOffset,
    );
  const versionLength = bytes.readUInt32LE(12);
  requireRange(bytes, 16, versionLength, "metadata.version");
  const versionBytes = bytes.subarray(16, 16 + versionLength);
  const zero = versionBytes.indexOf(0);
  const version = versionBytes
    .subarray(0, zero < 0 ? versionBytes.length : zero)
    .toString("utf8");
  let cursor = align4(16 + versionLength);
  requireRange(bytes, cursor, 4, "metadata.stream-count");
  const streamCount = bytes.readUInt16LE(cursor + 2);
  if (streamCount === 0 || streamCount > 64)
    throw managedFailure(
      "invalid-stream",
      "metadata.stream-count",
      "Metadata stream count is outside the admitted range",
      rootOffset + cursor + 2,
    );
  cursor += 4;
  const streams = new Map<string, MetadataStream>();
  for (let index = 0; index < streamCount; index += 1) {
    requireRange(bytes, cursor, 8, "metadata.stream-header");
    const relativeOffset = bytes.readUInt32LE(cursor);
    const streamSize = bytes.readUInt32LE(cursor + 4);
    const named = readStreamName(bytes, cursor + 8);
    if (streams.has(named.name))
      throw managedFailure(
        "invalid-stream",
        "metadata.stream-header",
        `Duplicate metadata stream ${named.name}`,
        rootOffset + cursor,
      );
    requireRange(bytes, relativeOffset, streamSize, `metadata.${named.name}`);
    streams.set(named.name, {
      name: named.name,
      offset: rootOffset + relativeOffset,
      size: streamSize,
    });
    cursor = named.next;
  }
  const tablesStream = streamByName(streams, ["#~", "#-"]);
  if (tablesStream === undefined)
    throw managedFailure(
      "missing-stream",
      "metadata.tables",
      "Required metadata table stream #~ or #- is absent",
    );
  const tableBytes = artifact.subarray(
    tablesStream.offset,
    tablesStream.offset + tablesStream.size,
  );
  requireRange(tableBytes, 0, 24, "metadata.tables-header");
  const heapSizes = tableBytes[6] ?? 0;
  const heaps = {
    string: (heapSizes & 0x01) === 0 ? (2 as const) : (4 as const),
    guid: (heapSizes & 0x02) === 0 ? (2 as const) : (4 as const),
    blob: (heapSizes & 0x04) === 0 ? (2 as const) : (4 as const),
  };
  const valid = tableBytes.readBigUInt64LE(8);
  if ((valid & ~SUPPORTED_TABLE_MASK) !== 0n)
    throw managedFailure(
      "invalid-tables",
      "metadata.valid-mask",
      "Metadata valid mask names unsupported tables outside the admitted ECMA-335 range",
      tablesStream.offset + 8,
    );
  const rowCounts = Array<number>(METADATA_TABLE_NAMES.length).fill(0);
  let tableCursor = 24;
  for (let index = 0; index < METADATA_TABLE_NAMES.length; index += 1) {
    if ((valid & (1n << BigInt(index))) === 0n) continue;
    requireRange(tableBytes, tableCursor, 4, "metadata.table-row-count");
    const count = tableBytes.readUInt32LE(tableCursor);
    if (count > maxTableRows)
      throw managedFailure(
        "limit-exceeded",
        `metadata.${METADATA_TABLE_NAMES[index] ?? String(index)}`,
        `Metadata table row count ${String(count)} exceeds max_table_rows ${String(maxTableRows)}`,
        tablesStream.offset + tableCursor,
      );
    rowCounts[index] = count;
    tableCursor += 4;
  }
  const tables = new Map<number, MetadataTableLayout>();
  for (let index = 0; index < METADATA_TABLE_NAMES.length; index += 1) {
    const count = rowCounts[index] ?? 0;
    if ((valid & (1n << BigInt(index))) === 0n) continue;
    const sizeOfRow = rowSize(index, rowCounts, heaps);
    const byteLength = count * sizeOfRow;
    if (!Number.isSafeInteger(byteLength))
      throw managedFailure(
        "invalid-tables",
        "metadata.tables",
        "Metadata table byte size overflowed",
        tablesStream.offset + tableCursor,
      );
    requireRange(tableBytes, tableCursor, byteLength, "metadata.table-data");
    tables.set(index, {
      index,
      name: METADATA_TABLE_NAMES[index] ?? `Table${String(index)}`,
      rowCount: count,
      rowSize: sizeOfRow,
      offset: tablesStream.offset + tableCursor,
    });
    tableCursor += byteLength;
  }
  const layout: ManagedMetadataLayout = {
    rootOffset,
    size,
    version,
    streamNames: [...streams.keys()].sort(),
    strings: requireStream(streams, "#Strings"),
    guid: requireStream(streams, "#GUID"),
    blob: requireStream(streams, "#Blob"),
    tables,
    rowCounts,
    stringIndexSize: heaps.string,
    guidIndexSize: heaps.guid,
    blobIndexSize: heaps.blob,
    table: (index) => tables.get(index),
    tableIndexSize: (index) => tableSize(index, rowCounts),
    codedIndexSize: (name) => codedSize(name, rowCounts),
  };
  return layout;
};

/** Resolve a one-based metadata row to its exact file offset. */
export const metadataRowOffset = (
  layout: ManagedMetadataLayout,
  table: number,
  row: number,
): number => {
  const descriptor = layout.table(table);
  if (descriptor === undefined || row < 1 || row > descriptor.rowCount)
    throw managedFailure(
      "invalid-row",
      `metadata.${METADATA_TABLE_NAMES[table] ?? String(table)}`,
      `Metadata row ${String(row)} is outside its table`,
    );
  return descriptor.offset + (row - 1) * descriptor.rowSize;
};
