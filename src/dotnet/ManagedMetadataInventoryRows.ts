import { managedDecodeBudget } from "./ManagedDecodeBudget.js";

import type {
  ManagedArtifactInspection,
  ManagedParseIssue,
} from "../domain/managed/managedArtifact.js";
import {
  metadataRowOffset,
  type ManagedMetadataLayout,
} from "./ManagedMetadataLayout.js";
import {
  metadataRowCursor,
  metadataCodedToken,
  metadataCodedTokenInvalidReason,
  metadataToken,
  readMetadataBlob,
  readMetadataGuid,
  readMetadataString,
} from "./ManagedMetadataHeaps.js";
import { managedFailure } from "./ManagedReaderFailure.js";
import type { ManagedResourceDirectory } from "./ManagedMetadataInventory.js";

type ModuleIdentity = NonNullable<ManagedArtifactInspection["module"]>;
type AssemblyIdentity = NonNullable<ManagedArtifactInspection["assembly"]>;
type AssemblyReference = ManagedArtifactInspection["references"][number];
type ManagedResource = ManagedArtifactInspection["resources"][number];
type CustomAttribute = ManagedArtifactInspection["attributes"][number];

const publicKeyIdentity = (
  bytes: Buffer,
  kind: "public-key" | "public-key-token",
  layout: ManagedMetadataLayout,
): AssemblyIdentity["public_key"] => ({
  kind: bytes.length === 0 ? "none" : kind,
  byte_length: bytes.length,
  sha256:
    bytes.length === 0
      ? null
      : managedDecodeBudget(layout).digest(bytes, "sha256"),
  token:
    bytes.length === 0
      ? null
      : kind === "public-key"
        ? Buffer.from(managedDecodeBudget(layout).digest(bytes, "sha1"), "hex")
            .subarray(-8)
            .reverse()
            .toString("hex")
        : bytes.length === 8
          ? bytes.toString("hex")
          : null,
});

export const readModule = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  heapExtent: number,
): ModuleIdentity | null => {
  const table = layout.table(0);
  if (table === undefined || table.rowCount === 0) return null;
  const cursor = metadataRowCursor(bytes, layout, 0, 1);
  const generation = cursor.readUInt16();
  const name = readMetadataString(
    bytes,
    layout,
    cursor.readIndex(layout.stringIndexSize),
    heapExtent,
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

export const readAssembly = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  heapExtent: number,
): AssemblyIdentity | null => {
  const table = layout.table(32);
  if (table === undefined || table.rowCount === 0) return null;
  const cursor = metadataRowCursor(bytes, layout, 32, 1);
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
    heapExtent,
  );
  const name = readMetadataString(
    bytes,
    layout,
    cursor.readIndex(layout.stringIndexSize),
    heapExtent,
  );
  const culture = readMetadataString(
    bytes,
    layout,
    cursor.readIndex(layout.stringIndexSize),
    heapExtent,
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
      layout,
    ),
    token: metadataToken(32, 1),
    row_offset: table.offset,
  };
};

export const readAssemblyReference = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  row: number,
  heapExtent: number,
): AssemblyReference => {
  const cursor = metadataRowCursor(bytes, layout, 35, row);
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
    heapExtent,
  );
  const name = readMetadataString(
    bytes,
    layout,
    cursor.readIndex(layout.stringIndexSize),
    heapExtent,
  );
  const culture = readMetadataString(
    bytes,
    layout,
    cursor.readIndex(layout.stringIndexSize),
    heapExtent,
  );
  const hashValue = readMetadataBlob(
    bytes,
    layout,
    cursor.readIndex(layout.blobIndexSize),
    heapExtent,
  );
  return {
    name,
    version,
    culture: culture.length === 0 ? null : culture,
    flags,
    public_key_or_token: publicKeyIdentity(
      keyOrToken,
      (flags & 1) === 0 ? "public-key-token" : "public-key",
      layout,
    ),
    hash_value_sha256:
      hashValue.length === 0
        ? null
        : managedDecodeBudget(layout).digest(hashValue, "sha256"),
    hash_value_length: hashValue.length,
    token: metadataToken(35, row),
    row_offset: metadataRowOffset(layout, 35, row),
  };
};

interface ReadTypeNameContext {
  readonly bytes: Buffer;
  readonly layout: ManagedMetadataLayout;
  readonly table: 1 | 2;
  readonly row: number;
  readonly heapExtent: number;
}

const readTypeName = ({
  bytes,
  layout,
  table,
  row,
  heapExtent,
}: ReadTypeNameContext): string | null => {
  const descriptor = layout.table(table);
  if (descriptor === undefined || row < 1 || row > descriptor.rowCount)
    return null;
  const cursor = metadataRowCursor(bytes, layout, table, row);
  if (table === 1) cursor.readIndex(layout.codedIndexSize("ResolutionScope"));
  else cursor.readUInt32();
  const name = readMetadataString(
    bytes,
    layout,
    cursor.readIndex(layout.stringIndexSize),
    heapExtent,
  );
  const namespace = readMetadataString(
    bytes,
    layout,
    cursor.readIndex(layout.stringIndexSize),
    heapExtent,
  );
  return namespace.length === 0 ? name : `${namespace}.${name}`;
};

const declaringTypeForMethod = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  methodRow: number,
  heapExtent: number,
): string | null => {
  const types = layout.table(2);
  const methods = layout.table(6);
  if (types === undefined || methods === undefined) return null;
  for (let row = 1; row <= types.rowCount; row += 1) {
    const cursor = metadataRowCursor(bytes, layout, 2, row);
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
    const name = readMetadataString(bytes, layout, nameIndex, heapExtent);
    const namespace = readMetadataString(
      bytes,
      layout,
      namespaceIndex,
      heapExtent,
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
  const cursor = metadataRowCursor(bytes, layout, 2, row);
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
  heapExtent: number,
): string | null => {
  const tag = rawType & 7;
  const row = Math.floor(rawType / 8);
  if (row === 0) return null;
  if (tag === 2) return declaringTypeForMethod(bytes, layout, row, heapExtent);
  if (tag !== 3) return null;
  const memberRefs = layout.table(10);
  if (memberRefs === undefined || row > memberRefs.rowCount) return null;
  const cursor = metadataRowCursor(bytes, layout, 10, row);
  const parent = cursor.readIndex(layout.codedIndexSize("MemberRefParent"));
  const parentTag = parent & 7;
  const parentRow = Math.floor(parent / 8);
  if (parentTag === 0)
    return readTypeName({
      bytes,
      layout,
      table: 2,
      row: parentRow,
      heapExtent,
    });
  if (parentTag === 1)
    return readTypeName({
      bytes,
      layout,
      table: 1,
      row: parentRow,
      heapExtent,
    });
  if (parentTag === 3)
    return declaringTypeForMethod(bytes, layout, parentRow, heapExtent);
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

const decodeFixedString = (
  blob: Buffer,
  layout: ManagedMetadataLayout,
): string | null => {
  if (blob.length < 3 || blob.readUInt16LE(0) !== 1 || blob[2] === 0xff)
    return null;
  const length = decodeCompressedLength(blob, 2);
  if (length === undefined) return null;
  const start = 2 + length.prefix;
  if (start > blob.length - length.length) return null;
  managedDecodeBudget(layout).reserveString(length.length, layout.blob.offset);
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      blob.subarray(start, start + length.length),
    );
  } catch (cause: unknown) {
    // Invalid UTF-8 blobs decode as null.
    void cause;
    return null;
  }
};

export const readCustomAttribute = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  row: number,
  heapExtent: number,
): CustomAttribute => {
  const cursor = metadataRowCursor(bytes, layout, 12, row);
  const parentRaw = cursor.readIndex(
    layout.codedIndexSize("HasCustomAttribute"),
  );
  const typeOffset = cursor.offset;
  const typeRaw = cursor.readIndex(
    layout.codedIndexSize("CustomAttributeType"),
  );
  const value = readMetadataBlob(
    bytes,
    layout,
    cursor.readIndex(layout.blobIndexSize),
    heapExtent,
  );
  const parent = metadataCodedToken(
    parentRaw,
    5,
    [
      6, 4, 1, 2, 8, 9, 10, 0, 14, 23, 20, 17, 26, 27, 32, 35, 38, 39, 40, 42,
      44, 43,
    ],
    layout.rowCounts,
  );
  const parentReason = metadataCodedTokenInvalidReason(
    parentRaw,
    5,
    [
      6, 4, 1, 2, 8, 9, 10, 0, 14, 23, 20, 17, 26, 27, 32, 35, 38, 39, 40, 42,
      44, 43,
    ],
    layout.rowCounts,
  );
  if (parent === null)
    throw managedFailure(
      "invalid-row",
      `metadata.CustomAttribute:${metadataToken(12, row)}`,
      `CustomAttribute parent coded index 0x${parentRaw.toString(16)} is invalid${parentReason === null ? " because the required parent is null" : `: ${parentReason}`}`,
      cursor.start,
    );
  const typeReason = metadataCodedTokenInvalidReason(
    typeRaw,
    3,
    [undefined, undefined, 6, 10],
    layout.rowCounts,
  );
  if (typeReason !== null || typeRaw === 0)
    throw managedFailure(
      "invalid-row",
      `metadata.CustomAttribute:${metadataToken(12, row)}`,
      typeReason === null
        ? "CustomAttribute constructor coded index 0x0 is null, but Type must reference a MethodDef or MemberRef row"
        : `CustomAttribute constructor coded index 0x${typeRaw.toString(16)} is invalid: ${typeReason}`,
      typeOffset,
    );
  const typeName = attributeTypeName(bytes, layout, typeRaw, heapExtent);
  return {
    parent_token: parent,
    constructor_token: metadataCodedToken(
      typeRaw,
      3,
      [undefined, undefined, 6, 10],
      layout.rowCounts,
    ),
    type_name: typeName,
    value_length: value.length,
    value_sha256: managedDecodeBudget(layout).digest(value, "sha256"),
    decoded_fixed_string:
      typeName === "System.Runtime.Versioning.TargetFrameworkAttribute"
        ? decodeFixedString(value, layout)
        : null,
    token: metadataToken(12, row),
    row_offset: cursor.start,
  };
};

interface ReadResourceContext {
  readonly bytes: Buffer;
  readonly layout: ManagedMetadataLayout;
  readonly row: number;
  readonly directory: ManagedResourceDirectory | null;
  readonly issues: ManagedParseIssue[];
}

export const readResource = ({
  bytes,
  layout,
  row,
  directory,
  issues,
}: ReadResourceContext): ManagedResource => {
  const cursor = metadataRowCursor(bytes, layout, 40, row);
  const declaredOffset = cursor.readUInt32();
  const flags = cursor.readUInt32();
  const name = readMetadataString(
    bytes,
    layout,
    cursor.readIndex(layout.stringIndexSize),
    Math.max(layout.strings.size, layout.blob.size),
  );
  const implementationOffset = cursor.offset;
  const implementationRaw = cursor.readIndex(
    layout.codedIndexSize("Implementation"),
  );
  const implementationToken = metadataCodedToken(
    implementationRaw,
    2,
    [38, 35, 39],
    layout.rowCounts,
  );
  const implementationReason = metadataCodedTokenInvalidReason(
    implementationRaw,
    2,
    [38, 35, 39],
    layout.rowCounts,
  );
  if (implementationReason !== null)
    issues.push({
      code: "invalid-row",
      scope: `metadata.ManifestResource:${metadataToken(40, row)}`,
      offset: implementationOffset,
      detail: `ManifestResource implementation coded index 0x${implementationRaw.toString(16)} is invalid: ${implementationReason}`,
    });
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
      } else {
        dataSha256 = managedDecodeBudget(layout).digest(
          bytes.subarray(start + 4, start + 4 + dataLength),
          "sha256",
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
