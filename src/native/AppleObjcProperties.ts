import type { z } from "zod";

import type { objcPropertySchema } from "../domain/native/objcSwiftMetadata.js";

type ObjcProperty = z.infer<typeof objcPropertySchema>;

/** Byte readers needed to decode an Objective-C `property_list_t`. */
export interface ObjcPropertyReaders {
  u32(address: bigint): number;
  pointer(address: bigint): bigint;
  string(address: bigint): string;
}

/**
 * Parse an `@property` attribute string such as `T@"NSString",C,N,V_name`.
 * Each comma-separated token is one attribute; `T` is the type encoding.
 */
export const parsePropertyAttributes = (
  name: string,
  attributes: string,
): ObjcProperty => {
  const tokens = attributes.length === 0 ? [] : splitAttributes(attributes);
  const value = (code: string): string | null =>
    tokens.find((token) => token.startsWith(code))?.slice(1) ?? null;
  return {
    name,
    type_encoding: value("T"),
    attributes: tokens.map((token) => ({
      name: token.slice(0, 1),
      value: token.slice(1),
      is_weak: token === "W",
      is_atomic: false,
      is_copy: token === "C",
      is_strong: token === "&",
    })),
    is_readonly: tokens.includes("R"),
    getter: value("G"),
    setter: value("S"),
  };
};

/** Split on commas that are outside a quoted class name in the type encoding. */
const splitAttributes = (attributes: string): string[] => {
  const tokens: string[] = [];
  let current = "";
  let quoted = false;
  for (const character of attributes) {
    if (character === '"') quoted = !quoted;
    if (character === "," && !quoted) {
      tokens.push(current);
      current = "";
    } else current += character;
  }
  tokens.push(current);
  return tokens.filter((token) => token.length > 0);
};

/** Decode `property_list_t { entsize_and_flags, count, property_t[] }`. */
export const readObjcPropertyList = (
  read: ObjcPropertyReaders,
  list: bigint,
  admit: () => boolean,
): ObjcProperty[] => {
  if (list === 0n) return [];
  const entrySize = read.u32(list) & ~3;
  const count = read.u32(list + 4n);
  if (entrySize !== 16)
    throw new TypeError(
      `Unsupported Objective-C property entry size ${entrySize}`,
    );
  const properties: ObjcProperty[] = [];
  for (let index = 0; index < count; index++) {
    if (!admit()) break;
    const entry = list + 8n + BigInt(index * entrySize);
    properties.push(
      parsePropertyAttributes(
        read.string(read.pointer(entry)),
        read.string(read.pointer(entry + 8n)),
      ),
    );
  }
  return properties;
};

/** Decode a property list, recording a failure for `owner` instead of throwing. */
export const readObjcPropertiesOf = (
  read: ObjcPropertyReaders,
  list: bigint,
  context: {
    readonly owner: string;
    readonly admit: () => boolean;
    readonly failures: string[];
  },
): ObjcProperty[] => {
  try {
    return readObjcPropertyList(read, list, context.admit);
  } catch (cause: unknown) {
    context.failures.push(
      `Properties of ${context.owner}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    return [];
  }
};
