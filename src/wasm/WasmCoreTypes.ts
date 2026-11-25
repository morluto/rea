import type {
  CoreExternType,
  CoreType,
  TypeDeclaration,
} from "../domain/wasm/wasmComponentTypes.js";
import type { WasmComponentReader } from "./WasmComponentReader.js";
import {
  openScope,
  vector,
  type TypeDecodeContext,
} from "./WasmComponentTypeContext.js";

const ABSTRACT_HEAP_TYPES = new Map<number, string>([
  [0x70, "func"],
  [0x6f, "extern"],
  [0x6e, "any"],
  [0x6d, "eq"],
  [0x6c, "i31"],
  [0x6b, "struct"],
  [0x6a, "array"],
  [0x69, "exn"],
  [0x71, "none"],
  [0x72, "noextern"],
  [0x73, "nofunc"],
  [0x74, "noexn"],
]);
/** Single-byte reference shorthands, e.g. `0x70` is `funcref`. */
const REFERENCE_SHORTHANDS = new Map<number, string>([
  [0x70, "funcref"],
  [0x6f, "externref"],
  [0x6e, "anyref"],
  [0x6d, "eqref"],
  [0x6c, "i31ref"],
  [0x6b, "structref"],
  [0x6a, "arrayref"],
  [0x69, "exnref"],
  [0x71, "nullref"],
  [0x72, "nullexternref"],
  [0x73, "nullfuncref"],
  [0x74, "nullexnref"],
]);
const NUMERIC_CORE_TYPES = new Map<number, string>([
  [0x7f, "i32"],
  [0x7e, "i64"],
  [0x7d, "f32"],
  [0x7c, "f64"],
  [0x7b, "v128"],
]);

const decodeCoreHeapType = (reader: WasmComponentReader): string => {
  const at = reader.offset;
  const value = reader.s33("core heap type");
  if (value >= 0) return String(value);
  const name = ABSTRACT_HEAP_TYPES.get(value + 0x80);
  if (name === undefined)
    throw reader.unsupported(`Unknown core heap type ${String(value)}`, at);
  return name;
};

/** Core value or reference type in WebAssembly text-format spelling. */
export const decodeCoreValType = (reader: WasmComponentReader): string => {
  const at = reader.offset;
  const opcode = reader.byte("core value type");
  const numeric = NUMERIC_CORE_TYPES.get(opcode);
  if (numeric !== undefined) return numeric;
  if (opcode === 0x63) return `(ref null ${decodeCoreHeapType(reader)})`;
  if (opcode === 0x64) return `(ref ${decodeCoreHeapType(reader)})`;
  const shorthand = REFERENCE_SHORTHANDS.get(opcode);
  if (shorthand !== undefined) return shorthand;
  throw reader.unsupported(
    `Unknown core value type 0x${opcode.toString(16)}`,
    at,
  );
};

const decodeLimits = (reader: WasmComponentReader) => {
  const at = reader.offset;
  const flags = reader.byte("core limits");
  if ((flags & ~0x0f) !== 0)
    throw reader.unsupported(
      `Unknown core limits flags 0x${flags.toString(16)}`,
      at,
    );
  const index64 = (flags & 0x04) !== 0;
  const read = (context: string) =>
    index64 ? reader.u64(context) : reader.u32(context);
  const min = read("core limits minimum");
  const max = (flags & 0x01) !== 0 ? read("core limits maximum") : null;
  const pageSize =
    (flags & 0x08) !== 0 ? reader.u32("core memory page size") : null;
  return {
    min,
    max,
    shared: (flags & 0x02) !== 0,
    index64,
    page_size_log2: pageSize,
  };
};

/** `core:externtype` as used by core imports and module-type declarations. */
export const decodeCoreExternType = (
  reader: WasmComponentReader,
): CoreExternType => {
  const at = reader.offset;
  const kind = reader.byte("core extern type");
  switch (kind) {
    case 0x00:
      return { kind: "func", type: reader.u32("core function type index") };
    case 0x01:
      return {
        kind: "table",
        element: decodeCoreValType(reader),
        limits: decodeLimits(reader),
      };
    case 0x02:
      return { kind: "memory", limits: decodeLimits(reader) };
    case 0x03: {
      const type = decodeCoreValType(reader);
      const mutability = reader.byte("core global mutability");
      if (mutability > 1)
        throw reader.malformed("Invalid core global mutability");
      return { kind: "global", type, mutable: mutability === 1 };
    }
    case 0x04: {
      const attribute = reader.byte("core tag attribute");
      if (attribute !== 0x00)
        throw reader.unsupported("Unknown core tag attribute");
      return { kind: "tag", type: reader.u32("core tag type index") };
    }
    default:
      throw reader.unsupported(
        `Unknown core extern type 0x${kind.toString(16)}`,
        at,
      );
  }
};

/** `core:type` with core function and module types; GC types are not decoded. */
export const decodeCoreType = (
  reader: WasmComponentReader,
  context: TypeDecodeContext,
): CoreType => {
  const at = reader.offset;
  const opcode = reader.byte("core type");
  if (opcode === 0x60)
    return {
      kind: "func",
      params: vector(reader, "core function parameters", () =>
        decodeCoreValType(reader),
      ),
      results: vector(reader, "core function results", () =>
        decodeCoreValType(reader),
      ),
    };
  if (opcode === 0x50) {
    const { scope, nested } = openScope(reader, context, "core module", at);
    const count = reader.count("core module type declarations");
    for (let index = 0; index < count; index += 1)
      scope.declarations.push(decodeCoreModuleDeclaration(reader, nested));
    scope.range = { start: at, end: reader.offset };
    return { kind: "module", scope: scope.scope };
  }
  throw reader.unsupported(
    `Core type opcode 0x${opcode.toString(16)} (recursive, subtype or GC types) is not decoded`,
    at,
  );
};

const decodeCoreModuleDeclaration = (
  reader: WasmComponentReader,
  context: TypeDecodeContext,
): TypeDeclaration => {
  const start = reader.offset;
  const kind = reader.byte("core module declaration");
  switch (kind) {
    case 0x00: {
      const module = reader.name("core import module name");
      const name = reader.name("core import name");
      const type = decodeCoreExternType(reader);
      return {
        kind: "core-import",
        range: { start, end: reader.offset },
        module,
        name,
        type,
      };
    }
    case 0x01: {
      const type = decodeCoreType(reader, context);
      return { kind: "core-type", range: { start, end: reader.offset }, type };
    }
    case 0x02: {
      const sort = reader.byte("core alias sort");
      const outer = reader.byte("core alias kind");
      if (sort !== 0x10 || outer !== 0x01)
        throw reader.unsupported("Unknown core module alias", start);
      const count = reader.u32("core alias outer count");
      const index = reader.u32("core alias outer index");
      return {
        kind: "alias",
        range: { start, end: reader.offset },
        sort: "core type",
        target: { kind: "outer", count, index },
      };
    }
    case 0x03: {
      const name = reader.name("core export name");
      const type = decodeCoreExternType(reader);
      return {
        kind: "core-export",
        range: { start, end: reader.offset },
        name,
        type,
      };
    }
    default:
      throw reader.unsupported(
        `Unknown core module declaration 0x${kind.toString(16)}`,
        start,
      );
  }
};
