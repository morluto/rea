import type {
  ManagedArtifactInspection,
  ManagedParseIssue,
} from "../domain/managedArtifact.js";
import {
  METADATA_TABLE_NAMES,
  metadataRowOffset,
  type ManagedMetadataLayout,
  type MetadataTableLayout,
} from "./ManagedMetadataLayout.js";
import {
  MetadataRowCursor,
  metadataToken,
  readMetadataBlob,
  readMetadataGuid,
  readMetadataString,
  sha256Bytes,
  strongNameToken,
} from "./ManagedMetadataHeaps.js";
import {
  ManagedReaderFailure,
  managedFailure,
} from "./ManagedReaderFailure.js";

type ModuleIdentity = NonNullable<ManagedArtifactInspection["module"]>;
type AssemblyIdentity = NonNullable<ManagedArtifactInspection["assembly"]>;
type AssemblyReference =
  ManagedArtifactInspection["references"]["items"][number];
type ManagedResource = ManagedArtifactInspection["resources"]["items"][number];
type CustomAttribute = ManagedArtifactInspection["attributes"]["items"][number];
type ManagedPage<Item> = {
  readonly items: readonly Item[];
  readonly offset: number;
  readonly limit: number;
  readonly total: number;
  readonly returned: number;
  readonly dropped: number;
  readonly complete: boolean;
};

export interface ManagedInventoryInput {
  readonly referenceOffset: number;
  readonly referenceLimit: number;
  readonly resourceOffset: number;
  readonly resourceLimit: number;
  readonly attributeOffset: number;
  readonly attributeLimit: number;
  readonly maxHeapItemBytes: number;
}

export interface ManagedResourceDirectory {
  readonly offset: number;
  readonly size: number;
}

export interface ManagedMetadataInventory {
  readonly module: ModuleIdentity | null;
  readonly assembly: AssemblyIdentity | null;
  readonly targetFrameworks: readonly string[];
  readonly referenceNames: readonly string[];
  readonly references: ManagedPage<AssemblyReference>;
  readonly resources: ManagedPage<ManagedResource>;
  readonly attributes: ManagedPage<CustomAttribute>;
  readonly issues: readonly ManagedParseIssue[];
}

const rowCursor = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  table: number,
  row: number,
): MetadataRowCursor => {
  const descriptor = layout.table(table);
  const start = metadataRowOffset(layout, table, row);
  if (descriptor === undefined)
    throw managedFailure(
      "invalid-row",
      `metadata.${String(table)}`,
      "Metadata table is absent",
      start,
    );
  return new MetadataRowCursor(
    bytes,
    start,
    start + descriptor.rowSize,
    `metadata.${descriptor.name}`,
  );
};

const publicKeyIdentity = (
  bytes: Buffer,
  kind: "public-key" | "public-key-token",
): AssemblyIdentity["public_key"] => ({
  kind: bytes.length === 0 ? "none" : kind,
  byte_length: bytes.length,
  sha256: bytes.length === 0 ? null : sha256Bytes(bytes),
  token:
    bytes.length === 0
      ? null
      : kind === "public-key"
        ? strongNameToken(bytes)
        : bytes.length === 8
          ? bytes.toString("hex")
          : null,
});

const readModule = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  maxBytes: number,
): ModuleIdentity | null => {
  const table = layout.table(0);
  if (table === undefined || table.rowCount === 0) return null;
  const cursor = rowCursor(bytes, layout, 0, 1);
  const generation = cursor.readUInt16();
  const name = readMetadataString(
    bytes,
    layout,
    cursor.readIndex(layout.stringIndexSize),
    maxBytes,
  );
  const mvid = readMetadataGuid(
    bytes,
    layout,
    cursor.readIndex(layout.guidIndexSize),
  );
  const encId = readMetadataGuid(
    bytes,
    layout,
    cursor.readIndex(layout.guidIndexSize),
  );
  const encBaseId = readMetadataGuid(
    bytes,
    layout,
    cursor.readIndex(layout.guidIndexSize),
  );
  return {
    name,
    generation,
    mvid,
    enc_id: encId,
    enc_base_id: encBaseId,
    token: metadataToken(0, 1),
    row_offset: table.offset,
  };
};

const readAssembly = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  maxBytes: number,
): AssemblyIdentity | null => {
  const table = layout.table(32);
  if (table === undefined || table.rowCount === 0) return null;
  const cursor = rowCursor(bytes, layout, 32, 1);
  const hashAlgorithm = cursor.readUInt32();
  const version = [
    cursor.readUInt16(),
    cursor.readUInt16(),
    cursor.readUInt16(),
    cursor.readUInt16(),
  ].join(".");
  const flags = cursor.readUInt32();
  const key = readMetadataBlob(
    bytes,
    layout,
    cursor.readIndex(layout.blobIndexSize),
    maxBytes,
  );
  const name = readMetadataString(
    bytes,
    layout,
    cursor.readIndex(layout.stringIndexSize),
    maxBytes,
  );
  const culture = readMetadataString(
    bytes,
    layout,
    cursor.readIndex(layout.stringIndexSize),
    maxBytes,
  );
  return {
    name,
    version,
    culture: culture.length === 0 ? null : culture,
    flags,
    hash_algorithm: hashAlgorithm,
    public_key: publicKeyIdentity(
      key,
      (flags & 1) === 0 ? "public-key-token" : "public-key",
    ),
    token: metadataToken(32, 1),
    row_offset: table.offset,
  };
};

const readAssemblyReference = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  row: number,
  maxBytes: number,
): AssemblyReference => {
  const cursor = rowCursor(bytes, layout, 35, row);
  const version = [
    cursor.readUInt16(),
    cursor.readUInt16(),
    cursor.readUInt16(),
    cursor.readUInt16(),
  ].join(".");
  const flags = cursor.readUInt32();
  const keyOrToken = readMetadataBlob(
    bytes,
    layout,
    cursor.readIndex(layout.blobIndexSize),
    maxBytes,
  );
  const name = readMetadataString(
    bytes,
    layout,
    cursor.readIndex(layout.stringIndexSize),
    maxBytes,
  );
  const culture = readMetadataString(
    bytes,
    layout,
    cursor.readIndex(layout.stringIndexSize),
    maxBytes,
  );
  const hashValue = readMetadataBlob(
    bytes,
    layout,
    cursor.readIndex(layout.blobIndexSize),
    maxBytes,
  );
  return {
    name,
    version,
    culture: culture.length === 0 ? null : culture,
    flags,
    public_key_or_token: publicKeyIdentity(
      keyOrToken,
      (flags & 1) === 0 ? "public-key-token" : "public-key",
    ),
    hash_value_sha256: hashValue.length === 0 ? null : sha256Bytes(hashValue),
    hash_value_length: hashValue.length,
    token: metadataToken(35, row),
    row_offset: metadataRowOffset(layout, 35, row),
  };
};

const codedToken = (
  raw: number,
  bits: number,
  tables: readonly (number | undefined)[],
): string | null => {
  if (raw === 0) return null;
  const tag = raw & (2 ** bits - 1);
  const row = Math.floor(raw / 2 ** bits);
  const table = tables[tag];
  return table === undefined || row === 0 ? null : metadataToken(table, row);
};

const readTypeName = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  table: 1 | 2,
  row: number,
  maxBytes: number,
): string | null => {
  const descriptor = layout.table(table);
  if (descriptor === undefined || row < 1 || row > descriptor.rowCount)
    return null;
  const cursor = rowCursor(bytes, layout, table, row);
  if (table === 1) cursor.readIndex(layout.codedIndexSize("ResolutionScope"));
  else cursor.readUInt32();
  const name = readMetadataString(
    bytes,
    layout,
    cursor.readIndex(layout.stringIndexSize),
    maxBytes,
  );
  const namespace = readMetadataString(
    bytes,
    layout,
    cursor.readIndex(layout.stringIndexSize),
    maxBytes,
  );
  return namespace.length === 0 ? name : `${namespace}.${name}`;
};

const declaringTypeForMethod = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  methodRow: number,
  maxBytes: number,
): string | null => {
  const types = layout.table(2);
  const methods = layout.table(6);
  if (types === undefined || methods === undefined) return null;
  for (let row = 1; row <= types.rowCount; row += 1) {
    const cursor = rowCursor(bytes, layout, 2, row);
    cursor.readUInt32();
    const nameIndex = cursor.readIndex(layout.stringIndexSize);
    const namespaceIndex = cursor.readIndex(layout.stringIndexSize);
    cursor.readIndex(layout.codedIndexSize("TypeDefOrRef"));
    cursor.readIndex(layout.tableIndexSize(4));
    const methodStart = cursor.readIndex(layout.tableIndexSize(6));
    const methodEnd =
      row === types.rowCount
        ? methods.rowCount + 1
        : methodListForType(bytes, layout, row + 1);
    if (methodRow < methodStart || methodRow >= methodEnd) continue;
    const name = readMetadataString(bytes, layout, nameIndex, maxBytes);
    const namespace = readMetadataString(
      bytes,
      layout,
      namespaceIndex,
      maxBytes,
    );
    return namespace.length === 0 ? name : `${namespace}.${name}`;
  }
  return null;
};

const methodListForType = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  row: number,
): number => {
  const cursor = rowCursor(bytes, layout, 2, row);
  cursor.readUInt32();
  cursor.readIndex(layout.stringIndexSize);
  cursor.readIndex(layout.stringIndexSize);
  cursor.readIndex(layout.codedIndexSize("TypeDefOrRef"));
  cursor.readIndex(layout.tableIndexSize(4));
  return cursor.readIndex(layout.tableIndexSize(6));
};

const attributeTypeName = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  rawType: number,
  maxBytes: number,
): string | null => {
  const tag = rawType & 7;
  const row = Math.floor(rawType / 8);
  if (row === 0) return null;
  if (tag === 2) return declaringTypeForMethod(bytes, layout, row, maxBytes);
  if (tag !== 3) return null;
  const memberRefs = layout.table(10);
  if (memberRefs === undefined || row > memberRefs.rowCount) return null;
  const cursor = rowCursor(bytes, layout, 10, row);
  const parent = cursor.readIndex(layout.codedIndexSize("MemberRefParent"));
  const parentTag = parent & 7;
  const parentRow = Math.floor(parent / 8);
  if (parentTag === 0)
    return readTypeName(bytes, layout, 2, parentRow, maxBytes);
  if (parentTag === 1)
    return readTypeName(bytes, layout, 1, parentRow, maxBytes);
  if (parentTag === 3)
    return declaringTypeForMethod(bytes, layout, parentRow, maxBytes);
  return null;
};

const decodeCompressedLength = (
  blob: Buffer,
  offset: number,
): { readonly length: number; readonly prefix: number } | undefined => {
  const first = blob[offset];
  if (first === undefined) return undefined;
  if ((first & 0x80) === 0) return { length: first, prefix: 1 };
  if ((first & 0xc0) === 0x80 && blob[offset + 1] !== undefined)
    return {
      length: ((first & 0x3f) << 8) | (blob[offset + 1] ?? 0),
      prefix: 2,
    };
  if (
    (first & 0xe0) === 0xc0 &&
    blob[offset + 1] !== undefined &&
    blob[offset + 2] !== undefined &&
    blob[offset + 3] !== undefined
  )
    return {
      length:
        (first & 0x1f) * 0x01_00_00_00 +
        (blob[offset + 1] ?? 0) * 0x01_00_00 +
        (blob[offset + 2] ?? 0) * 0x0100 +
        (blob[offset + 3] ?? 0),
      prefix: 4,
    };
  return undefined;
};

const decodeFixedString = (blob: Buffer): string | null => {
  if (blob.length < 3 || blob.readUInt16LE(0) !== 1 || blob[2] === 0xff)
    return null;
  const length = decodeCompressedLength(blob, 2);
  if (length === undefined) return null;
  const start = 2 + length.prefix;
  if (start > blob.length - length.length) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      blob.subarray(start, start + length.length),
    );
  } catch {
    return null;
  }
};

const readCustomAttribute = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  row: number,
  maxBytes: number,
): CustomAttribute => {
  const cursor = rowCursor(bytes, layout, 12, row);
  const parentRaw = cursor.readIndex(
    layout.codedIndexSize("HasCustomAttribute"),
  );
  const typeRaw = cursor.readIndex(
    layout.codedIndexSize("CustomAttributeType"),
  );
  const value = readMetadataBlob(
    bytes,
    layout,
    cursor.readIndex(layout.blobIndexSize),
    maxBytes,
  );
  const parent = codedToken(
    parentRaw,
    5,
    [
      6, 4, 1, 2, 8, 9, 10, 0, 14, 23, 20, 17, 26, 27, 32, 35, 38, 39, 40, 42,
      44, 43,
    ],
  );
  if (parent === null)
    throw managedFailure(
      "invalid-row",
      "metadata.CustomAttribute",
      "CustomAttribute parent coded index is invalid",
      cursor.start,
    );
  const typeName = attributeTypeName(bytes, layout, typeRaw, maxBytes);
  return {
    parent_token: parent,
    constructor_token: codedToken(typeRaw, 3, [undefined, undefined, 6, 10]),
    type_name: typeName,
    value_length: value.length,
    value_sha256: sha256Bytes(value),
    decoded_fixed_string:
      typeName === "System.Runtime.Versioning.TargetFrameworkAttribute"
        ? decodeFixedString(value)
        : null,
    token: metadataToken(12, row),
    row_offset: cursor.start,
  };
};

const readResource = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  row: number,
  maxBytes: number,
  directory: ManagedResourceDirectory | null,
  issues: ManagedParseIssue[],
): ManagedResource => {
  const cursor = rowCursor(bytes, layout, 40, row);
  const declaredOffset = cursor.readUInt32();
  const flags = cursor.readUInt32();
  const name = readMetadataString(
    bytes,
    layout,
    cursor.readIndex(layout.stringIndexSize),
    maxBytes,
  );
  const implementationRaw = cursor.readIndex(
    layout.codedIndexSize("Implementation"),
  );
  const implementationToken = codedToken(implementationRaw, 2, [38, 35, 39]);
  let dataLength: number | null = null;
  let dataSha256: string | null = null;
  if (implementationRaw === 0) {
    if (directory === null || declaredOffset > directory.size - 4) {
      issues.push({
        code: "invalid-resource",
        scope: `metadata.ManifestResource:${metadataToken(40, row)}`,
        offset: directory?.offset ?? null,
        detail: "Embedded resource offset leaves the CLI resources directory",
      });
    } else {
      const start = directory.offset + declaredOffset;
      dataLength = bytes.readUInt32LE(start);
      if (dataLength > directory.size - declaredOffset - 4) {
        issues.push({
          code: "invalid-resource",
          scope: `metadata.ManifestResource:${metadataToken(40, row)}`,
          offset: start,
          detail: "Embedded resource length leaves the CLI resources directory",
        });
      } else if (dataLength > maxBytes) {
        issues.push({
          code: "limit-exceeded",
          scope: `metadata.ManifestResource:${metadataToken(40, row)}`,
          offset: start + 4,
          detail: `Embedded resource exceeds max_heap_item_bytes ${String(maxBytes)}; digest omitted`,
        });
      } else {
        dataSha256 = sha256Bytes(
          bytes.subarray(start + 4, start + 4 + dataLength),
        );
      }
    }
  }
  return {
    name,
    flags,
    visibility:
      (flags & 7) === 1 ? "public" : (flags & 7) === 2 ? "private" : "unknown",
    implementation_token: implementationToken,
    embedded: implementationRaw === 0,
    declared_offset: declaredOffset,
    data_length: dataLength,
    data_sha256: dataSha256,
    token: metadataToken(40, row),
    row_offset: cursor.start,
  };
};

const safeRead = <Value>(
  operation: () => Value,
  issues: ManagedParseIssue[],
): Value | undefined => {
  try {
    return operation();
  } catch (cause: unknown) {
    if (!(cause instanceof ManagedReaderFailure)) throw cause;
    issues.push(cause.issue);
    return undefined;
  }
};

const pageRows = <Item>(
  descriptor: MetadataTableLayout | undefined,
  offset: number,
  limit: number,
  read: (row: number) => Item | undefined,
): ManagedPage<Item> => {
  const total = descriptor?.rowCount ?? 0;
  const items: Item[] = [];
  const end = Math.min(total, offset + limit);
  for (let index = offset; index < end; index += 1) {
    const item = read(index + 1);
    if (item !== undefined) items.push(item);
  }
  return {
    items,
    offset,
    limit,
    total,
    returned: items.length,
    dropped: total - items.length,
    complete: offset === 0 && end === total && items.length === total,
  };
};

const uniqueIssues = (
  issues: readonly ManagedParseIssue[],
): readonly ManagedParseIssue[] => [
  ...new Map(issues.map((issue) => [JSON.stringify(issue), issue])).values(),
];

/** Inventory bounded identity tables without CLR reflection or execution. */
export const readManagedMetadataInventory = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  input: ManagedInventoryInput,
  resourceDirectory: ManagedResourceDirectory | null,
): ManagedMetadataInventory => {
  const issues: ManagedParseIssue[] = [];
  const module =
    safeRead(() => readModule(bytes, layout, input.maxHeapItemBytes), issues) ??
    null;
  const assembly =
    safeRead(
      () => readAssembly(bytes, layout, input.maxHeapItemBytes),
      issues,
    ) ?? null;
  const references = pageRows(
    layout.table(35),
    input.referenceOffset,
    input.referenceLimit,
    (row) =>
      safeRead(
        () => readAssemblyReference(bytes, layout, row, input.maxHeapItemBytes),
        issues,
      ),
  );
  const resources = pageRows(
    layout.table(40),
    input.resourceOffset,
    input.resourceLimit,
    (row) =>
      safeRead(
        () =>
          readResource(
            bytes,
            layout,
            row,
            input.maxHeapItemBytes,
            resourceDirectory,
            issues,
          ),
        issues,
      ),
  );
  const attributes = pageRows(
    layout.table(12),
    input.attributeOffset,
    input.attributeLimit,
    (row) =>
      safeRead(
        () => readCustomAttribute(bytes, layout, row, input.maxHeapItemBytes),
        issues,
      ),
  );
  const referenceNames: string[] = [];
  const referenceTable = layout.table(35);
  for (let row = 1; row <= (referenceTable?.rowCount ?? 0); row += 1) {
    const reference = safeRead(
      () => readAssemblyReference(bytes, layout, row, input.maxHeapItemBytes),
      issues,
    );
    if (reference !== undefined) referenceNames.push(reference.name);
  }
  const targetFrameworks: string[] = [];
  const attributeTable = layout.table(12);
  for (let row = 1; row <= (attributeTable?.rowCount ?? 0); row += 1) {
    const attribute = safeRead(
      () => readCustomAttribute(bytes, layout, row, input.maxHeapItemBytes),
      issues,
    );
    if (
      attribute?.parent_token === metadataToken(32, 1) &&
      attribute.type_name ===
        "System.Runtime.Versioning.TargetFrameworkAttribute" &&
      attribute.decoded_fixed_string !== null &&
      !targetFrameworks.includes(attribute.decoded_fixed_string)
    )
      targetFrameworks.push(attribute.decoded_fixed_string);
  }
  return {
    module,
    assembly,
    targetFrameworks: targetFrameworks.sort(),
    referenceNames: [...new Set(referenceNames)].sort(),
    references,
    resources,
    attributes,
    issues: uniqueIssues(issues),
  };
};

/** Stable table-name/count projection for caller-visible coverage. */
export const managedTableRowCounts = (
  layout: ManagedMetadataLayout,
): Readonly<Record<string, number>> =>
  Object.fromEntries(
    [...layout.tables.values()].map(({ index, rowCount }) => [
      METADATA_TABLE_NAMES[index] ?? `Table${String(index)}`,
      rowCount,
    ]),
  );
