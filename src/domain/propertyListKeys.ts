import { parse } from "plist";

/** The dictionary key REA results cannot carry: validation strips it. */
const PROTOTYPE_KEY = "__proto__";

/** A decoded plist without `__proto__` entries, and how many were omitted. */
export interface PropertyListWithoutPrototypeKeys {
  readonly value: unknown;
  readonly omittedPrototypeKeys: number;
}

/** Limitation for results whose source plist held `__proto__` entries. */
export const omittedPrototypeKeysLimitation = (count: number): string =>
  `${String(count)} dictionary ${count === 1 ? "entry" : "entries"} keyed __proto__ ${count === 1 ? "was" : "were"} omitted because REA results cannot represent that key.`;

const withoutKey = (
  value: unknown,
  key: string,
): PropertyListWithoutPrototypeKeys => {
  let omitted = 0;
  const strip = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(strip);
    if (
      item === null ||
      typeof item !== "object" ||
      item instanceof Date ||
      item instanceof Uint8Array
    )
      return item;
    return Object.fromEntries(
      Object.entries(item).flatMap(([name, entry]) => {
        if (name !== key) return [[name, strip(entry)]];
        omitted += 1;
        return [];
      }),
    );
  };
  const stripped = strip(value);
  return { value: stripped, omittedPrototypeKeys: omitted };
};

/** Remove own `__proto__` entries, such as JSON.parse creates, and count them. */
export const omitPrototypeKeys = (
  value: unknown,
): PropertyListWithoutPrototypeKeys => withoutKey(value, PROTOTYPE_KEY);

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
export const decodeXmlText = (text: string): string =>
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
 * Decode an XML plist whose dictionaries may use the legal key `__proto__`,
 * which the `plist` decoder rejects outright. Those entries are omitted and
 * counted so callers can report them instead of failing the whole document.
 */
export const parseXmlPropertyList = (
  text: string,
): PropertyListWithoutPrototypeKeys => {
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
  return withoutKey(parse(substituted), placeholder);
};
