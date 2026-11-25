import type { GatedFeature } from "../domain/wasm/wasmComponent.js";
import type { TypeScope } from "../domain/wasm/wasmComponentTypes.js";
import type { WasmComponentReader } from "./WasmComponentReader.js";

/** Bounds recursion through nested component, instance and module types. */
export const MAX_TYPE_SCOPE_DEPTH = 32;

/** Shared registry for flat type scopes and observed feature gates. */
export interface TypeDecodeContext {
  readonly scopes: TypeScope[];
  readonly features: Set<GatedFeature>;
  readonly depth: number;
}

/** `<T>?`: `0x00` for absent, `0x01` followed by the value. */
export const optional = <T>(
  reader: WasmComponentReader,
  context: string,
  decode: () => T,
): T | null => {
  const at = reader.offset;
  const present = reader.byte(context);
  if (present === 0x00) return null;
  if (present === 0x01) return decode();
  throw reader.malformed(`Invalid optional marker in ${context}`, at);
};

/** `vec(T)` with its count bounded by the remaining bytes. */
export const vector = <T>(
  reader: WasmComponentReader,
  context: string,
  decode: () => T,
): T[] => {
  const count = reader.count(context);
  const values: T[] = [];
  for (let index = 0; index < count; index += 1) values.push(decode());
  return values;
};

/**
 * Decode one top-level type; if it fails, drop every scope it registered so
 * no partially decoded scope or provisional range survives.
 */
export const decodeTypeAtomically = <T>(
  context: TypeDecodeContext,
  decode: () => T,
): T => {
  const registered = context.scopes.length;
  try {
    return decode();
  } catch (cause: unknown) {
    context.scopes.length = registered;
    throw cause;
  }
};

/** Register a flat declaration scope for a component, instance or module type. */
export const openScope = (
  reader: WasmComponentReader,
  context: TypeDecodeContext,
  kind: TypeScope["kind"],
  start: number,
): { scope: TypeScope; nested: TypeDecodeContext } => {
  if (context.depth >= MAX_TYPE_SCOPE_DEPTH)
    throw reader.unsupported(
      `Type nesting exceeds ${String(MAX_TYPE_SCOPE_DEPTH)} scopes`,
      start,
    );
  const scope: TypeScope = {
    scope: context.scopes.length,
    kind,
    range: { start, end: start },
    declarations: [],
  };
  context.scopes.push(scope);
  return { scope, nested: { ...context, depth: context.depth + 1 } };
};
