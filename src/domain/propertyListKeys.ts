import { DOMParser, normalizeLineEndings } from "@xmldom/xmldom";
import { parse } from "plist";

/** The dictionary key REA results cannot carry: validation strips it. */
const PROTOTYPE_KEY = "__proto__";

/** A decoded plist without `__proto__` entries, and how many were omitted. */
export interface PropertyListWithoutPrototypeKeys {
  readonly value: unknown;
  readonly omittedPrototypeKeys: number;
}

/** Limitation for results whose source plist held `__proto__` entries. */
export const omittedPrototypeKeysLimitation = (count: number | null): string =>
  count === null
    ? "Dictionary entries keyed __proto__ were omitted because REA results cannot represent that key."
    : `${String(count)} dictionary ${count === 1 ? "entry" : "entries"} keyed __proto__ ${count === 1 ? "was" : "were"} omitted because REA results cannot represent that key.`;

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
  // Preserve the pinned decoder's existing OpenStep autodetection, also used
  // by app Info.plist resolution. Only XML needs the key-element substitution.
  const first = text.trimStart()[0];
  if (first === "{" || first === "(") return omitPrototypeKeys(parse(text));
  const { substituted, placeholder } = substitutePrototypeKeys(
    normalizeLineEndings(text),
  );
  return withoutKey(parse(substituted), placeholder);
};

/** Locate keys with the same XML parser and first-child semantics as plist. */
const substitutePrototypeKeys = (text: string) => {
  // Normalize only the literal line endings the pinned decoder normalizes.
  // Preserve character references in the source: serializing a DOM would turn
  // e.g. an encoded carriage return into a literal newline on the second parse.
  const document = new DOMParser().parseFromString(text, "text/xml");
  const keys = Array.from(document.getElementsByTagName("key"));
  const decodedKeys = new Set(keys.map((key) => key.firstChild?.nodeValue));
  let placeholder = "__rea_prototype_key__";
  while (decodedKeys.has(placeholder)) placeholder = `_${placeholder}`;

  const omitted = keys
    .map((key) => key.firstChild)
    .filter((node) => node?.nodeValue === PROTOTYPE_KEY);
  if (omitted.length === 0) return { substituted: text, placeholder };

  // xmldom uses one-based locators in document order. Scan forward only to
  // needed lines instead of retaining an offset for every source newline.
  let line = 1;
  let lineStart = 0;
  const parts: string[] = [];
  let cursor = 0;
  for (const node of omitted) {
    const nodeLine = node?.lineNumber;
    const column = node?.columnNumber;
    if (nodeLine === undefined || column === undefined)
      throw new TypeError("XML plist key has no source location");
    while (line < nodeLine) {
      const newline = text.indexOf("\n", lineStart);
      if (newline === -1)
        throw new TypeError("XML plist key has an invalid source location");
      lineStart = newline + 1;
      line += 1;
    }
    const offset = lineStart + column - 1;
    parts.push(text.slice(cursor, offset), `<![CDATA[${placeholder}]]>`);
    cursor = offset;
  }
  parts.push(text.slice(cursor));
  return { substituted: parts.join(""), placeholder };
};
