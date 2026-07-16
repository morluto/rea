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

const readTypeSignature = (
  blob: Buffer,
  offset: number,
): { readonly value: string; readonly next: number } => {
  const kind = blob[offset];
  if (kind === undefined) throw new RangeError("truncated type signature");
  const named = ELEMENT_TYPES.get(kind);
  if (named !== undefined) return { value: named, next: offset + 1 };
  if (kind === 0x0f) {
    const inner = readTypeSignature(blob, offset + 1);
    return { value: `${inner.value}&`, next: inner.next };
  }
  if (kind === 0x10) {
    const inner = readTypeSignature(blob, offset + 1);
    return { value: `${inner.value}*`, next: inner.next };
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
  [0x11, { name: "ldloc.s", operand: "short-var" }],
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
  [0x25, { name: "dup", operand: "none" }],
  [0x26, { name: "pop", operand: "none" }],
  [0x28, { name: "call", operand: "method" }],
  [0x2a, { name: "ret", operand: "none" }],
  [0x2b, { name: "br.s", operand: "short-branch" }],
  [0x2c, { name: "brfalse.s", operand: "short-branch" }],
  [0x2d, { name: "brtrue.s", operand: "short-branch" }],
  [0x38, { name: "br", operand: "branch" }],
  [0x39, { name: "brfalse", operand: "branch" }],
  [0x3a, { name: "brtrue", operand: "branch" }],
  [0x45, { name: "switch", operand: "switch" }],
  [0x58, { name: "add", operand: "none" }],
  [0x59, { name: "sub", operand: "none" }],
  [0x5a, { name: "mul", operand: "none" }],
  [0x5b, { name: "div", operand: "none" }],
  [0x6f, { name: "callvirt", operand: "method" }],
  [0x70, { name: "cpobj", operand: "type" }],
  [0x72, { name: "ldstr", operand: "string" }],
  [0x73, { name: "newobj", operand: "method" }],
  [0x74, { name: "castclass", operand: "type" }],
  [0x75, { name: "isinst", operand: "type" }],
  [0x7b, { name: "ldfld", operand: "field" }],
  [0x7c, { name: "ldflda", operand: "field" }],
  [0x7d, { name: "stfld", operand: "field" }],
  [0x7e, { name: "ldsfld", operand: "field" }],
  [0x7f, { name: "ldsflda", operand: "field" }],
  [0x80, { name: "stsfld", operand: "field" }],
  [0x8c, { name: "box", operand: "type" }],
  [0x8d, { name: "newarr", operand: "type" }],
  [0xa5, { name: "unbox.any", operand: "type" }],
  [0xd0, { name: "ldtoken", operand: "token" }],
  [0xdd, { name: "leave", operand: "branch" }],
  [0xde, { name: "leave.s", operand: "short-branch" }],
  [0xfe09, { name: "ldarg", operand: "var" }],
  [0xfe0a, { name: "ldarga", operand: "var" }],
  [0xfe0c, { name: "ldloc", operand: "var" }],
  [0xfe0e, { name: "stloc", operand: "var" }],
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

const readOperand = (
  il: Buffer,
  offset: number,
  kind: string,
): {
  readonly next: number;
  readonly anchorKind: ManagedInstructionAnchor["operand_kind"];
  readonly value: string | null;
} => {
  switch (kind) {
    case "none":
      return { next: offset, anchorKind: "none", value: null };
    case "short-var":
      return {
        next: offset + 1,
        anchorKind: "variable",
        value: String(il.readUInt8(offset)),
      };
    case "var":
      return {
        next: offset + 2,
        anchorKind: "variable",
        value: String(il.readUInt16LE(offset)),
      };
    case "short-i":
      return {
        next: offset + 1,
        anchorKind: "constant",
        value: String(il.readInt8(offset)),
      };
    case "i":
      return {
        next: offset + 4,
        anchorKind: "constant",
        value: String(il.readInt32LE(offset)),
      };
    case "short-branch":
      return {
        next: offset + 1,
        anchorKind: "branch",
        value: String(offset + 1 + il.readInt8(offset)),
      };
    case "branch":
      return {
        next: offset + 4,
        anchorKind: "branch",
        value: String(offset + 4 + il.readInt32LE(offset)),
      };
    case "switch": {
      const count = il.readUInt32LE(offset);
      return {
        next: offset + 4 + count * 4,
        anchorKind: "switch",
        value: String(count),
      };
    }
    case "method":
    case "field":
    case "type":
    case "string":
    case "token": {
      const raw = il.readUInt32LE(offset);
      const token = `0x${raw.toString(16).padStart(8, "0")}`;
      return {
        next: offset + 4,
        anchorKind: kind === "token" ? tokenKind(token) : kind,
        value: token,
      };
    }
    default:
      return { next: offset, anchorKind: "unknown", value: null };
  }
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
      const descriptor = opcode(code) ?? {
        name: `unknown.0x${code.toString(16)}`,
        operand: "none",
      };
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
    const first = bytes.readUInt8(offset);
    const tiny = (first & 3) === 2;
    const fat = (first & 3) === 3;
    if (!tiny && !fat) throw new RangeError("Unsupported method body header");
    const headerSize = tiny ? 1 : (first >> 4) * 4;
    const flags = tiny ? 0 : bytes.readUInt16LE(offset);
    const maxStack = tiny ? 8 : bytes.readUInt16LE(offset + 2);
    const ilSize = tiny ? first >> 2 : bytes.readUInt32LE(offset + 4);
    const localSig = tiny ? 0 : bytes.readUInt32LE(offset + 8);
    if (ilSize > limits.maxMethodBodyBytes)
      return {
        status: "too-large",
        header_format: tiny ? "tiny" : "fat",
        rva,
        file_offset: offset,
        max_stack: maxStack,
        init_locals: tiny ? false : (flags & 0x10) !== 0,
        local_var_sig_token:
          localSig === 0 ? null : `0x${localSig.toString(16).padStart(8, "0")}`,
        il_size: ilSize,
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
    const ilOffset = offset + headerSize;
    if (ilOffset > bytes.length - ilSize)
      throw new RangeError("Method IL bytes leave artifact");
    const il = bytes.subarray(ilOffset, ilOffset + ilSize);
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
    const methodEnd = ilOffset + ilSize;
    const sectionOffset = (methodEnd + 3) & ~3;
    return {
      status: decoded.issue === null ? "present" : "malformed",
      header_format: tiny ? "tiny" : "fat",
      rva,
      file_offset: offset,
      max_stack: maxStack,
      init_locals: tiny ? false : (flags & 0x10) !== 0,
      local_var_sig_token:
        localSig === 0 ? null : `0x${localSig.toString(16).padStart(8, "0")}`,
      il_size: ilSize,
      il_sha256: sha256Bytes(il),
      normalized_il_sha256: sha256Bytes(normalized),
      instruction_count: decoded.count,
      decoded_instruction_count: decoded.parsed.length,
      truncated_instructions: decoded.truncated,
      opcode_counts: opcodeCounts,
      anchors,
      exception_regions:
        fat && (flags & 8) !== 0
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
