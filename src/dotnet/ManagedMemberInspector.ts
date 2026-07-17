import type { BinaryTarget } from "../domain/binaryTarget.js";
import {
  managedMemberInspectionSchema,
  type ManagedMemberInspection,
  type ManagedParseIssue,
} from "../domain/managedArtifact.js";
import {
  readManagedPeLayout,
  type ManagedPeLayout,
} from "./ManagedPeReader.js";
import {
  type ManagedResourceDirectory,
  managedTableRowCounts,
  readManagedMetadataInventory,
} from "./ManagedMetadataInventory.js";
import {
  metadataRowOffset,
  readManagedMetadataLayout,
  type ManagedMetadataLayout,
  type MetadataTableLayout,
} from "./ManagedMetadataLayout.js";
import {
  MetadataRowCursor,
  metadataToken,
  readMetadataBlob,
  readMetadataString,
  sha256Bytes,
} from "./ManagedMetadataHeaps.js";
import {
  ManagedReaderFailure,
  managedFailure,
} from "./ManagedReaderFailure.js";

type ManagedPage<Item> = {
  readonly items: readonly Item[];
  readonly offset: number;
  readonly limit: number;
  readonly total: number;
  readonly returned: number;
  readonly dropped: number;
  readonly complete: boolean;
};
type ManagedType = ManagedMemberInspection["types"]["items"][number];
type ManagedField = ManagedMemberInspection["fields"]["items"][number];
type ManagedMethod = ManagedMemberInspection["methods"]["items"][number];
type ManagedMemberRef = ManagedMemberInspection["member_refs"]["items"][number];
type ManagedCallEdge = ManagedMemberInspection["call_edges"]["items"][number];
type ManagedFieldAccess =
  ManagedMemberInspection["field_accesses"]["items"][number];
type ManagedSignature = ManagedMethod["signature"];
type ManagedMethodBody = ManagedMethod["body"];
type ManagedInstructionAnchor = ManagedMethodBody["anchors"][number];
type ManagedExceptionRegion = ManagedMethodBody["exception_regions"][number];

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

interface TypeRange {
  readonly token: string;
  readonly fullName: string;
  readonly fieldStart: number;
  readonly fieldEnd: number;
  readonly methodStart: number;
  readonly methodEnd: number;
}

interface MethodCore {
  readonly token: string;
  readonly name: string;
  readonly declaringType: string | null;
}

interface FieldCore {
  readonly token: string;
  readonly name: string;
}

interface MemberRefCore {
  readonly token: string;
  readonly name: string;
}

interface ParsedInstruction {
  readonly offset: number;
  readonly opcode: string;
  readonly operandKind: ManagedInstructionAnchor["operand_kind"];
  readonly operand: string | null;
}

const emptyPage = <Item>(offset: number, limit: number): ManagedPage<Item> => ({
  items: [],
  offset,
  limit,
  total: 0,
  returned: 0,
  dropped: 0,
  complete: offset === 0,
});

const page = <Item>(
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

const typeRanges = (
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

const declaringType = (
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

const parseTypes = (
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

const readCompressed = (
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

const signature = (blob: Buffer): ManagedSignature => {
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

const opcode = (
  code: number,
): { readonly name: string; readonly operand: string } | undefined =>
  OPCODES.get(code);

const OPCODES = new Map<
  number,
  { readonly name: string; readonly operand: string }
>([
  [0x00, { name: "nop", operand: "none" }],
  [0x01, { name: "break", operand: "none" }],
  [0x02, { name: "ldarg.0", operand: "none" }],
  [0x03, { name: "ldarg.1", operand: "none" }],
  [0x04, { name: "ldarg.2", operand: "none" }],
  [0x05, { name: "ldarg.3", operand: "none" }],
  [0x06, { name: "ldloc.0", operand: "none" }],
  [0x07, { name: "ldloc.1", operand: "none" }],
  [0x08, { name: "ldloc.2", operand: "none" }],
  [0x09, { name: "ldloc.3", operand: "none" }],
  [0x0a, { name: "stloc.0", operand: "none" }],
  [0x0b, { name: "stloc.1", operand: "none" }],
  [0x0c, { name: "stloc.2", operand: "none" }],
  [0x0d, { name: "stloc.3", operand: "none" }],
  [0x0e, { name: "ldarg.s", operand: "short-var" }],
  [0x0f, { name: "ldarga.s", operand: "short-var" }],
  [0x10, { name: "starg.s", operand: "short-var" }],
  [0x11, { name: "ldloc.s", operand: "short-var" }],
  [0x12, { name: "ldloca.s", operand: "short-var" }],
  [0x13, { name: "stloc.s", operand: "short-var" }],
  [0x14, { name: "ldnull", operand: "none" }],
  [0x15, { name: "ldc.i4.m1", operand: "none" }],
  [0x16, { name: "ldc.i4.0", operand: "none" }],
  [0x17, { name: "ldc.i4.1", operand: "none" }],
  [0x18, { name: "ldc.i4.2", operand: "none" }],
  [0x19, { name: "ldc.i4.3", operand: "none" }],
  [0x1a, { name: "ldc.i4.4", operand: "none" }],
  [0x1b, { name: "ldc.i4.5", operand: "none" }],
  [0x1c, { name: "ldc.i4.6", operand: "none" }],
  [0x1d, { name: "ldc.i4.7", operand: "none" }],
  [0x1e, { name: "ldc.i4.8", operand: "none" }],
  [0x1f, { name: "ldc.i4.s", operand: "short-i" }],
  [0x20, { name: "ldc.i4", operand: "i" }],
  [0x21, { name: "ldc.i8", operand: "i8" }],
  [0x22, { name: "ldc.r4", operand: "r4" }],
  [0x23, { name: "ldc.r8", operand: "r8" }],
  [0x25, { name: "dup", operand: "none" }],
  [0x26, { name: "pop", operand: "none" }],
  [0x27, { name: "jmp", operand: "method" }],
  [0x28, { name: "call", operand: "method" }],
  [0x29, { name: "calli", operand: "signature" }],
  [0x2a, { name: "ret", operand: "none" }],
  [0x2b, { name: "br.s", operand: "short-branch" }],
  [0x2c, { name: "brfalse.s", operand: "short-branch" }],
  [0x2d, { name: "brtrue.s", operand: "short-branch" }],
  [0x2e, { name: "beq.s", operand: "short-branch" }],
  [0x2f, { name: "bge.s", operand: "short-branch" }],
  [0x30, { name: "bgt.s", operand: "short-branch" }],
  [0x31, { name: "ble.s", operand: "short-branch" }],
  [0x32, { name: "blt.s", operand: "short-branch" }],
  [0x33, { name: "bne.un.s", operand: "short-branch" }],
  [0x34, { name: "bge.un.s", operand: "short-branch" }],
  [0x35, { name: "bgt.un.s", operand: "short-branch" }],
  [0x36, { name: "ble.un.s", operand: "short-branch" }],
  [0x37, { name: "blt.un.s", operand: "short-branch" }],
  [0x38, { name: "br", operand: "branch" }],
  [0x39, { name: "brfalse", operand: "branch" }],
  [0x3a, { name: "brtrue", operand: "branch" }],
  [0x3b, { name: "beq", operand: "branch" }],
  [0x3c, { name: "bge", operand: "branch" }],
  [0x3d, { name: "bgt", operand: "branch" }],
  [0x3e, { name: "ble", operand: "branch" }],
  [0x3f, { name: "blt", operand: "branch" }],
  [0x40, { name: "bne.un", operand: "branch" }],
  [0x41, { name: "bge.un", operand: "branch" }],
  [0x42, { name: "bgt.un", operand: "branch" }],
  [0x43, { name: "ble.un", operand: "branch" }],
  [0x44, { name: "blt.un", operand: "branch" }],
  [0x45, { name: "switch", operand: "switch" }],
  [0x46, { name: "ldind.i1", operand: "none" }],
  [0x47, { name: "ldind.u1", operand: "none" }],
  [0x48, { name: "ldind.i2", operand: "none" }],
  [0x49, { name: "ldind.u2", operand: "none" }],
  [0x4a, { name: "ldind.i4", operand: "none" }],
  [0x4b, { name: "ldind.u4", operand: "none" }],
  [0x4c, { name: "ldind.i8", operand: "none" }],
  [0x4d, { name: "ldind.i", operand: "none" }],
  [0x4e, { name: "ldind.r4", operand: "none" }],
  [0x4f, { name: "ldind.r8", operand: "none" }],
  [0x50, { name: "ldind.ref", operand: "none" }],
  [0x51, { name: "stind.ref", operand: "none" }],
  [0x52, { name: "stind.i1", operand: "none" }],
  [0x53, { name: "stind.i2", operand: "none" }],
  [0x54, { name: "stind.i4", operand: "none" }],
  [0x55, { name: "stind.i8", operand: "none" }],
  [0x56, { name: "stind.r4", operand: "none" }],
  [0x57, { name: "stind.r8", operand: "none" }],
  [0x58, { name: "add", operand: "none" }],
  [0x59, { name: "sub", operand: "none" }],
  [0x5a, { name: "mul", operand: "none" }],
  [0x5b, { name: "div", operand: "none" }],
  [0x5c, { name: "div.un", operand: "none" }],
  [0x5d, { name: "rem", operand: "none" }],
  [0x5e, { name: "rem.un", operand: "none" }],
  [0x5f, { name: "and", operand: "none" }],
  [0x60, { name: "or", operand: "none" }],
  [0x61, { name: "xor", operand: "none" }],
  [0x62, { name: "shl", operand: "none" }],
  [0x63, { name: "shr", operand: "none" }],
  [0x64, { name: "shr.un", operand: "none" }],
  [0x65, { name: "neg", operand: "none" }],
  [0x66, { name: "not", operand: "none" }],
  [0x67, { name: "conv.i1", operand: "none" }],
  [0x68, { name: "conv.i2", operand: "none" }],
  [0x69, { name: "conv.i4", operand: "none" }],
  [0x6a, { name: "conv.i8", operand: "none" }],
  [0x6b, { name: "conv.r4", operand: "none" }],
  [0x6c, { name: "conv.r8", operand: "none" }],
  [0x6d, { name: "conv.u4", operand: "none" }],
  [0x6e, { name: "conv.u8", operand: "none" }],
  [0x6f, { name: "callvirt", operand: "method" }],
  [0x70, { name: "cpobj", operand: "type" }],
  [0x71, { name: "ldobj", operand: "type" }],
  [0x72, { name: "ldstr", operand: "string" }],
  [0x73, { name: "newobj", operand: "method" }],
  [0x74, { name: "castclass", operand: "type" }],
  [0x75, { name: "isinst", operand: "type" }],
  [0x76, { name: "conv.r.un", operand: "none" }],
  [0x79, { name: "unbox", operand: "type" }],
  [0x7a, { name: "throw", operand: "none" }],
  [0x7b, { name: "ldfld", operand: "field" }],
  [0x7c, { name: "ldflda", operand: "field" }],
  [0x7d, { name: "stfld", operand: "field" }],
  [0x7e, { name: "ldsfld", operand: "field" }],
  [0x7f, { name: "ldsflda", operand: "field" }],
  [0x80, { name: "stsfld", operand: "field" }],
  [0x81, { name: "stobj", operand: "type" }],
  [0x82, { name: "conv.ovf.i1.un", operand: "none" }],
  [0x83, { name: "conv.ovf.i2.un", operand: "none" }],
  [0x84, { name: "conv.ovf.i4.un", operand: "none" }],
  [0x85, { name: "conv.ovf.i8.un", operand: "none" }],
  [0x86, { name: "conv.ovf.u1.un", operand: "none" }],
  [0x87, { name: "conv.ovf.u2.un", operand: "none" }],
  [0x88, { name: "conv.ovf.u4.un", operand: "none" }],
  [0x89, { name: "conv.ovf.u8.un", operand: "none" }],
  [0x8a, { name: "conv.ovf.i.un", operand: "none" }],
  [0x8b, { name: "conv.ovf.u.un", operand: "none" }],
  [0x8c, { name: "box", operand: "type" }],
  [0x8d, { name: "newarr", operand: "type" }],
  [0x8e, { name: "ldlen", operand: "none" }],
  [0x8f, { name: "ldelema", operand: "type" }],
  [0x90, { name: "ldelem.i1", operand: "none" }],
  [0x91, { name: "ldelem.u1", operand: "none" }],
  [0x92, { name: "ldelem.i2", operand: "none" }],
  [0x93, { name: "ldelem.u2", operand: "none" }],
  [0x94, { name: "ldelem.i4", operand: "none" }],
  [0x95, { name: "ldelem.u4", operand: "none" }],
  [0x96, { name: "ldelem.i8", operand: "none" }],
  [0x97, { name: "ldelem.i", operand: "none" }],
  [0x98, { name: "ldelem.r4", operand: "none" }],
  [0x99, { name: "ldelem.r8", operand: "none" }],
  [0x9a, { name: "ldelem.ref", operand: "none" }],
  [0x9b, { name: "stelem.i", operand: "none" }],
  [0x9c, { name: "stelem.i1", operand: "none" }],
  [0x9d, { name: "stelem.i2", operand: "none" }],
  [0x9e, { name: "stelem.i4", operand: "none" }],
  [0x9f, { name: "stelem.i8", operand: "none" }],
  [0xa0, { name: "stelem.r4", operand: "none" }],
  [0xa1, { name: "stelem.r8", operand: "none" }],
  [0xa2, { name: "stelem.ref", operand: "none" }],
  [0xa3, { name: "ldelem", operand: "type" }],
  [0xa4, { name: "stelem", operand: "type" }],
  [0xa5, { name: "unbox.any", operand: "type" }],
  [0xb3, { name: "conv.ovf.i1", operand: "none" }],
  [0xb4, { name: "conv.ovf.u1", operand: "none" }],
  [0xb5, { name: "conv.ovf.i2", operand: "none" }],
  [0xb6, { name: "conv.ovf.u2", operand: "none" }],
  [0xb7, { name: "conv.ovf.i4", operand: "none" }],
  [0xb8, { name: "conv.ovf.u4", operand: "none" }],
  [0xb9, { name: "conv.ovf.i8", operand: "none" }],
  [0xba, { name: "conv.ovf.u8", operand: "none" }],
  [0xc2, { name: "refanyval", operand: "type" }],
  [0xc3, { name: "ckfinite", operand: "none" }],
  [0xc6, { name: "mkrefany", operand: "type" }],
  [0xd0, { name: "ldtoken", operand: "token" }],
  [0xd1, { name: "conv.u2", operand: "none" }],
  [0xd2, { name: "conv.u1", operand: "none" }],
  [0xd3, { name: "conv.i", operand: "none" }],
  [0xd4, { name: "conv.ovf.i", operand: "none" }],
  [0xd5, { name: "conv.ovf.u", operand: "none" }],
  [0xd6, { name: "add.ovf", operand: "none" }],
  [0xd7, { name: "add.ovf.un", operand: "none" }],
  [0xd8, { name: "mul.ovf", operand: "none" }],
  [0xd9, { name: "mul.ovf.un", operand: "none" }],
  [0xda, { name: "sub.ovf", operand: "none" }],
  [0xdb, { name: "sub.ovf.un", operand: "none" }],
  [0xdc, { name: "endfinally", operand: "none" }],
  [0xdd, { name: "leave", operand: "branch" }],
  [0xde, { name: "leave.s", operand: "short-branch" }],
  [0xdf, { name: "stind.i", operand: "none" }],
  [0xe0, { name: "conv.u", operand: "none" }],
  [0xfe00, { name: "arglist", operand: "none" }],
  [0xfe01, { name: "ceq", operand: "none" }],
  [0xfe02, { name: "cgt", operand: "none" }],
  [0xfe03, { name: "cgt.un", operand: "none" }],
  [0xfe04, { name: "clt", operand: "none" }],
  [0xfe05, { name: "clt.un", operand: "none" }],
  [0xfe06, { name: "ldftn", operand: "method" }],
  [0xfe07, { name: "ldvirtftn", operand: "method" }],
  [0xfe09, { name: "ldarg", operand: "var" }],
  [0xfe0a, { name: "ldarga", operand: "var" }],
  [0xfe0b, { name: "starg", operand: "var" }],
  [0xfe0c, { name: "ldloc", operand: "var" }],
  [0xfe0d, { name: "ldloca", operand: "var" }],
  [0xfe0e, { name: "stloc", operand: "var" }],
  [0xfe0f, { name: "localloc", operand: "none" }],
  [0xfe11, { name: "endfilter", operand: "none" }],
  [0xfe12, { name: "unaligned.", operand: "short-i" }],
  [0xfe13, { name: "volatile.", operand: "none" }],
  [0xfe14, { name: "tail.", operand: "none" }],
  [0xfe15, { name: "initobj", operand: "type" }],
  [0xfe16, { name: "constrained.", operand: "type" }],
  [0xfe17, { name: "cpblk", operand: "none" }],
  [0xfe18, { name: "initblk", operand: "none" }],
  [0xfe1a, { name: "rethrow", operand: "none" }],
  [0xfe1c, { name: "sizeof", operand: "type" }],
  [0xfe1d, { name: "refanytype", operand: "none" }],
  [0xfe1e, { name: "readonly.", operand: "none" }],
]);

const tokenKind = (token: string): ManagedInstructionAnchor["operand_kind"] => {
  if (
    token.startsWith("0x06") ||
    token.startsWith("0x0a") ||
    token.startsWith("0x2b")
  )
    return "method";
  if (token.startsWith("0x04")) return "field";
  if (token.startsWith("0x70")) return "string";
  if (token.startsWith("0x11")) return "signature";
  if (
    token.startsWith("0x01") ||
    token.startsWith("0x02") ||
    token.startsWith("0x1b")
  )
    return "type";
  return "token";
};

type OperandResult = {
  readonly next: number;
  readonly anchorKind: ManagedInstructionAnchor["operand_kind"];
  readonly value: string | null;
};

type OperandReader = (il: Buffer, offset: number) => OperandResult;

const FIXED_OPERAND_READERS = new Map<string, OperandReader>([
  [
    "none",
    (_il, offset) => ({ next: offset, anchorKind: "none", value: null }),
  ],
  [
    "short-var",
    (il, offset) => ({
      next: offset + 1,
      anchorKind: "variable",
      value: String(il.readUInt8(offset)),
    }),
  ],
  [
    "var",
    (il, offset) => ({
      next: offset + 2,
      anchorKind: "variable",
      value: String(il.readUInt16LE(offset)),
    }),
  ],
  [
    "short-i",
    (il, offset) => ({
      next: offset + 1,
      anchorKind: "constant",
      value: String(il.readInt8(offset)),
    }),
  ],
  [
    "i",
    (il, offset) => ({
      next: offset + 4,
      anchorKind: "constant",
      value: String(il.readInt32LE(offset)),
    }),
  ],
  [
    "i8",
    (il, offset) => ({
      next: offset + 8,
      anchorKind: "constant",
      value: il.readBigInt64LE(offset).toString(),
    }),
  ],
  [
    "r4",
    (il, offset) => ({
      next: offset + 4,
      anchorKind: "constant",
      value: String(il.readFloatLE(offset)),
    }),
  ],
  [
    "r8",
    (il, offset) => ({
      next: offset + 8,
      anchorKind: "constant",
      value: String(il.readDoubleLE(offset)),
    }),
  ],
  [
    "short-branch",
    (il, offset) => ({
      next: offset + 1,
      anchorKind: "branch",
      value: String(offset + 1 + il.readInt8(offset)),
    }),
  ],
  [
    "branch",
    (il, offset) => ({
      next: offset + 4,
      anchorKind: "branch",
      value: String(offset + 4 + il.readInt32LE(offset)),
    }),
  ],
]);

const TOKEN_OPERAND_KINDS = new Map<
  string,
  ManagedInstructionAnchor["operand_kind"]
>([
  ["method", "method"],
  ["field", "field"],
  ["type", "type"],
  ["string", "string"],
  ["signature", "signature"],
]);

const readOperand = (
  il: Buffer,
  offset: number,
  kind: string,
): OperandResult => {
  const fixed = FIXED_OPERAND_READERS.get(kind);
  if (fixed !== undefined) return fixed(il, offset);
  if (kind === "switch") {
    const count = il.readUInt32LE(offset);
    return {
      next: offset + 4 + count * 4,
      anchorKind: "switch",
      value: String(count),
    };
  }
  const raw = il.readUInt32LE(offset);
  const token = `0x${raw.toString(16).padStart(8, "0")}`;
  const tokenOperandKind = TOKEN_OPERAND_KINDS.get(kind);
  if (tokenOperandKind !== undefined)
    return { next: offset + 4, anchorKind: tokenOperandKind, value: token };
  if (kind === "token")
    return { next: offset + 4, anchorKind: tokenKind(token), value: token };
  return { next: offset, anchorKind: "unknown", value: null };
};

const decodeInstructions = (
  il: Buffer,
  limit: number,
): {
  readonly parsed: readonly ParsedInstruction[];
  readonly count: number;
  readonly truncated: number;
  readonly issue: string | null;
} => {
  const parsed: ParsedInstruction[] = [];
  let offset = 0;
  let issue: string | null = null;
  try {
    while (offset < il.length && parsed.length < limit) {
      const start = offset;
      const first = il.readUInt8(offset);
      offset += 1;
      const code = first === 0xfe ? 0xfe00 + il.readUInt8(offset++) : first;
      const descriptor = opcode(code);
      if (descriptor === undefined) {
        issue = `Unsupported CIL opcode 0x${code.toString(16)} at IL offset ${String(start)}`;
        break;
      }
      const operand = readOperand(il, offset, descriptor.operand);
      if (operand.next < offset || operand.next > il.length) {
        issue = `Instruction ${descriptor.name} at IL offset ${String(start)} leaves method body`;
        break;
      }
      offset = operand.next;
      parsed.push({
        offset: start,
        opcode: descriptor.name,
        operandKind: operand.anchorKind,
        operand: operand.value,
      });
    }
  } catch (cause: unknown) {
    issue =
      cause instanceof Error ? cause.message : "Instruction decode failed";
  }
  const truncated = offset < il.length && issue === null ? 1 : 0;
  return { parsed, count: parsed.length, truncated, issue };
};

const parseExceptionRegions = (
  bytes: Buffer,
  offset: number,
  methodEnd: number,
): ManagedExceptionRegion[] => {
  if (offset >= methodEnd) return [];
  const kind = bytes.readUInt8(offset);
  if ((kind & 0x3f) !== 1) return [];
  const fat = (kind & 0x40) !== 0;
  const size = fat
    ? bytes.readUInt32LE(offset) >>> 8
    : bytes.readUInt8(offset + 1);
  const start = fat ? offset + 4 : offset + 4;
  const clauseSize = fat ? 24 : 12;
  if (size < 4 || offset > methodEnd - size) return [];
  const count = Math.floor((size - 4) / clauseSize);
  const regions: ManagedExceptionRegion[] = [];
  for (let index = 0; index < count; index += 1) {
    const clause = start + index * clauseSize;
    if (fat) {
      const flags = bytes.readUInt32LE(clause);
      const extra = bytes.readUInt32LE(clause + 20);
      regions.push({
        flags,
        try_offset: bytes.readUInt32LE(clause + 4),
        try_length: bytes.readUInt32LE(clause + 8),
        handler_offset: bytes.readUInt32LE(clause + 12),
        handler_length: bytes.readUInt32LE(clause + 16),
        class_token:
          flags === 0 ? `0x${extra.toString(16).padStart(8, "0")}` : null,
        filter_offset: flags === 1 ? extra : null,
      });
    } else {
      const flags = bytes.readUInt16LE(clause);
      const extra = bytes.readUInt32LE(clause + 8);
      regions.push({
        flags,
        try_offset: bytes.readUInt16LE(clause + 2),
        try_length: bytes.readUInt8(clause + 4),
        handler_offset: bytes.readUInt16LE(clause + 5),
        handler_length: bytes.readUInt8(clause + 7),
        class_token:
          flags === 0 ? `0x${extra.toString(16).padStart(8, "0")}` : null,
        filter_offset: flags === 1 ? extra : null,
      });
    }
  }
  return regions;
};

interface MethodBodyHeader {
  readonly format: "tiny" | "fat";
  readonly size: number;
  readonly flags: number;
  readonly maxStack: number;
  readonly ilSize: number;
  readonly localSig: number;
}

const readMethodBodyHeader = (
  bytes: Buffer,
  offset: number,
): MethodBodyHeader => {
  const first = bytes.readUInt8(offset);
  if ((first & 3) === 2)
    return {
      format: "tiny",
      size: 1,
      flags: 0,
      maxStack: 8,
      ilSize: first >> 2,
      localSig: 0,
    };
  if ((first & 3) !== 3) throw new RangeError("Unsupported method body header");
  if (offset > bytes.length - 12)
    throw new RangeError("Fat method body header leaves artifact");
  const flagsAndSize = bytes.readUInt16LE(offset);
  const headerDwords = flagsAndSize >>> 12;
  if (headerDwords < 3)
    throw new RangeError("Fat method body header is smaller than 12 bytes");
  const size = headerDwords * 4;
  if (offset > bytes.length - size)
    throw new RangeError("Method body header leaves artifact");
  return {
    format: "fat",
    size,
    flags: flagsAndSize & 0x0fff,
    maxStack: bytes.readUInt16LE(offset + 2),
    ilSize: bytes.readUInt32LE(offset + 4),
    localSig: bytes.readUInt32LE(offset + 8),
  };
};

const methodBody = (
  bytes: Buffer,
  pe: ManagedPeLayout,
  rva: number,
  limits: ManagedMemberInspectionLimits,
): ManagedMethodBody => {
  if (rva === 0)
    return {
      status: "absent",
      header_format: "none",
      rva,
      file_offset: null,
      max_stack: null,
      init_locals: null,
      local_var_sig_token: null,
      il_size: 0,
      il_sha256: null,
      normalized_il_sha256: null,
      instruction_count: 0,
      decoded_instruction_count: 0,
      truncated_instructions: 0,
      opcode_counts: {},
      anchors: [],
      exception_regions: [],
      issue: null,
    };
  try {
    const offset = pe.rvaToOffset(rva, 1, "method.body");
    const header = readMethodBodyHeader(bytes, offset);
    if (header.ilSize > limits.maxMethodBodyBytes)
      return {
        status: "too-large",
        header_format: header.format,
        rva,
        file_offset: offset,
        max_stack: header.maxStack,
        init_locals: (header.flags & 0x10) !== 0,
        local_var_sig_token:
          header.localSig === 0
            ? null
            : `0x${header.localSig.toString(16).padStart(8, "0")}`,
        il_size: header.ilSize,
        il_sha256: null,
        normalized_il_sha256: null,
        instruction_count: 0,
        decoded_instruction_count: 0,
        truncated_instructions: 0,
        opcode_counts: {},
        anchors: [],
        exception_regions: [],
        issue: `Method body exceeds max_method_body_bytes ${String(limits.maxMethodBodyBytes)}`,
      };
    const ilOffset = offset + header.size;
    if (ilOffset > bytes.length - header.ilSize)
      throw new RangeError("Method IL bytes leave artifact");
    const il = bytes.subarray(ilOffset, ilOffset + header.ilSize);
    const decoded = decodeInstructions(il, limits.maxMethodInstructions);
    const opcodeCounts: Record<string, number> = {};
    for (const instruction of decoded.parsed)
      opcodeCounts[instruction.opcode] =
        (opcodeCounts[instruction.opcode] ?? 0) + 1;
    const anchors = decoded.parsed
      .map((instruction, index) => ({ instruction, index }))
      .filter(({ instruction }) => instruction.operandKind !== "none")
      .slice(0, limits.instructionAnchorLimit)
      .map(({ instruction }) => ({
        il_offset: instruction.offset,
        opcode: instruction.opcode,
        operand_kind: instruction.operandKind,
        operand: instruction.operand,
      }));
    const normalized = Buffer.from(
      JSON.stringify(
        decoded.parsed.map(({ opcode, operandKind, operand }) => [
          opcode,
          operandKind,
          operand,
        ]),
      ),
      "utf8",
    );
    const methodEnd = ilOffset + header.ilSize;
    const sectionOffset = (methodEnd + 3) & ~3;
    return {
      status: decoded.issue === null ? "present" : "malformed",
      header_format: header.format,
      rva,
      file_offset: offset,
      max_stack: header.maxStack,
      init_locals: (header.flags & 0x10) !== 0,
      local_var_sig_token:
        header.localSig === 0
          ? null
          : `0x${header.localSig.toString(16).padStart(8, "0")}`,
      il_size: header.ilSize,
      il_sha256: sha256Bytes(il),
      normalized_il_sha256: sha256Bytes(normalized),
      instruction_count: decoded.count,
      decoded_instruction_count: decoded.parsed.length,
      truncated_instructions: decoded.truncated,
      opcode_counts: opcodeCounts,
      anchors,
      exception_regions:
        header.format === "fat" && (header.flags & 8) !== 0
          ? parseExceptionRegions(bytes, sectionOffset, bytes.length)
          : [],
      issue: decoded.issue,
    };
  } catch (cause: unknown) {
    return {
      status: "malformed",
      header_format: "unknown",
      rva,
      file_offset: null,
      max_stack: null,
      init_locals: null,
      local_var_sig_token: null,
      il_size: 0,
      il_sha256: null,
      normalized_il_sha256: null,
      instruction_count: 0,
      decoded_instruction_count: 0,
      truncated_instructions: 0,
      opcode_counts: {},
      anchors: [],
      exception_regions: [],
      issue:
        cause instanceof Error ? cause.message : "Method body parse failed",
    };
  }
};

const parseFields = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  ranges: readonly TypeRange[],
  maxBytes: number,
): {
  readonly fields: readonly ManagedField[];
  readonly core: ReadonlyMap<string, FieldCore>;
} => {
  const fields: ManagedField[] = [];
  const core = new Map<string, FieldCore>();
  const table = layout.table(4);
  for (let row = 1; row <= (table?.rowCount ?? 0); row += 1) {
    const cursor = rowCursor(bytes, layout, 4, row);
    const flags = cursor.readUInt16();
    const name = readMetadataString(
      bytes,
      layout,
      cursor.readIndex(layout.stringIndexSize),
      maxBytes,
    );
    const sig = readMetadataBlob(
      bytes,
      layout,
      cursor.readIndex(layout.blobIndexSize),
      maxBytes,
    );
    const declared = declaringType(ranges, "field", row);
    const token = metadataToken(4, row);
    fields.push({
      token,
      row_offset: cursor.start,
      declaring_type_token: declared?.token ?? null,
      declaring_type: declared?.fullName ?? null,
      name,
      flags,
      signature: signature(sig),
    });
    core.set(token, { token, name });
  }
  return { fields, core };
};

const parseMemberRefs = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  maxBytes: number,
): {
  readonly refs: readonly ManagedMemberRef[];
  readonly core: ReadonlyMap<string, MemberRefCore>;
} => {
  const refs: ManagedMemberRef[] = [];
  const core = new Map<string, MemberRefCore>();
  const table = layout.table(10);
  for (let row = 1; row <= (table?.rowCount ?? 0); row += 1) {
    const cursor = rowCursor(bytes, layout, 10, row);
    const parentRaw = cursor.readIndex(
      layout.codedIndexSize("MemberRefParent"),
    );
    const name = readMetadataString(
      bytes,
      layout,
      cursor.readIndex(layout.stringIndexSize),
      maxBytes,
    );
    const sig = readMetadataBlob(
      bytes,
      layout,
      cursor.readIndex(layout.blobIndexSize),
      maxBytes,
    );
    const token = metadataToken(10, row);
    refs.push({
      token,
      row_offset: cursor.start,
      parent_token: codedToken(parentRaw, 3, [2, 1, 26, 6, 27]),
      name,
      signature: signature(sig),
    });
    core.set(token, { token, name });
  }
  return { refs, core };
};

const parseMethods = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  pe: ManagedPeLayout,
  ranges: readonly TypeRange[],
  maxBytes: number,
  limits: ManagedMemberInspectionLimits,
): {
  readonly methods: readonly ManagedMethod[];
  readonly core: ReadonlyMap<string, MethodCore>;
} => {
  const methods: ManagedMethod[] = [];
  const core = new Map<string, MethodCore>();
  const table = layout.table(6);
  for (let row = 1; row <= (table?.rowCount ?? 0); row += 1) {
    const cursor = rowCursor(bytes, layout, 6, row);
    const rva = cursor.readUInt32();
    const implFlags = cursor.readUInt16();
    const flags = cursor.readUInt16();
    const name = readMetadataString(
      bytes,
      layout,
      cursor.readIndex(layout.stringIndexSize),
      maxBytes,
    );
    const sig = readMetadataBlob(
      bytes,
      layout,
      cursor.readIndex(layout.blobIndexSize),
      maxBytes,
    );
    cursor.readIndex(layout.tableIndexSize(8));
    const declared = declaringType(ranges, "method", row);
    const token = metadataToken(6, row);
    methods.push({
      token,
      row_offset: cursor.start,
      declaring_type_token: declared?.token ?? null,
      declaring_type: declared?.fullName ?? null,
      name,
      rva,
      impl_flags: implFlags,
      flags,
      signature: signature(sig),
      body: methodBody(bytes, pe, rva, limits),
    });
    core.set(token, { token, name, declaringType: declared?.fullName ?? null });
  }
  return { methods, core };
};

const targetKind = (token: string): ManagedCallEdge["target_kind"] =>
  token.startsWith("0x06")
    ? "method-def"
    : token.startsWith("0x0a")
      ? "member-ref"
      : token.startsWith("0x2b")
        ? "method-spec"
        : "unknown";

const edges = (
  methods: readonly ManagedMethod[],
  methodCore: ReadonlyMap<string, MethodCore>,
  fieldCore: ReadonlyMap<string, FieldCore>,
  refCore: ReadonlyMap<string, MemberRefCore>,
): {
  readonly callEdges: readonly ManagedCallEdge[];
  readonly fieldAccesses: readonly ManagedFieldAccess[];
} => {
  const callEdges: ManagedCallEdge[] = [];
  const fieldAccesses: ManagedFieldAccess[] = [];
  for (const method of methods) {
    for (const anchor of method.body.anchors) {
      if (anchor.operand_kind === "method" && anchor.operand !== null) {
        const named =
          methodCore.get(anchor.operand)?.name ??
          refCore.get(anchor.operand)?.name ??
          null;
        callEdges.push({
          caller_token: method.token,
          caller:
            method.declaring_type === null
              ? method.name
              : `${method.declaring_type}.${method.name}`,
          opcode: anchor.opcode,
          target_token: anchor.operand,
          target_kind: targetKind(anchor.operand),
          target_name: named,
        });
      }
      if (anchor.operand_kind === "field" && anchor.operand !== null) {
        fieldAccesses.push({
          method_token: method.token,
          method:
            method.declaring_type === null
              ? method.name
              : `${method.declaring_type}.${method.name}`,
          opcode: anchor.opcode,
          field_token: anchor.operand,
          field_name: fieldCore.get(anchor.operand)?.name ?? null,
        });
      }
    }
  }
  return { callEdges, fieldAccesses };
};

const unavailable = (
  target: BinaryTarget,
  bytes: Buffer,
  limits: ManagedMemberInspectionLimits,
  issue: ManagedParseIssue | null,
): ManagedMemberInspection =>
  managedMemberInspectionSchema.parse({
    schema_version: 1,
    artifact: {
      path: target.path,
      sha256: target.sha256,
      byte_length: bytes.length,
      format: "pe",
    },
    module: null,
    metadata: {
      status: issue === null ? "absent" : "malformed",
      version: null,
      table_row_counts: {},
    },
    identity_scope: {
      token_identity: "build-local",
      requires_artifact_sha256: target.sha256,
      requires_mvid: null,
    },
    types: emptyPage(limits.typeOffset, limits.typeLimit),
    fields: emptyPage(limits.fieldOffset, limits.fieldLimit),
    methods: emptyPage(limits.methodOffset, limits.methodLimit),
    member_refs: emptyPage(limits.memberRefOffset, limits.memberRefLimit),
    call_edges: emptyPage(limits.edgeOffset, limits.edgeLimit),
    field_accesses: emptyPage(limits.edgeOffset, limits.edgeLimit),
    coverage: {
      state: "unavailable",
      issues: issue === null ? [] : [issue],
    },
    limitations: [
      issue === null
        ? "The PE has no admitted CLI metadata; managed member inspection is unavailable."
        : "The CLI metadata could not be admitted; managed member inspection is unavailable.",
    ],
  });

const resourceDirectory = (
  pe: ManagedPeLayout,
): ManagedResourceDirectory | null => {
  if (
    pe.cli === null ||
    pe.cli.resources.rva === 0 ||
    pe.cli.resources.size === 0
  )
    return null;
  return {
    offset: pe.rvaToOffset(
      pe.cli.resources.rva,
      pe.cli.resources.size,
      "cli.resources",
    ),
    size: pe.cli.resources.size,
  };
};

/** Inspect metadata members and method bodies without loading target code. */
export const inspectManagedMembersBytes = (
  bytes: Buffer,
  target: BinaryTarget,
  limits: ManagedMemberInspectionLimits,
): ManagedMemberInspection => {
  const pe = readManagedPeLayout(bytes);
  if (pe.cli === null) return unavailable(target, bytes, limits, pe.cliIssue);
  const issues: ManagedParseIssue[] = [];
  try {
    const rootOffset = pe.rvaToOffset(
      pe.cli.metadata.rva,
      pe.cli.metadata.size,
      "cli.metadata",
    );
    if (pe.cli.metadata.size > limits.maxMetadataBytes)
      throw managedFailure(
        "limit-exceeded",
        "metadata.root",
        `CLI metadata size exceeds max_metadata_bytes ${String(limits.maxMetadataBytes)}`,
        rootOffset,
      );
    const layout = readManagedMetadataLayout(
      bytes,
      rootOffset,
      pe.cli.metadata.size,
      limits.maxTableRows,
    );
    const inventory = readManagedMetadataInventory(
      bytes,
      layout,
      {
        referenceOffset: 0,
        referenceLimit: 1,
        resourceOffset: 0,
        resourceLimit: 1,
        attributeOffset: 0,
        attributeLimit: 1,
        maxHeapItemBytes: limits.maxHeapItemBytes,
      },
      resourceDirectory(pe),
    );
    issues.push(...inventory.issues);
    const ranges = typeRanges(bytes, layout, limits.maxHeapItemBytes);
    const types = parseTypes(bytes, layout, ranges, limits.maxHeapItemBytes);
    const fields = parseFields(bytes, layout, ranges, limits.maxHeapItemBytes);
    const memberRefs = parseMemberRefs(bytes, layout, limits.maxHeapItemBytes);
    const methods = parseMethods(
      bytes,
      layout,
      pe,
      ranges,
      limits.maxHeapItemBytes,
      limits,
    );
    const related = edges(
      methods.methods,
      methods.core,
      fields.core,
      memberRefs.core,
    );
    return managedMemberInspectionSchema.parse({
      schema_version: 1,
      artifact: {
        path: target.path,
        sha256: target.sha256,
        byte_length: bytes.length,
        format: "pe",
      },
      module: inventory.module,
      metadata: {
        status: issues.length === 0 ? "complete" : "partial",
        version: layout.version,
        table_row_counts: managedTableRowCounts(layout),
      },
      identity_scope: {
        token_identity: "build-local",
        requires_artifact_sha256: target.sha256,
        requires_mvid: inventory.module?.mvid ?? null,
      },
      types: page(types, limits.typeOffset, limits.typeLimit),
      fields: page(fields.fields, limits.fieldOffset, limits.fieldLimit),
      methods: page(methods.methods, limits.methodOffset, limits.methodLimit),
      member_refs: page(
        memberRefs.refs,
        limits.memberRefOffset,
        limits.memberRefLimit,
      ),
      call_edges: page(related.callEdges, limits.edgeOffset, limits.edgeLimit),
      field_accesses: page(
        related.fieldAccesses,
        limits.edgeOffset,
        limits.edgeLimit,
      ),
      coverage: {
        state: issues.length === 0 ? "complete" : "partial",
        issues,
      },
      limitations: [
        "Metadata tokens are build-local coordinates and are only meaningful with the reported artifact SHA-256 and MVID.",
        "CIL instruction anchors are decoded from file-backed method bodies only; no target assembly is loaded or executed.",
        "Signatures are decoded for common ECMA-335 primitive, class, valuetype, pointer, byref, array, and generic variable forms; unsupported forms retain raw signature hashes.",
      ],
    });
  } catch (cause: unknown) {
    if (cause instanceof ManagedReaderFailure)
      return unavailable(target, bytes, limits, cause.issue);
    throw cause;
  }
};
