import type {
  ComponentSort,
  ComponentType,
  ComponentValType,
  ExternType,
  NameAttribute,
  TypeDeclaration,
} from "../domain/wasm/wasmComponentTypes.js";
import type { WasmComponentReader } from "./WasmComponentReader.js";
import {
  openScope,
  optional,
  vector,
  type TypeDecodeContext,
} from "./WasmComponentTypeContext.js";
import { decodeCoreType, decodeCoreValType } from "./WasmCoreTypes.js";

const PRIMITIVES = new Map<number, Exclude<ComponentValType, object>>([
  [0x7f, "bool"],
  [0x7e, "s8"],
  [0x7d, "u8"],
  [0x7c, "s16"],
  [0x7b, "u16"],
  [0x7a, "s32"],
  [0x79, "u32"],
  [0x78, "s64"],
  [0x77, "u64"],
  [0x76, "f32"],
  [0x75, "f64"],
  [0x74, "char"],
  [0x73, "string"],
  [0x64, "error-context"],
]);

/** `valtype`: a primitive opcode or a non-negative type index. */
export const decodeValType = (
  reader: WasmComponentReader,
  context: TypeDecodeContext,
): ComponentValType => {
  const at = reader.offset;
  const value = reader.s33("value type");
  if (value >= 0) return { type: value };
  const primitive = PRIMITIVES.get(value + 0x80);
  if (primitive === undefined)
    throw reader.unsupported(`Unknown value type ${String(value)}`, at);
  if (primitive === "error-context") context.features.add("error-context");
  return primitive;
};

/** `nameattributes` with optional implements, version-suffix and external-id. */
export const decodeNameAttributes = (
  reader: WasmComponentReader,
  context: TypeDecodeContext,
): { name: string; attributes: NameAttribute[] } => {
  const at = reader.offset;
  const kind = reader.byte("extern name");
  if (kind === 0x00 || kind === 0x01)
    return { name: reader.name("extern name"), attributes: [] };
  if (kind !== 0x02)
    throw reader.unsupported(
      `Unknown extern name encoding 0x${kind.toString(16)}`,
      at,
    );
  const name = reader.name("extern name");
  const attributes = vector(reader, "name attributes", (): NameAttribute => {
    const attributeAt = reader.offset;
    const attribute = reader.byte("name attribute");
    switch (attribute) {
      case 0x00:
        context.features.add("implements");
        return {
          kind: "implements",
          interface: reader.name("implements interface"),
        };
      case 0x01:
        context.features.add("version-suffix");
        return {
          kind: "version-suffix",
          suffix: reader.name("version suffix"),
        };
      case 0x02:
        context.features.add("implements");
        return { kind: "external-id", id: reader.name("external id") };
      default:
        throw reader.unsupported(
          `Unknown name attribute 0x${attribute.toString(16)}`,
          attributeAt,
        );
    }
  });
  return { name, attributes };
};

/** `externtype` naming the sort and type an import or export declares. */
export const decodeExternType = (
  reader: WasmComponentReader,
  context: TypeDecodeContext,
): ExternType => {
  const at = reader.offset;
  const sort = reader.byte("extern type");
  switch (sort) {
    case 0x00: {
      const core = reader.byte("core module extern type");
      if (core !== 0x11)
        throw reader.malformed("Expected a core module extern type", at);
      return { sort: "core module", type: reader.u32("core type index") };
    }
    case 0x01:
      return { sort: "func", type: reader.u32("type index") };
    case 0x02: {
      context.features.add("values-and-start");
      const bound = reader.byte("value bound");
      if (bound === 0x00)
        return {
          sort: "value",
          bound: { kind: "eq", value: reader.u32("value index") },
        };
      if (bound === 0x01)
        return {
          sort: "value",
          bound: { kind: "type", type: decodeValType(reader, context) },
        };
      throw reader.unsupported("Unknown value bound", at);
    }
    case 0x03: {
      const bound = reader.byte("type bound");
      if (bound === 0x00)
        return {
          sort: "type",
          bound: { kind: "eq", type: reader.u32("type index") },
        };
      if (bound === 0x01)
        return { sort: "type", bound: { kind: "sub-resource" } };
      throw reader.unsupported("Unknown type bound", at);
    }
    case 0x04:
      return { sort: "component", type: reader.u32("type index") };
    case 0x05:
      return { sort: "instance", type: reader.u32("type index") };
    default:
      throw reader.unsupported(
        `Unknown extern type 0x${sort.toString(16)}`,
        at,
      );
  }
};

const decodeResultList = (
  reader: WasmComponentReader,
  context: TypeDecodeContext,
): ComponentValType | null => {
  const at = reader.offset;
  const kind = reader.byte("result list");
  if (kind === 0x00) return decodeValType(reader, context);
  if (kind === 0x01 && reader.byte("empty result list") === 0x00) return null;
  throw reader.malformed("Invalid result list", at);
};

/** Function type parameters and result; `async` reflects opcode 0x43. */
const decodeFuncType = (
  reader: WasmComponentReader,
  context: TypeDecodeContext,
  isAsync: boolean,
): ComponentType => ({
  kind: "func",
  async: isAsync,
  params: vector(reader, "function parameters", () => ({
    name: reader.name("parameter label"),
    type: decodeValType(reader, context),
  })),
  result: decodeResultList(reader, context),
});

const decodeDeclarations = (
  reader: WasmComponentReader,
  context: TypeDecodeContext,
  kind: "component" | "instance",
  start: number,
): ComponentType => {
  const { scope, nested } = openScope(reader, context, kind, start);
  const count = reader.count(`${kind} type declarations`);
  for (let index = 0; index < count; index += 1) {
    const declarationStart = reader.offset;
    if (kind !== "component" || reader.peek() !== 0x03) {
      scope.declarations.push(decodeInstanceDeclaration(reader, nested));
      continue;
    }
    reader.byte("component import declaration");
    const { name, attributes } = decodeNameAttributes(reader, nested);
    const type = decodeExternType(reader, nested);
    scope.declarations.push({
      kind: "import",
      range: { start: declarationStart, end: reader.offset },
      name,
      attributes,
      type,
    });
  }
  scope.range = { start, end: reader.offset };
  return { kind, scope: scope.scope };
};

const decodeInstanceDeclaration = (
  reader: WasmComponentReader,
  context: TypeDecodeContext,
): TypeDeclaration => {
  const start = reader.offset;
  const tag = reader.byte("instance declaration");
  switch (tag) {
    case 0x00: {
      const type = decodeCoreType(reader, context);
      return { kind: "core-type", range: { start, end: reader.offset }, type };
    }
    case 0x01: {
      const type = decodeComponentType(reader, context);
      return { kind: "type", range: { start, end: reader.offset }, type };
    }
    case 0x02: {
      const { sort, target } = decodeAlias(reader, context);
      return {
        kind: "alias",
        range: { start, end: reader.offset },
        sort,
        target,
      };
    }
    case 0x04: {
      const { name, attributes } = decodeNameAttributes(reader, context);
      const type = decodeExternType(reader, context);
      return {
        kind: "export",
        range: { start, end: reader.offset },
        name,
        attributes,
        type,
      };
    }
    default:
      throw reader.unsupported(
        `Unknown type declaration 0x${tag.toString(16)}`,
        start,
      );
  }
};

type DefinedTypeDecoder = (
  reader: WasmComponentReader,
  context: TypeDecodeContext,
  start: number,
) => ComponentType;

const valType = (reader: WasmComponentReader, context: TypeDecodeContext) =>
  decodeValType(reader, context);

const variantCase = (
  reader: WasmComponentReader,
  context: TypeDecodeContext,
) => {
  const name = reader.name("variant case label");
  const type = optional(reader, "variant case type", () =>
    valType(reader, context),
  );
  const at = reader.offset;
  if (reader.byte("variant case terminator") !== 0x00)
    throw reader.unsupported("Unknown variant case refinement", at);
  return { name, type };
};

const handle =
  (kind: "stream" | "future"): DefinedTypeDecoder =>
  (reader, context) => {
    context.features.add("async");
    return {
      kind,
      element: optional(reader, "element type", () => valType(reader, context)),
    };
  };

/** `defvaltype` and the other `deftype` forms, keyed by opcode. */
const DEFINED_TYPES = new Map<number, DefinedTypeDecoder>([
  [
    0x72,
    (reader, context) => ({
      kind: "record",
      fields: vector(reader, "record fields", () => ({
        name: reader.name("record field label"),
        type: valType(reader, context),
      })),
    }),
  ],
  [
    0x71,
    (reader, context) => ({
      kind: "variant",
      cases: vector(reader, "variant cases", () =>
        variantCase(reader, context),
      ),
    }),
  ],
  [
    0x70,
    (reader, context) => ({
      kind: "list",
      element: valType(reader, context),
      length: null,
    }),
  ],
  [
    0x67,
    (reader, context) => {
      context.features.add("fixed-size-list");
      return {
        kind: "list",
        element: valType(reader, context),
        length: reader.u32("fixed-size list length"),
      };
    },
  ],
  [
    0x6f,
    (reader, context) => ({
      kind: "tuple",
      types: vector(reader, "tuple types", () => valType(reader, context)),
    }),
  ],
  [
    0x6e,
    (reader) => ({
      kind: "flags",
      names: vector(reader, "flag labels", () => reader.name("flag label")),
    }),
  ],
  [
    0x6d,
    (reader) => ({
      kind: "enum",
      names: vector(reader, "enum labels", () => reader.name("enum label")),
    }),
  ],
  [
    0x6b,
    (reader, context) => ({ kind: "option", type: valType(reader, context) }),
  ],
  [
    0x6a,
    (reader, context) => ({
      kind: "result",
      ok: optional(reader, "result ok type", () => valType(reader, context)),
      error: optional(reader, "result error type", () =>
        valType(reader, context),
      ),
    }),
  ],
  [
    0x69,
    (reader) => ({ kind: "own", resource: reader.u32("own resource type") }),
  ],
  [
    0x68,
    (reader) => ({
      kind: "borrow",
      resource: reader.u32("borrow resource type"),
    }),
  ],
  [0x66, handle("stream")],
  [0x65, handle("future")],
  [
    0x63,
    (reader, context) => {
      context.features.add("map");
      return {
        kind: "map",
        key: valType(reader, context),
        value: valType(reader, context),
      };
    },
  ],
  [0x40, (reader, context) => decodeFuncType(reader, context, false)],
  [
    0x43,
    (reader, context) => {
      context.features.add("async");
      return decodeFuncType(reader, context, true);
    },
  ],
  [
    0x3f,
    (reader) => ({
      kind: "resource",
      representation: decodeCoreValType(reader),
      destructor: optional(reader, "resource destructor", () =>
        reader.u32("resource destructor core function"),
      ),
    }),
  ],
  [
    0x41,
    (reader, context, start) =>
      decodeDeclarations(reader, context, "component", start),
  ],
  [
    0x42,
    (reader, context, start) =>
      decodeDeclarations(reader, context, "instance", start),
  ],
]);

/** `deftype`: value, function, resource, component or instance type. */
export const decodeComponentType = (
  reader: WasmComponentReader,
  context: TypeDecodeContext,
): ComponentType => {
  const at = reader.offset;
  const opcode = reader.byte("type");
  const primitive = PRIMITIVES.get(opcode);
  if (primitive !== undefined) {
    if (primitive === "error-context") context.features.add("error-context");
    return { kind: "primitive", primitive };
  }
  const decode = DEFINED_TYPES.get(opcode);
  if (decode === undefined)
    throw reader.unsupported(
      `Unknown type opcode 0x${opcode.toString(16)}`,
      at,
    );
  return decode(reader, context, at);
};

const CORE_SORTS = new Map<number, ComponentSort>([
  [0x00, "core func"],
  [0x01, "core table"],
  [0x02, "core memory"],
  [0x03, "core global"],
  [0x04, "core tag"],
  [0x10, "core type"],
  [0x11, "core module"],
  [0x12, "core instance"],
]);
const SORTS = new Map<number, ComponentSort>([
  [0x01, "func"],
  [0x02, "value"],
  [0x03, "type"],
  [0x04, "component"],
  [0x05, "instance"],
]);

/** `core:sort` mapped onto the component sort vocabulary. */
export const decodeCoreSort = (reader: WasmComponentReader): ComponentSort => {
  const at = reader.offset;
  const code = reader.byte("core sort");
  const sort = CORE_SORTS.get(code);
  if (sort === undefined)
    throw reader.unsupported(`Unknown core sort 0x${code.toString(16)}`, at);
  return sort;
};

/** Component `sort`, including the core prefix. */
export const decodeSort = (
  reader: WasmComponentReader,
  context: TypeDecodeContext,
): ComponentSort => {
  const at = reader.offset;
  const code = reader.byte("sort");
  if (code === 0x00) return decodeCoreSort(reader);
  const sort = SORTS.get(code);
  if (sort === undefined)
    throw reader.unsupported(`Unknown sort 0x${code.toString(16)}`, at);
  if (sort === "value") context.features.add("values-and-start");
  return sort;
};

/** `alias`: export, core export or outer alias. */
export const decodeAlias = (
  reader: WasmComponentReader,
  context: TypeDecodeContext,
): Pick<Extract<TypeDeclaration, { kind: "alias" }>, "sort" | "target"> => {
  const sort = decodeSort(reader, context);
  const at = reader.offset;
  const kind = reader.byte("alias kind");
  switch (kind) {
    case 0x00:
      return {
        sort,
        target: {
          kind: "export",
          instance: reader.u32("alias instance"),
          name: reader.name("alias export name"),
        },
      };
    case 0x01:
      return {
        sort,
        target: {
          kind: "core-export",
          instance: reader.u32("alias core instance"),
          name: reader.name("alias core export name"),
        },
      };
    case 0x02:
      return {
        sort,
        target: {
          kind: "outer",
          count: reader.u32("alias outer count"),
          index: reader.u32("alias outer index"),
        },
      };
    default:
      throw reader.unsupported(`Unknown alias kind 0x${kind.toString(16)}`, at);
  }
};
