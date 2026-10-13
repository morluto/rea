import {
  managedFailure,
  ManagedReaderFailure,
  readManagedValue,
} from "./ManagedReaderFailure.js";
import type {
  ManagedMemberInspection,
  ManagedParseIssue,
} from "../domain/managed/managedArtifact.js";
import { managedDecodeBudget } from "./ManagedDecodeBudget.js";
import type {
  ManagedMetadataLayout,
  MetadataTableLayout,
} from "./ManagedMetadataLayout.js";
import {
  metadataRowCursor,
  metadataCodedToken,
  metadataCodedTokenInvalidReason,
  metadataToken,
  readMetadataString,
  sha256Bytes,
} from "./ManagedMetadataHeaps.js";
import {
  memberListIndexSize,
  memberListTable,
} from "./ManagedMemberPointers.js";

export type ManagedType = ManagedMemberInspection["types"][number];
export type ManagedExportedType = NonNullable<
  ManagedMemberInspection["exported_types"]
>[number];
export type ManagedField = ManagedMemberInspection["fields"][number];
export type ManagedMethod = ManagedMemberInspection["methods"][number];
export type ManagedMemberRef = ManagedMemberInspection["member_refs"][number];
export type ManagedCallEdge = ManagedMemberInspection["call_edges"][number];
export type ManagedFieldAccess =
  ManagedMemberInspection["field_accesses"][number];
export type ManagedSignature = ManagedMethod["signature"];
export type ManagedMethodBody = ManagedMethod["body"];
export type ManagedInstructionAnchor = ManagedMethodBody["anchors"][number];
export type ManagedExceptionRegion =
  ManagedMethodBody["exception_regions"][number];

export interface TypeRange {
  readonly token: string;
  readonly fullName: string | null;
  readonly fieldStart: number;
  readonly fieldEnd: number;
  readonly methodStart: number;
  readonly methodEnd: number;
}

/**
 * Name and declaring type of a field, method, member reference, or method
 * specification, keyed by its token so edges resolve any target uniformly.
 */
export interface MemberCore {
  readonly token: string;
  readonly name: string;
  readonly declaringType: string | null;
  /** Fields and methods by table; member references by decoded signature. */
  readonly kind: ManagedSignature["kind"];
  /**
   * Generic arity from the owner's decoded signature (see
   * `signatureGenericArity`); absent when no owner decoded it, as for a
   * MethodDef outside the type selection.
   */
  readonly genericArity?: number | null;
}

export interface ParsedInstruction {
  readonly offset: number;
  readonly opcode: string;
  readonly operandKind: ManagedInstructionAnchor["operand_kind"];
  readonly operand: string | null;
}

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

export const fullName = (namespace: string, name: string): string =>
  namespace.length === 0 ? name : `${namespace}.${name}`;

const readTypeRange = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  row: number,
  issues: ManagedParseIssue[],
): TypeRange => {
  const methods = memberListTable(layout, 6);
  const fields = memberListTable(layout, 4);
  const cursor = metadataRowCursor(bytes, layout, 2, row);
  cursor.readUInt32();
  const nameIndex = cursor.readIndex(layout.stringIndexSize);
  const namespaceIndex = cursor.readIndex(layout.stringIndexSize);
  const declaredName =
    readManagedValue(
      () =>
        fullName(
          readMetadataString(
            bytes,
            layout,
            namespaceIndex,
            layout.strings.size,
          ),
          readMetadataString(bytes, layout, nameIndex, layout.strings.size),
        ),
      issues,
    ) ?? null;
  cursor.readIndex(layout.codedIndexSize("TypeDefOrRef"));
  const fieldStart = cursor.readIndex(memberListIndexSize(layout, 4));
  const methodStart = cursor.readIndex(memberListIndexSize(layout, 6));
  let nextField = (fields?.rowCount ?? 0) + 1;
  let nextMethod = (methods?.rowCount ?? 0) + 1;
  const typeTable = layout.table(2);
  if (typeTable !== undefined && row < typeTable.rowCount) {
    const next = metadataRowCursor(bytes, layout, 2, row + 1);
    next.readUInt32();
    next.readIndex(layout.stringIndexSize);
    next.readIndex(layout.stringIndexSize);
    next.readIndex(layout.codedIndexSize("TypeDefOrRef"));
    nextField = next.readIndex(memberListIndexSize(layout, 4));
    nextMethod = next.readIndex(memberListIndexSize(layout, 6));
  }
  return {
    token: metadataToken(2, row),
    fullName: declaredName,
    fieldStart,
    fieldEnd: nextField,
    methodStart,
    methodEnd: nextMethod,
  };
};

export const typeRanges = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  issues: ManagedParseIssue[],
): readonly TypeRange[] => {
  const typeTable = layout.table(2);
  const ranges: TypeRange[] = [];
  for (let row = 1; row <= (typeTable?.rowCount ?? 0); row += 1)
    ranges.push(readTypeRange(bytes, layout, row, issues));
  return ranges;
};

export const parseTypes = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  ranges: readonly TypeRange[],
): {
  readonly types: readonly ManagedType[];
  readonly issues: readonly ManagedParseIssue[];
} => {
  const typeTable = layout.table(2);
  const fields = memberListTable(layout, 4);
  const methods = memberListTable(layout, 6);
  const items: ManagedType[] = [];
  const issues: ManagedParseIssue[] = [];
  for (let row = 1; row <= (typeTable?.rowCount ?? 0); row += 1) {
    readManagedValue(() => {
      const cursor = metadataRowCursor(bytes, layout, 2, row);
      const flags = cursor.readUInt32();
      const name = readMetadataString(
        bytes,
        layout,
        cursor.readIndex(layout.stringIndexSize),
        layout.strings.size,
      );
      const namespace = readMetadataString(
        bytes,
        layout,
        cursor.readIndex(layout.stringIndexSize),
        layout.strings.size,
      );
      const extendsOffset = cursor.offset;
      const extendsRaw = cursor.readIndex(
        layout.codedIndexSize("TypeDefOrRef"),
      );
      const fieldStart = cursor.readIndex(memberListIndexSize(layout, 4));
      const methodStart = cursor.readIndex(memberListIndexSize(layout, 6));
      const nextRange = ranges[row] ?? null;
      const fieldRange = rowRange(
        fields,
        fieldStart,
        nextRange?.fieldStart ?? 0,
      );
      const methodRange = rowRange(
        methods,
        methodStart,
        nextRange?.methodStart ?? 0,
      );
      const extendsReason = metadataCodedTokenInvalidReason(
        extendsRaw,
        2,
        [2, 1, 27],
        layout.rowCounts,
      );
      if (extendsReason !== null)
        issues.push({
          code: "invalid-row",
          scope: `metadata.TypeDef:${metadataToken(2, row)}`,
          offset: extendsOffset,
          detail: `TypeDef Extends coded index 0x${extendsRaw.toString(16)} is invalid: ${extendsReason}`,
        });
      items.push({
        token: metadataToken(2, row),
        row_offset: cursor.start,
        namespace,
        name,
        full_name: fullName(namespace, name),
        flags,
        extends_token: metadataCodedToken(
          extendsRaw,
          2,
          [2, 1, 27],
          layout.rowCounts,
        ),
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
    }, issues);
  }
  return { types: items, issues };
};

export const readCompressed = (
  bytes: Buffer,
  offset: number,
): { readonly value: number; readonly next: number } => {
  const first = bytes[offset];
  if (first === undefined)
    throw managedFailure(
      "invalid-blob",
      "signature",
      "truncated compressed integer",
      offset,
    );
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
  throw managedFailure(
    "invalid-blob",
    "signature",
    "reserved compressed integer",
    offset,
  );
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

const readSignedCompressed = (
  bytes: Buffer,
  offset: number,
): { readonly value: number; readonly next: number } => {
  const encoded = readCompressed(bytes, offset);
  const width =
    encoded.next - offset === 1 ? 7 : encoded.next - offset === 2 ? 14 : 29;
  const magnitude = Math.floor(encoded.value / 2);
  return {
    value: encoded.value % 2 === 0 ? magnitude : magnitude - 2 ** (width - 1),
    next: encoded.next,
  };
};

const malformedSignature = (detail: string, offset: number): never => {
  throw managedFailure("invalid-blob", "signature", detail, offset);
};

// Pending work while decoding one Type. Signatures nest arbitrarily deep, so
// decoding keeps an explicit stack instead of recursing.
type TypeContinuation =
  | { readonly kind: "suffix"; readonly suffix: "*" | "&" | "[]" }
  | { readonly kind: "modifiers"; readonly modifiers: string[] }
  | { readonly kind: "array" }
  | {
      readonly kind: "list";
      remaining: number;
      readonly items: string[];
      // Function pointer items are a RetType then Params; generic
      // arguments are Types.
      readonly signatureItems: boolean;
      readonly render: (items: readonly string[]) => string;
    };

interface MethodSignatureHeader {
  readonly first: number;
  readonly genericParameterCount: number | null;
  readonly parameterCount: number;
  readonly next: number;
}

// MethodDefSig and MethodRefSig headers (ECMA-335 II.23.2.1-2) without
// HASTHIS and EXPLICITTHIS: DEFAULT, VARARG, or GENERIC, which implies DEFAULT.
const MEMBER_METHOD_HEADERS = new Set([0x00, 0x05, 0x10]);

// FNPTR also carries the unmanaged C, STDCALL, THISCALL, FASTCALL, and
// UNMANAGED conventions that compilers emit for unmanaged function pointers.
const FUNCTION_POINTER_CONVENTIONS = new Set([0, 1, 2, 3, 4, 5, 9]);

/**
 * Read a method signature's calling convention and counts. A header that is
 * not a method signature in its context (a MethodDef or MemberRef row, or an
 * FNPTR type), sets the reserved bit, or sets EXPLICITTHIS without HASTHIS is
 * malformed, so no caller consumes its counts. FIELD, LOCAL_SIG, PROPERTY,
 * and GENERICINST headers are never method signatures.
 */
const readMethodSignatureHeader = (
  blob: Buffer,
  offset: number,
  context: "member" | "function-pointer",
): MethodSignatureHeader => {
  const first = blob[offset];
  if (first === undefined)
    return malformedSignature("truncated method signature", offset);
  const allowed =
    context === "member"
      ? MEMBER_METHOD_HEADERS.has(first & 0x9f)
      : (first & 0x80) === 0 && FUNCTION_POINTER_CONVENTIONS.has(first & 0x0f);
  if (!allowed || ((first & 0x40) !== 0 && (first & 0x20) === 0))
    return malformedSignature(
      `calling convention 0x${first.toString(16)} does not head a ${context} method signature`,
      offset,
    );
  let next = offset + 1;
  let genericParameterCount: number | null = null;
  if ((first & 0x10) !== 0) {
    const generic = readCompressed(blob, next);
    genericParameterCount = generic.value;
    next = generic.next;
  }
  const parameterCount = readCompressed(blob, next);
  return {
    first,
    genericParameterCount,
    parameterCount: parameterCount.value,
    next: parameterCount.next,
  };
};

const MAX_ARRAY_RANK = 32;

const arrayShape = (
  blob: Buffer,
  offset: number,
): { readonly value: string; readonly next: number } => {
  const rank = readCompressed(blob, offset);
  if (rank.value === 0) return malformedSignature("array rank is zero", offset);
  // ECMA-335 leaves rank unbounded, but the CLR loads at most 32 dimensions;
  // larger ranks would expand a few bytes into an unbounded rendering.
  if (rank.value > MAX_ARRAY_RANK)
    throw managedFailure(
      "unsupported-signature",
      "signature",
      `array rank ${String(rank.value)} exceeds the ${String(MAX_ARRAY_RANK)} dimensions the CLR supports`,
      offset,
    );
  const sizeCount = readCompressed(blob, rank.next);
  if (sizeCount.value > rank.value)
    return malformedSignature("array has more sizes than dimensions", offset);
  const sizes: number[] = [];
  let next = sizeCount.next;
  for (let index = 0; index < sizeCount.value; index += 1) {
    const size = readCompressed(blob, next);
    sizes.push(size.value);
    next = size.next;
  }
  const boundCount = readCompressed(blob, next);
  if (boundCount.value > rank.value)
    return malformedSignature(
      "array has more lower bounds than dimensions",
      offset,
    );
  const lowerBounds: number[] = [];
  next = boundCount.next;
  for (let index = 0; index < boundCount.value; index += 1) {
    const bound = readSignedCompressed(blob, next);
    lowerBounds.push(bound.value);
    next = bound.next;
  }
  const dimensions = Array.from({ length: rank.value }, (_, index) => {
    const size = sizes[index];
    const lower = lowerBounds[index];
    if (lower !== undefined)
      return size === undefined
        ? `${String(lower)}...`
        : `${String(lower)}...${String(lower + size - 1)}`;
    if (size !== undefined) return String(size);
    // ILAsm spelling: a bare rank-1 `[]` is reserved for SZARRAY.
    return rank.value === 1 ? "..." : "";
  });
  return { value: `[${dimensions.join(",")}]`, next };
};

/** Grammar position of the element being decoded (ECMA-335 II.23.2). */
type SignaturePosition = "field" | "return" | "parameter" | "type" | "pointee";

// Custom modifiers do not change the position they precede.
const currentPosition = (
  stack: readonly TypeContinuation[],
  base: SignaturePosition,
): SignaturePosition => {
  const frame = stack.findLast(({ kind }) => kind !== "modifiers");
  if (frame === undefined) return base;
  if (frame.kind === "suffix") return frame.suffix === "*" ? "pointee" : "type";
  if (frame.kind === "list" && frame.signatureItems)
    return frame.items.length === 0 ? "return" : "parameter";
  return "type";
};

// VOID is a RetType or a pointee; TYPEDBYREF is a RetType or Param; BYREF
// prefixes a RetType, Param, or (since ref fields) a field type.
const POSITION_ELEMENTS: ReadonlyMap<number, readonly SignaturePosition[]> =
  new Map([
    [0x01, ["return", "pointee"]],
    [0x16, ["return", "parameter"]],
    [0x10, ["return", "parameter", "field"]],
  ]);

/** Decode a type operand once; spec callers also validate its metadata coordinate. */
const readTypeOperand = (
  blob: Buffer,
  offset: number,
  layout?: ManagedMetadataLayout,
  tables: readonly number[] = [2, 1, 27],
): ReturnType<typeof readCompressed> => {
  const token = readCompressed(blob, offset);
  if (layout !== undefined) {
    const reason =
      token.value === 0
        ? "type operand is null"
        : metadataCodedTokenInvalidReason(
            token.value,
            2,
            tables,
            layout.rowCounts,
          );
    if (reason !== null)
      throw managedFailure(
        "invalid-row",
        "signature",
        `TypeDefOrRefOrSpec operand 0x${token.value.toString(16)} is invalid: ${reason}`,
        offset,
      );
  }
  return token;
};

const readTypeSignature = (
  blob: Buffer,
  offset: number,
  base: SignaturePosition,
  layout?: ManagedMetadataLayout,
): { readonly value: string; readonly next: number } => {
  const stack: TypeContinuation[] = [];
  let cursor = offset;
  for (;;) {
    let value: string | undefined;
    const kind = blob[cursor];
    if (kind === undefined)
      return malformedSignature("truncated type signature", cursor);
    const positions = POSITION_ELEMENTS.get(kind);
    if (
      positions !== undefined &&
      !positions.includes(currentPosition(stack, base))
    )
      return malformedSignature(
        `element type 0x${kind.toString(16)} is not valid in a ${currentPosition(stack, base)} position`,
        cursor,
      );
    const named = ELEMENT_TYPES.get(kind);
    if (named !== undefined) {
      value = named;
      cursor += 1;
    } else if (kind === 0x0f || kind === 0x10 || kind === 0x1d) {
      const suffix = kind === 0x0f ? "*" : kind === 0x10 ? "&" : "[]";
      stack.push({ kind: "suffix", suffix });
      cursor += 1;
    } else if (kind === 0x1f || kind === 0x20) {
      const token = readTypeOperand(blob, cursor + 1, layout);
      const modifier = `${kind === 0x1f ? "modreq" : "modopt"}:${String(token.value)}`;
      // A modifier frame on top was pushed by the directly preceding byte;
      // keep an adjacent run together and in source order.
      const top = stack.at(-1);
      if (top?.kind === "modifiers") top.modifiers.push(modifier);
      else stack.push({ kind: "modifiers", modifiers: [modifier] });
      cursor = token.next;
    } else if (kind === 0x11 || kind === 0x12) {
      const token = readTypeOperand(blob, cursor + 1, layout);
      value = `${kind === 0x11 ? "valuetype" : "class"}:${String(token.value)}`;
      cursor = token.next;
    } else if (kind === 0x1e || kind === 0x13) {
      const variable = readCompressed(blob, cursor + 1);
      value = `${kind === 0x1e ? "mvar" : "var"}:${String(variable.value)}`;
      cursor = variable.next;
    } else if (kind === 0x16) {
      value = "typedbyref";
      cursor += 1;
    } else if (kind === 0x14) {
      stack.push({ kind: "array" });
      cursor += 1;
    } else if (kind === 0x15) {
      const generic = blob[cursor + 1];
      if (generic !== 0x11 && generic !== 0x12)
        return malformedSignature(
          "generic instantiation does not name a class or value type",
          cursor + 1,
        );
      const token = readTypeOperand(blob, cursor + 2, layout, [2, 1]);
      const argumentCount = readCompressed(blob, token.next);
      if (argumentCount.value === 0)
        return malformedSignature(
          "generic instantiation has no type arguments",
          token.next,
        );
      const head = `${generic === 0x11 ? "valuetype" : "class"}:${String(token.value)}`;
      stack.push({
        kind: "list",
        remaining: argumentCount.value,
        items: [],
        signatureItems: false,
        render: (items) => `${head}<${items.join(",")}>`,
      });
      cursor = argumentCount.next;
    } else if (kind === 0x1b) {
      const header = readMethodSignatureHeader(
        blob,
        cursor + 1,
        "function-pointer",
      );
      const convention = callingConvention(header.first);
      const head =
        header.genericParameterCount === null
          ? convention
          : `${convention};${String(header.genericParameterCount)}`;
      stack.push({
        kind: "list",
        remaining: header.parameterCount + 1,
        items: [],
        signatureItems: true,
        render: ([returnType, ...parameters]) =>
          `fnptr[${head}](${parameters.join(",")})->${returnType ?? ""}`,
      });
      cursor = header.next;
    } else {
      throw managedFailure(
        "unsupported-signature",
        "signature",
        `unsupported element type 0x${kind.toString(16)}`,
        cursor,
      );
    }
    while (value !== undefined) {
      const top = stack.pop();
      if (top === undefined) return { value, next: cursor };
      if (top.kind === "suffix") value += top.suffix;
      else if (top.kind === "modifiers")
        value = `${value} ${top.modifiers.join(" ")}`;
      else if (top.kind === "array") {
        const shape = arrayShape(blob, cursor);
        value += shape.value;
        cursor = shape.next;
      } else {
        top.items.push(value);
        top.remaining -= 1;
        if (top.remaining === 0) value = top.render(top.items);
        else {
          value = undefined;
          stack.push(top);
        }
      }
    }
  }
};

const CALLING_CONVENTION_NAMES = new Map([
  [0, "default"],
  [1, "c"],
  [2, "stdcall"],
  [3, "thiscall"],
  [4, "fastcall"],
  [5, "vararg"],
  [6, "field"],
  [9, "unmanaged"],
]);

const callingConvention = (value: number): string => {
  const base = value & 0x0f;
  const flags = [
    (value & 0x20) === 0 ? null : "has-this",
    (value & 0x40) === 0 ? null : "explicit-this",
    (value & 0x10) === 0 ? null : "generic",
  ].filter((flag) => flag !== null);
  const name = CALLING_CONVENTION_NAMES.get(base) ?? `unknown:${String(base)}`;
  return flags.length === 0 ? name : `${name} ${flags.join(" ")}`;
};

/**
 * Decode a whole TypeSpec blob, or a MethodSpec instantiation (GENERICINST,
 * argument count, Types), with the member-signature grammar and return the
 * rendered types. A malformed or unsupported blob throws invalid-blob or
 * unsupported-signature under the owning row, so coverage records it.
 */
export const specSignature = (
  layout: ManagedMetadataLayout,
  blob: Buffer,
  owner: {
    readonly form: "type" | "instantiation";
    readonly scope: string;
    readonly offset: number;
  },
): readonly string[] => {
  const budget = managedDecodeBudget(layout);
  // Rendering is transient, so charge it as member signatures are charged.
  budget.admitTransient(blob.length * 256, owner.offset);
  try {
    let cursor = 0;
    let count = 1;
    if (owner.form === "instantiation") {
      if (blob[0] !== 0x0a)
        malformedSignature("MethodSpec instantiation is not GENERICINST", 0);
      const header = readCompressed(blob, 1);
      if (header.value === 0)
        malformedSignature("MethodSpec instantiation has no type arguments", 1);
      count = header.value;
      cursor = header.next;
    }
    const types: string[] = [];
    // Each Type consumes at least one byte, so a false count fails on truncation.
    for (let index = 0; index < count; index += 1) {
      const type = readTypeSignature(blob, cursor, "type", layout);
      types.push(type.value);
      cursor = type.next;
    }
    if (cursor !== blob.length)
      malformedSignature("Trailing signature data", cursor);
    return types;
  } catch (cause: unknown) {
    if (
      !(cause instanceof ManagedReaderFailure) ||
      (cause.issue.code !== "invalid-blob" &&
        cause.issue.code !== "invalid-row" &&
        cause.issue.code !== "unsupported-signature")
    )
      throw cause;
    throw managedFailure(
      cause.issue.code,
      owner.scope,
      cause.issue.detail,
      owner.offset,
    );
  } finally {
    budget.releaseTransient();
  }
};

type DecodedSignature = Omit<ManagedSignature, "raw_length" | "raw_sha256">;

/**
 * Decode a field or member method signature. A malformed or unsupported blob
 * decodes as kind `unknown` with its reason.
 */
const decodeSignature = (blob: Buffer): DecodedSignature => {
  try {
    if (blob.length === 0)
      throw managedFailure("invalid-blob", "signature", "empty signature", 0);
    const first = blob[0] ?? 0;
    // FieldSig (II.23.2.4) is exactly FIELD; a flagged FIELD header is not a
    // method header either, so it is malformed below.
    if (first === 0x06) {
      const fieldType = readTypeSignature(blob, 1, "field");
      return {
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
    const header = readMethodSignatureHeader(blob, 0, "member");
    const returnType = readTypeSignature(blob, header.next, "return");
    let offset = returnType.next;
    const parameters: string[] = [];
    for (let index = 0; index < header.parameterCount; index += 1) {
      const parameter = readTypeSignature(blob, offset, "parameter");
      parameters.push(parameter.value);
      offset = parameter.next;
    }
    return {
      kind: "method",
      parse_status: offset === blob.length ? "decoded" : "partial",
      calling_convention: callingConvention(first),
      generic_parameter_count: header.genericParameterCount,
      parameter_count: header.parameterCount,
      return_type: returnType.value,
      parameter_types: parameters,
      field_type: null,
      issue: offset === blob.length ? null : "Trailing signature data",
    };
  } catch (cause: unknown) {
    if (!(cause instanceof ManagedReaderFailure)) throw cause;
    if (
      cause.issue.code !== "invalid-blob" &&
      cause.issue.code !== "unsupported-signature"
    )
      throw cause;
    return {
      kind: "unknown",
      parse_status:
        cause.issue.code === "unsupported-signature"
          ? "unsupported"
          : "malformed",
      calling_convention: null,
      generic_parameter_count: null,
      parameter_count: null,
      return_type: null,
      parameter_types: [],
      field_type: null,
      issue: cause.issue.detail,
    };
  }
};

/**
 * Generic parameter count of a method signature that decodes completely, 0
 * when it is not generic, or null when the blob is not a decodable method
 * signature. The rendered decode is transient.
 */
export const methodGenericArity = (
  layout: ManagedMetadataLayout,
  blob: Buffer,
): number | null => {
  const budget = managedDecodeBudget(layout);
  budget.admitTransient(blob.length * 256, layout.blob.offset);
  try {
    return signatureGenericArity(decodeSignature(blob));
  } finally {
    budget.releaseTransient();
  }
};

/**
 * Generic parameter count of a completely decoded method signature, 0 when it
 * is not generic, or null for any other signature.
 */
export const signatureGenericArity = (
  decoded: DecodedSignature,
): number | null =>
  decoded.kind === "method" && decoded.parse_status === "decoded"
    ? (decoded.generic_parameter_count ?? 0)
    : null;

export const signature = (
  blob: Buffer,
  rawSha256?: string,
): ManagedSignature => ({
  raw_length: blob.length,
  raw_sha256: rawSha256 ?? sha256Bytes(blob),
  ...decodeSignature(blob),
});
