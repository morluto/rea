import type { DecodedComponent } from "../domain/wasm/wasmComponent.js";
import type { ComponentSort } from "../domain/wasm/wasmComponentTypes.js";
import type {
  ComponentIndexSpaces,
  IndexOrigin,
} from "./WasmComponentIndexSpaces.js";
import type { WasmComponentReader } from "./WasmComponentReader.js";
import type { TypeDecodeContext } from "./WasmComponentTypeContext.js";
import {
  decodeCoreSort,
  decodeExternType,
  decodeNameAttributes,
  decodeSort,
} from "./WasmComponentTypes.js";

/** One core instance: a module instantiation or inline exports. */
export const decodeCoreInstance = (
  reader: WasmComponentReader,
  spaces: ComponentIndexSpaces,
): DecodedComponent["core_instances"][number] => {
  const start = reader.offset;
  const kind = reader.byte("core instance expression");
  if (kind === 0x00) {
    const module = reader.u32("core instance module");
    const args: { name: string; instance: number }[] = [];
    const count = reader.count("core instantiate arguments");
    for (let index = 0; index < count; index += 1) {
      const name = reader.name("core instantiate argument name");
      const sortAt = reader.offset;
      if (reader.byte("core instantiate argument sort") !== 0x12)
        throw reader.unsupported(
          "Core instantiate argument is not an instance",
          sortAt,
        );
      args.push({ name, instance: reader.u32("core instantiate argument") });
    }
    return {
      kind: "instantiate",
      index: spaces.add("core instance", {
        kind: "core-instantiate",
        module,
        args,
      }),
      range: { start, end: reader.offset },
      module,
      args,
    };
  }
  if (kind !== 0x01)
    throw reader.unsupported(
      `Unknown core instance expression 0x${kind.toString(16)}`,
      start,
    );
  const exports: { name: string; sort: ComponentSort; index: number }[] = [];
  const count = reader.count("core inline exports");
  for (let index = 0; index < count; index += 1)
    exports.push({
      name: reader.name("core inline export name"),
      sort: decodeCoreSort(reader),
      index: reader.u32("core inline export index"),
    });
  return {
    kind: "inline-exports",
    index: spaces.add("core instance", {
      kind: "inline-exports",
      exports,
    }),
    range: { start, end: reader.offset },
    exports,
  };
};

/** One component instance: an instantiation or inline exports. */
export const decodeInstance = (
  reader: WasmComponentReader,
  types: TypeDecodeContext,
  spaces: ComponentIndexSpaces,
): DecodedComponent["instances"][number] => {
  const start = reader.offset;
  const kind = reader.byte("instance expression");
  if (kind === 0x00) {
    const componentIndex = reader.u32("instance component");
    const args: { name: string; sort: ComponentSort; index: number }[] = [];
    const count = reader.count("instantiate arguments");
    for (let index = 0; index < count; index += 1)
      args.push({
        name: reader.name("instantiate argument name"),
        sort: decodeSort(reader, types),
        index: reader.u32("instantiate argument index"),
      });
    return {
      kind: "instantiate",
      index: spaces.add("instance", { kind: "other" }),
      range: { start, end: reader.offset },
      component: componentIndex,
      args,
    };
  }
  if (kind !== 0x01)
    throw reader.unsupported(
      `Unknown instance expression 0x${kind.toString(16)}`,
      start,
    );
  const exports: Extract<
    DecodedComponent["instances"][number],
    { kind: "inline-exports" }
  >["exports"] = [];
  const count = reader.count("inline exports");
  for (let index = 0; index < count; index += 1) {
    const { name, attributes } = decodeNameAttributes(reader, types);
    exports.push({
      name,
      attributes,
      sort: decodeSort(reader, types),
      index: reader.u32("inline export index"),
    });
  }
  return {
    kind: "inline-exports",
    index: spaces.add("instance", { kind: "inline-exports", exports }),
    range: { start, end: reader.offset },
    exports,
  };
};

/** Index origin of an alias, for relationship tracing. */
export const aliasOrigin = (
  target: DecodedComponent["aliases"][number]["target"],
): IndexOrigin => {
  if (target.kind === "export")
    return {
      kind: "alias-export",
      instance: target.instance,
      name: target.name,
    };
  if (target.kind === "core-export")
    return {
      kind: "alias-core-export",
      instance: target.instance,
      name: target.name,
    };
  return { kind: "other" };
};

/** The start section's function, value arguments and result count. */
export const decodeStart = (
  reader: WasmComponentReader,
  types: TypeDecodeContext,
  component: DecodedComponent,
  spaces: ComponentIndexSpaces,
): void => {
  types.features.add("values-and-start");
  const start = reader.offset;
  const func = reader.u32("start function");
  const args: number[] = [];
  const count = reader.count("start arguments");
  for (let index = 0; index < count; index += 1)
    args.push(reader.u32("start argument value"));
  const results = reader.u32("start result count");
  reader.expectEnd("start section");
  spaces.addAnonymous("value", results);
  component.start = {
    range: { start, end: reader.offset },
    func,
    args,
    results,
  };
};

/** One component export, which also defines an index in its sort. */
export const decodeExport = (
  reader: WasmComponentReader,
  types: TypeDecodeContext,
  component: DecodedComponent,
  spaces: ComponentIndexSpaces,
): void => {
  const start = reader.offset;
  const { name, attributes } = decodeNameAttributes(reader, types);
  const sort = decodeSort(reader, types);
  const target = { sort, index: reader.u32("export index") };
  const typeAt = reader.offset;
  const typed = reader.byte("export type marker");
  if (typed > 1) throw reader.malformed("Invalid optional export type", typeAt);
  const type = typed === 1 ? decodeExternType(reader, types) : null;
  component.exports.push({
    range: { start, end: reader.offset },
    name,
    attributes,
    target,
    type,
    defines: {
      sort,
      index: spaces.add(sort, { kind: "export", of: target.index }),
    },
  });
};
