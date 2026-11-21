import { constants as bufferConstants } from "node:buffer";
import { getHeapStatistics } from "node:v8";

/** Allow for expanded values, stringify, Playwright transport and browser-side copies. */
const SCENARIO_ALLOCATION_FACTOR = 16;
export const scenarioSerializationAllowance = (): number =>
  Math.min(
    bufferConstants.MAX_STRING_LENGTH,
    Math.floor(
      getHeapStatistics().total_available_size / SCENARIO_ALLOCATION_FACTOR,
    ),
  );

type QueryEncoding = "uri-component" | "form";
const URI_KEPT = /^[\w.!~*'()-]$/u;
const FORM_KEPT = /^[\w *.-]$/u;

/** Count the selected encoder's ASCII output without allocating an encoded copy. */
const componentLength = (
  text: string,
  limit: number,
  encoding: QueryEncoding,
): number => {
  let length = 0;
  for (const character of text) {
    const point = character.codePointAt(0)!;
    if (point >= 0xd800 && point <= 0xdfff && encoding === "uri-component")
      throw new URIError("URI malformed");
    // URLSearchParams replaces an unpaired UTF-16 unit with U+FFFD (three UTF-8 bytes).
    length += (encoding === "form" ? FORM_KEPT : URI_KEPT).test(character)
      ? 1
      : 3 * (point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4);
    if (length > limit) return length;
  }
  return length;
};

export const uriComponentLength = (text: string, limit: number): number =>
  componentLength(text, limit, "uri-component");

/** Query separators and encoded entries; a result above the budget establishes overflow only. */
export const scenarioQueryLength = (
  entries: readonly (readonly [string, string])[],
  budget: number,
  encoding: QueryEncoding,
): number => {
  let rawLength = Math.max(0, entries.length * 2 - 1);
  for (const [name, value] of entries) {
    rawLength += name.length + value.length;
    if (rawLength > budget) return rawLength;
  }
  let length = Math.max(0, entries.length * 2 - 1);
  const sizes = new Map<string, number>();
  for (const entry of entries)
    for (const text of entry) {
      let size = sizes.get(text);
      if (size === undefined) {
        size = componentLength(text, budget - length, encoding);
        sizes.set(text, size);
      }
      length += size;
      if (length > budget) return length;
    }
  return length;
};
