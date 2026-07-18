import type { ManagedMemberInspection } from "../domain/managedArtifact.js";
import {
  metadataRowOffset,
  type ManagedMetadataLayout,
  type MetadataTableLayout,
} from "./ManagedMetadataLayout.js";
import {
  MetadataRowCursor,
  metadataToken,
  readMetadataString,
  sha256Bytes,
} from "./ManagedMetadataHeaps.js";
import { managedFailure } from "./ManagedReaderFailure.js";

export type ManagedPage<Item> = {
  readonly items: readonly Item[];
  readonly offset: number;
  readonly limit: number;
  readonly total: number;
  readonly returned: number;
  readonly dropped: number;
  readonly complete: boolean;
};
export type ManagedType = ManagedMemberInspection["types"]["items"][number];
export type ManagedField = ManagedMemberInspection["fields"]["items"][number];
export type ManagedMethod = ManagedMemberInspection["methods"]["items"][number];
export type ManagedMemberRef =
  ManagedMemberInspection["member_refs"]["items"][number];
export type ManagedCallEdge =
  ManagedMemberInspection["call_edges"]["items"][number];
export type ManagedFieldAccess =
  ManagedMemberInspection["field_accesses"]["items"][number];
export type ManagedSignature = ManagedMethod["signature"];
export type ManagedMethodBody = ManagedMethod["body"];
export type ManagedInstructionAnchor = ManagedMethodBody["anchors"][number];
export type ManagedExceptionRegion =
  ManagedMethodBody["exception_regions"][number];

export interface ManagedMemberInspectionLimits {
  readonly typeOffset: number;
  readonly typeLimit: number;
  readonly methodOffset: number;
  readonly methodLimit: number;
  readonly fieldOffset: number;
  readonly fieldLimit: number;
  readonly memberRefOffset: number;
  readonly memberRefLimit: number;
  readonly edgeOffset: number;
  readonly edgeLimit: number;
  readonly instructionAnchorLimit: number;
  readonly maxMetadataBytes: number;
  readonly maxTableRows: number;
  readonly maxHeapItemBytes: number;
  readonly maxMethodBodyBytes: number;
  readonly maxMethodInstructions: number;
}

export interface TypeRange {
  readonly token: string;
  readonly fullName: string;
  readonly fieldStart: number;
  readonly fieldEnd: number;
  readonly methodStart: number;
  readonly methodEnd: number;
}

export interface MethodCore {
  readonly token: string;
  readonly name: string;
  readonly declaringType: string | null;
}

export interface FieldCore {
  readonly token: string;
  readonly name: string;
}

export interface MemberRefCore {
  readonly token: string;
  readonly name: string;
}

export interface ParsedInstruction {
  readonly offset: number;
  readonly opcode: string;
  readonly operandKind: ManagedInstructionAnchor["operand_kind"];
  readonly operand: string | null;
}

export const emptyPage = <Item>(
  offset: number,
  limit: number,
): ManagedPage<Item> => ({
  items: [],
  offset,
  limit,
  total: 0,
  returned: 0,
  dropped: 0,
  complete: offset === 0,
});

export const page = <Item>(
  all: readonly Item[],
  offset: number,
  limit: number,
): ManagedPage<Item> => {
  const items = all.slice(offset, offset + limit);
  return {
    items,
    offset,
    limit,
    total: all.length,
    returned: items.length,
    dropped: all.length - items.length,
    complete: offset === 0 && offset + limit >= all.length,
  };
};

export const rowCursor = (
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

export const codedToken = (
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

const rowRange = (
  table: MetadataTableLayout | undefined,
  start: number,
  nextStart: number,
): {
  readonly first: number | null;
  readonly last: number | null;
  readonly count: number;
} => {
  const total = table?.rowCount ?? 0;
  if (total === 0 || start === 0) return { first: null, last: null, count: 0 };
  const end = Math.min(nextStart === 0 ? total + 1 : nextStart, total + 1);
  if (start >= end) return { first: null, last: null, count: 0 };
  return { first: start, last: end - 1, count: end - start };
};

const fullName = (namespace: string, name: string): string =>
  namespace.length === 0 ? name : `${namespace}.${name}`;

const readTypeRange = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  row: number,
  maxBytes: number,
): TypeRange => {
  const methods = layout.table(6);
  const fields = layout.table(4);
  const cursor = rowCursor(bytes, layout, 2, row);
  cursor.readUInt32();
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
  cursor.readIndex(layout.codedIndexSize("TypeDefOrRef"));
  const fieldStart = cursor.readIndex(layout.tableIndexSize(4));
  const methodStart = cursor.readIndex(layout.tableIndexSize(6));
  let nextField = (fields?.rowCount ?? 0) + 1;
  let nextMethod = (methods?.rowCount ?? 0) + 1;
  const typeTable = layout.table(2);
  if (typeTable !== undefined && row < typeTable.rowCount) {
    const next = rowCursor(bytes, layout, 2, row + 1);
    next.readUInt32();
    next.readIndex(layout.stringIndexSize);
    next.readIndex(layout.stringIndexSize);
    next.readIndex(layout.codedIndexSize("TypeDefOrRef"));
    nextField = next.readIndex(layout.tableIndexSize(4));
    nextMethod = next.readIndex(layout.tableIndexSize(6));
  }
  return {
    token: metadataToken(2, row),
    fullName: fullName(namespace, name),
    fieldStart,
    fieldEnd: nextField,
    methodStart,
    methodEnd: nextMethod,
  };
};

export const typeRanges = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  maxBytes: number,
): readonly TypeRange[] => {
  const typeTable = layout.table(2);
  const ranges: TypeRange[] = [];
  for (let row = 1; row <= (typeTable?.rowCount ?? 0); row += 1)
    ranges.push(readTypeRange(bytes, layout, row, maxBytes));
  return ranges;
};

export const declaringType = (
  ranges: readonly TypeRange[],
  table: "field" | "method",
  row: number,
): { readonly token: string; readonly fullName: string } | null => {
  for (const range of ranges) {
    const start = table === "field" ? range.fieldStart : range.methodStart;
    const end = table === "field" ? range.fieldEnd : range.methodEnd;
    if (row >= start && row < end)
      return { token: range.token, fullName: range.fullName };
  }
  return null;
};

export const parseTypes = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  ranges: readonly TypeRange[],
  maxBytes: number,
): readonly ManagedType[] => {
  const typeTable = layout.table(2);
  const fields = layout.table(4);
  const methods = layout.table(6);
  const items: ManagedType[] = [];
  for (let row = 1; row <= (typeTable?.rowCount ?? 0); row += 1) {
    const cursor = rowCursor(bytes, layout, 2, row);
    const flags = cursor.readUInt32();
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
    const extendsRaw = cursor.readIndex(layout.codedIndexSize("TypeDefOrRef"));
    const fieldStart = cursor.readIndex(layout.tableIndexSize(4));
    const methodStart = cursor.readIndex(layout.tableIndexSize(6));
    const nextRange = ranges[row] ?? null;
    const fieldRange = rowRange(fields, fieldStart, nextRange?.fieldStart ?? 0);
    const methodRange = rowRange(
      methods,
      methodStart,
      nextRange?.methodStart ?? 0,
    );
    items.push({
      token: metadataToken(2, row),
      row_offset: cursor.start,
      namespace,
      name,
      full_name: fullName(namespace, name),
      flags,
      extends_token: codedToken(extendsRaw, 2, [2, 1, 27]),
      field_list: {
        first_row: fieldRange.first,
        last_row: fieldRange.last,
        count: fieldRange.count,
      },
      method_list: {
        first_row: methodRange.first,
        last_row: methodRange.last,
        count: methodRange.count,
      },
    });
  }
  return items;
};

export const readCompressed = (
  bytes: Buffer,
  offset: number,
): { readonly value: number; readonly next: number } => {
  const first = bytes[offset];
  if (first === undefined) throw new RangeError("truncated compressed integer");
  if ((first & 0x80) === 0) return { value: first, next: offset + 1 };
  const second = bytes[offset + 1];
  if ((first & 0xc0) === 0x80 && second !== undefined)
    return { value: ((first & 0x3f) << 8) | second, next: offset + 2 };
  const b1 = bytes[offset + 1];
  const b2 = bytes[offset + 2];
  const b3 = bytes[offset + 3];
  if (
    (first & 0xe0) === 0xc0 &&
    b1 !== undefined &&
    b2 !== undefined &&
    b3 !== undefined
  )
    return {
      value:
        (first & 0x1f) * 0x01_00_00_00 + b1 * 0x01_00_00 + b2 * 0x0100 + b3,
      next: offset + 4,
    };
  throw new RangeError("reserved compressed integer");
};

const ELEMENT_TYPES = new Map<number, string>([
  [0x01, "void"],
  [0x02, "bool"],
  [0x03, "char"],
  [0x04, "i1"],
  [0x05, "u1"],
  [0x06, "i2"],
  [0x07, "u2"],
  [0x08, "i4"],
  [0x09, "u4"],
  [0x0a, "i8"],
  [0x0b, "u8"],
  [0x0c, "r4"],
  [0x0d, "r8"],
  [0x0e, "string"],
  [0x18, "native-int"],
  [0x19, "native-uint"],
  [0x1c, "object"],
]);

const ELEMENT_TYPE_SUFFIXES = new Map<number, string>([
  [0x0f, "*"],
  [0x10, "&"],
]);

const readTypeSignature = (
  blob: Buffer,
  offset: number,
): { readonly value: string; readonly next: number } => {
  const kind = blob[offset];
  if (kind === undefined) throw new RangeError("truncated type signature");
  const named = ELEMENT_TYPES.get(kind);
  if (named !== undefined) return { value: named, next: offset + 1 };
  const suffix = ELEMENT_TYPE_SUFFIXES.get(kind);
  if (suffix !== undefined) {
    const inner = readTypeSignature(blob, offset + 1);
    return { value: `${inner.value}${suffix}`, next: inner.next };
  }
  if (kind === 0x11 || kind === 0x12) {
    const token = readCompressed(blob, offset + 1);
    return {
      value: `${kind === 0x11 ? "valuetype" : "class"}:${String(token.value)}`,
      next: token.next,
    };
  }
  if (kind === 0x1d) {
    const inner = readTypeSignature(blob, offset + 1);
    return { value: `${inner.value}[]`, next: inner.next };
  }
  if (kind === 0x1e) {
    const variable = readCompressed(blob, offset + 1);
    return { value: `mvar:${String(variable.value)}`, next: variable.next };
  }
  if (kind === 0x13) {
    const variable = readCompressed(blob, offset + 1);
    return { value: `var:${String(variable.value)}`, next: variable.next };
  }
  throw new RangeError(`unsupported element type 0x${kind.toString(16)}`);
};

const callingConvention = (value: number): string => {
  const base = value & 0x0f;
  const flags = [
    (value & 0x20) === 0 ? null : "has-this",
    (value & 0x40) === 0 ? null : "explicit-this",
    (value & 0x10) === 0 ? null : "generic",
  ].filter((flag) => flag !== null);
  const name =
    base === 0
      ? "default"
      : base === 5
        ? "vararg"
        : base === 6
          ? "field"
          : `unknown:${String(base)}`;
  return flags.length === 0 ? name : `${name} ${flags.join(" ")}`;
};

export const signature = (blob: Buffer): ManagedSignature => {
  const raw = {
    raw_length: blob.length,
    raw_sha256: sha256Bytes(blob),
  };
  try {
    if (blob.length === 0) throw new RangeError("empty signature");
    const first = blob[0] ?? 0;
    if ((first & 0x0f) === 6) {
      const fieldType = readTypeSignature(blob, 1);
      return {
        ...raw,
        kind: "field",
        parse_status: fieldType.next === blob.length ? "decoded" : "partial",
        calling_convention: callingConvention(first),
        generic_parameter_count: null,
        parameter_count: null,
        return_type: null,
        parameter_types: [],
        field_type: fieldType.value,
        issue:
          fieldType.next === blob.length ? null : "Trailing signature data",
      };
    }
    let offset = 1;
    let genericParameterCount: number | null = null;
    if ((first & 0x10) !== 0) {
      const generic = readCompressed(blob, offset);
      genericParameterCount = generic.value;
      offset = generic.next;
    }
    const parameterCount = readCompressed(blob, offset);
    offset = parameterCount.next;
    const returnType = readTypeSignature(blob, offset);
    offset = returnType.next;
    const parameters: string[] = [];
    for (let index = 0; index < parameterCount.value; index += 1) {
      const parameter = readTypeSignature(blob, offset);
      parameters.push(parameter.value);
      offset = parameter.next;
    }
    return {
      ...raw,
      kind: "method",
      parse_status: offset === blob.length ? "decoded" : "partial",
      calling_convention: callingConvention(first),
      generic_parameter_count: genericParameterCount,
      parameter_count: parameterCount.value,
      return_type: returnType.value,
      parameter_types: parameters,
      field_type: null,
      issue: offset === blob.length ? null : "Trailing signature data",
    };
  } catch (cause: unknown) {
    return {
      ...raw,
      kind: "unknown",
      parse_status: cause instanceof RangeError ? "unsupported" : "malformed",
      calling_convention: null,
      generic_parameter_count: null,
      parameter_count: null,
      return_type: null,
      parameter_types: [],
      field_type: null,
      issue: cause instanceof Error ? cause.message : "Signature parse failed",
    };
  }
};
