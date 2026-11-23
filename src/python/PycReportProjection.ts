import type {
  MarshalBytes,
  MarshalInt,
  MarshalList,
  MarshalString,
  MarshalTuple,
} from "../domain/python/marshalReader.js";
import {
  PYTHON_PYC_CONST_PREVIEW_LIMIT,
  PYTHON_PYC_INT_PREVIEW_BITS,
  type PythonPycCodeObject,
  type PythonPycConst,
} from "../domain/python/pythonPyc.js";
import { malformedInput, unsupportedInput } from "../domain/parseFailure.js";
import { sha256Hex } from "../kernel/sha256Hex.js";
import { PYTHON_PYC_FORMAT } from "./PythonPyc.errors.js";

export type MarshalValue =
  | MarshalInt
  | MarshalBytes
  | MarshalString
  | MarshalTuple<MarshalValue>
  | MarshalList<MarshalValue>
  | { readonly kind: "null" }
  | { readonly kind: "none" }
  | { readonly kind: "bool"; readonly value: boolean }
  | { readonly kind: "ellipsis" }
  | { readonly kind: "stopiter" }
  | { readonly kind: "float"; readonly value: number }
  | { readonly kind: "complex"; readonly real: number; readonly imag: number }
  | { readonly kind: "set"; readonly items: MarshalValue[] }
  | { readonly kind: "frozenset"; readonly items: MarshalValue[] }
  /** CPython 3.14+ slice constant: start, stop, and step. */
  | { readonly kind: "slice"; readonly items: MarshalValue[] }
  | {
      readonly kind: "dict";
      readonly items: [MarshalValue, MarshalValue][];
    }
  | { readonly kind: "code"; readonly value: CodeNode };

/**
 * A decoded code object. `consts` and `nested` stay empty until the marshal
 * graph is complete: a container can refer to itself before its items exist.
 * TYPE_REF children are the same node, not copies.
 */
export type CodeNode = Omit<PythonPycCodeObject, "nested_code" | "consts"> & {
  consts: PythonPycConst[];
  nested: CodeNode[];
};

export const malformed = (message: string): never => {
  throw malformedInput(PYTHON_PYC_FORMAT, message);
};

export const unsupported = (message: string): never => {
  throw unsupportedInput(PYTHON_PYC_FORMAT, message);
};

/**
 * Work one parse performs, counted where it happens, so a caller can bound an
 * algorithm by exact counts rather than elapsed time. Counts accumulate until
 * the parse returns or throws.
 */
export type PythonPycWork = {
  /** Bytes hashed with SHA-256. */
  digestedBytes: number;
  /** Constant summaries built; every TYPE_REF copy reuses one. */
  constSummaries: number;
  /** Container child slots listed for the nested code walk. */
  listedChildren: number;
  /** Nested code walk steps. */
  nestedSteps: number;
  /** Equality-key walk steps. */
  keySteps: number;
  /** Bytes of joined equality keys. */
  keyBytes: number;
  /** Code objects the report flattening visits, including repeat references. */
  codeVisits: number;
};

export const emptyPythonPycWork = (): PythonPycWork => ({
  digestedBytes: 0,
  constSummaries: 0,
  listedChildren: 0,
  nestedSteps: 0,
  keySteps: 0,
  keyBytes: 0,
  codeVisits: 0,
});

const digests = new WeakMap<Buffer, string>();
export const sha256 = (bytes: Buffer, work: PythonPycWork): string => {
  const cached = digests.get(bytes);
  if (cached !== undefined) return cached;
  work.digestedBytes += bytes.length;
  const digest = sha256Hex(bytes);
  digests.set(bytes, digest);
  return digest;
};

/** Keep values whose identity JSON numbers cannot preserve as Python repr. */
export const jsonFloat = (
  value: number,
): number | "inf" | "-inf" | "nan" | "-0.0" =>
  Number.isNaN(value)
    ? "nan"
    : value === Infinity
      ? "inf"
      : value === -Infinity
        ? "-inf"
        : Object.is(value, -0)
          ? "-0.0"
          : value;

/**
 * Emit each distinct code object once, the top-level object first. A child
 * shared through TYPE_REF is listed once and referenced by index, so the
 * report never repeats a subtree.
 */
export const flattenCode = (
  root: CodeNode,
  work: PythonPycWork,
): PythonPycCodeObject[] => {
  const indexes = new Map<CodeNode, number>();
  const order: CodeNode[] = [];
  const visit = (node: CodeNode): void => {
    work.codeVisits += 1;
    if (indexes.has(node)) return;
    indexes.set(node, order.length);
    order.push(node);
    for (const child of node.nested) visit(child);
  };
  visit(root);
  return order.map(({ nested, ...code }) => ({
    ...code,
    nested_code: nested.map(
      (child) =>
        indexes.get(child) ?? malformed("Nested code object was not listed."),
    ),
  }));
};

export const asBytes = (value: MarshalValue, field: string): Buffer => {
  if (value.kind !== "bytes")
    return malformed(`${field} is not marshal bytes.`);
  return value.value;
};

export const asString = (value: MarshalValue, field: string): string => {
  if (value.kind !== "str")
    return malformed(`${field} is not a marshal string.`);
  return value.value;
};

export const asStringWithRaw = (
  value: MarshalValue,
  field: string,
): { readonly value: string; readonly raw: Buffer } => {
  if (value.kind !== "str")
    return malformed(`${field} is not a marshal string.`);
  return value;
};

export const asTuple = (
  value: MarshalValue,
  field: string,
): readonly MarshalValue[] => {
  if (value.kind !== "tuple")
    return malformed(`${field} is not a marshal tuple.`);
  return value.items;
};

const constSummaries = new WeakMap<MarshalValue, PythonPycConst>();

/** One summary per decoded object, so TYPE_REF does not repeat the work. */
export const summarizeConst = (
  value: MarshalValue,
  work: PythonPycWork,
): PythonPycConst => {
  const cached = constSummaries.get(value);
  if (cached !== undefined) return cached;
  work.constSummaries += 1;
  const summary = buildConstSummary(value, work);
  constSummaries.set(value, summary);
  return summary;
};

const buildConstSummary = (
  value: MarshalValue,
  work: PythonPycWork,
): PythonPycConst => {
  switch (value.kind) {
    case "none":
      return { kind: "none" };
    case "bool":
      return { kind: "bool", value: value.value };
    case "int":
      return {
        kind: "int",
        bits: value.bits,
        value:
          value.bits <= PYTHON_PYC_INT_PREVIEW_BITS
            ? value.value.toString()
            : null,
      };
    case "float":
      return { kind: "float", value: jsonFloat(value.value) };
    case "str": {
      const truncated = value.value.length > PYTHON_PYC_CONST_PREVIEW_LIMIT;
      return {
        kind: "str",
        bytes: value.bytes,
        truncated,
        value: truncated ? value.value.slice(0, value.previewEnd) : value.value,
      };
    }
    case "bytes":
      return {
        kind: "bytes",
        bytes: value.value.length,
        sha256: sha256(value.value, work),
      };
    case "code":
      return {
        kind: "code",
        name: value.value.name,
        firstlineno: value.value.firstlineno,
      };
    case "tuple":
      return { kind: "tuple", length: value.items.length };
    case "list":
      return { kind: "list", length: value.items.length };
    case "set":
      return { kind: "set", length: value.items.length };
    case "frozenset":
      return { kind: "frozenset", length: value.items.length };
    case "dict":
      return { kind: "dict", length: value.items.length };
    case "ellipsis":
      return { kind: "ellipsis" };
    case "slice":
      return { kind: "slice" };
    case "complex":
      return {
        kind: "complex",
        real: jsonFloat(value.real),
        imag: jsonFloat(value.imag),
      };
    default:
      return { kind: "other", type: value.kind };
  }
};

/**
 * CPython's `PyOS_string_to_double` grammar for marshal version 0: an optional
 * sign, then `inf`/`infinity`, `nan`, or a decimal literal. No hex floats and
 * no surrounding whitespace.
 */
const MARSHAL_FLOAT =
  /^([+-]?)(?:(inf(?:inity)?)|(nan)|((?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?))$/i;

export const parseMarshalFloat = (text: string): number | undefined => {
  const match = MARSHAL_FLOAT.exec(text);
  if (match === null) return undefined;
  if (match[2] !== undefined) return match[1] === "-" ? -Infinity : Infinity;
  if (match[3] !== undefined) return Number.NaN;
  const value = Number(text);
  return Number.isNaN(value) ? undefined : value;
};
