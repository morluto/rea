import { parse } from "plist";

/** The dictionary key the `plist` XML decoder refuses outright (CVE-2022-22912). */
const PROTOTYPE_KEY = "__proto__";

/** plist scalar leaves: the decoders attach dates and data as class instances. */
const isPlistScalar = (item: unknown): boolean =>
  item === null ||
  typeof item !== "object" ||
  item instanceof Date ||
  item instanceof Uint8Array;

/**
 * Restore `__proto__` dictionary entries that binary-plist decoding loses to
 * the prototype setter. `plist`'s binary decoder assigns members with
 * `dict[key] = value`, so an object-valued `__proto__` member replaces the
 * dictionary's prototype instead of becoming an own property — and a null
 * member erases it. Decoded trees have no other way to carry a non-standard
 * prototype, so one always names the lost `__proto__` value. A primitive
 * `__proto__` member is dropped by the setter before REA sees the tree and
 * cannot be recovered.
 */
export const restorePrototypeKeys = (value: unknown): unknown => {
  const restore = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(restore);
    if (isPlistScalar(item)) return item;
    const entries = Object.entries(item as Record<string, unknown>).map(
      ([name, entry]) => [name, restore(entry)] as const,
    );
    const prototype: unknown = Object.getPrototypeOf(item);
    if (prototype === Object.prototype) return Object.fromEntries(entries);
    return Object.fromEntries([
      ...entries,
      [PROTOTYPE_KEY, prototype === null ? null : restore(prototype)] as const,
    ]);
  };
  return restore(value);
};

// Comments and CDATA text are consumed whole so only element keys match.
const KEY_TOKEN =
  /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<key>([^<]*)<\/key>|<key><!\[CDATA\[([\s\S]*?)\]\]><\/key>/gu;

const XML_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  quot: '"',
};

/**
 * Expand XML character and predefined entity references. A reference beyond
 * Unicode stays as written: comments and CDATA may hold such text literally,
 * and the XML decoder rejects it anywhere else.
 */
const decodeXmlText = (text: string): string =>
  text.replace(
    /&(?:#x([\da-f]+)|#(\d+)|([a-z]+));/giu,
    (entity, hex?: string, decimal?: string, name?: string) => {
      const codePoint =
        hex !== undefined
          ? parseInt(hex, 16)
          : decimal !== undefined
            ? parseInt(decimal, 10)
            : undefined;
      if (codePoint !== undefined)
        return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
      return (name === undefined ? undefined : XML_ENTITIES[name]) ?? entity;
    },
  );

/**
 * Decode an XML plist, keeping dictionaries that use the legal key
 * `__proto__`. The `plist` decoder rejects that key outright, so the source
 * text substitutes a placeholder the document cannot contain; the decoded
 * tree then restores each placeholder as an ordinary own `__proto__`
 * property via `Object.fromEntries`, which never reaches the setter.
 */
export const parseXmlPropertyList = (text: string): unknown => {
  // The decoded text holds every key the decoder can produce, including
  // entity-encoded spellings of the placeholder, so no source key aliases it.
  // Decoding comment or CDATA text too can only lengthen the placeholder.
  const decoded = decodeXmlText(text);
  let placeholder = "__rea_prototype_key__";
  while (decoded.includes(placeholder)) placeholder = `_${placeholder}`;
  const substituted = text.replace(
    KEY_TOKEN,
    (token, plain?: string, cdata?: string) =>
      (plain === undefined ? cdata : decodeXmlText(plain)) === PROTOTYPE_KEY
        ? `<key>${placeholder}</key>`
        : token,
  );
  const restore = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(restore);
    if (isPlistScalar(item)) return item;
    return Object.fromEntries(
      Object.entries(item as Record<string, unknown>).map(([name, entry]) => [
        name === placeholder ? PROTOTYPE_KEY : name,
        restore(entry),
      ]),
    );
  };
  return restore(parse(substituted));
};
