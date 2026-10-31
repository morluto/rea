import { priFailure, priLimit, type SectionContent } from "./PriLayout.js";

/**
 * Structural names and qualifier values may share string pool suffixes, so
 * decoded text is budgeted separately from the file size. The largest stock
 * Windows 11 PRI measured (13,922 items) decodes about one million code units.
 */
const STRUCTURAL_TEXT_UNITS = 1 << 24;

/** Shared allocation budget for decoded structural strings. */
export class TextBudget {
  #used = 0;

  consume(units: number, what: string): void {
    this.#used += units;
    if (this.#used > STRUCTURAL_TEXT_UNITS)
      priLimit(
        `PRI ${what} exceed the ${String(STRUCTURAL_TEXT_UNITS)} code-unit structural text budget; no partial inventory was returned.`,
      );
  }
}

const isHighSurrogate = (unit: number): boolean =>
  unit >= 0xd800 && unit <= 0xdbff;
const isLowSurrogate = (unit: number): boolean =>
  unit >= 0xdc00 && unit <= 0xdfff;

/** True when every surrogate code unit belongs to a complete pair. */
const wellFormedUtf16 = (text: string): boolean => {
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (isHighSurrogate(unit) && isLowSurrogate(text.charCodeAt(index + 1)))
      index += 1;
    else if (isHighSurrogate(unit) || isLowSurrogate(unit)) return false;
  }
  return true;
};

/** Replace unpaired surrogates with U+FFFD so the returned text is valid Unicode. */
const replaceUnpairedSurrogates = (text: string): string => {
  let result = "";
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (isHighSurrogate(unit) && isLowSurrogate(text.charCodeAt(index + 1))) {
      result += text.slice(index, index + 2);
      index += 1;
    } else
      result +=
        isHighSurrogate(unit) || isLowSurrogate(unit)
          ? "\uFFFD"
          : text.charAt(index);
  }
  return result;
};

/** Content-relative string start and the exclusive end of its pool. */
export interface PoolPosition {
  readonly start: number;
  readonly end: number;
}

/** Read a NUL-terminated UTF-16LE structural string inside its pool. */
export const readUtf16Terminated = (
  content: SectionContent,
  { start, end }: PoolPosition,
  budget: TextBudget,
  what: string,
): string => {
  if (start < 0 || end > content.length || start > end || (end - start) % 2)
    return priFailure(`${content.label} ${what} lies outside its string pool.`);
  let cursor = start;
  while (cursor < end && content.u16(cursor, what) !== 0) cursor += 2;
  if (cursor >= end)
    priFailure(`${content.label} ${what} has no NUL terminator in its pool.`);
  budget.consume((cursor - start) / 2, `${content.label} strings`);
  const text = content.bytes.toString(
    "utf16le",
    content.offset + start,
    content.offset + cursor,
  );
  if (!wellFormedUtf16(text))
    priFailure(`${content.label} ${what} is not well-formed UTF-16.`);
  return text;
};

/** Read a NUL-terminated 7-bit ASCII structural string inside its pool. */
export const readAsciiTerminated = (
  content: SectionContent,
  { start, end }: PoolPosition,
  budget: TextBudget,
  what: string,
): string => {
  if (start < 0 || end > content.length || start > end)
    return priFailure(`${content.label} ${what} lies outside its string pool.`);
  const first = content.offset + start;
  const terminator = content.bytes.indexOf(0, first);
  if (terminator === -1 || terminator >= content.offset + end)
    return priFailure(
      `${content.label} ${what} has no NUL terminator in its pool.`,
    );
  budget.consume(terminator - first, `${content.label} strings`);
  for (let at = first; at < terminator; at++)
    if ((content.bytes[at] ?? 0) > 0x7f)
      priFailure(`${content.label} ${what} contains a non-ASCII byte.`);
  return content.bytes.toString("latin1", first, terminator);
};

/** Text values longer than this many UTF-16 code units are returned as a prefix. */
export const VALUE_TEXT_UNITS = 65536;

export type ValueEncoding = "utf-16le" | "ascii" | "utf-8";

/** Drop a multi-byte UTF-8 sequence that a prefix cut before its last byte. */
const completeUtf8Prefix = (bytes: Buffer): Buffer => {
  let lead = bytes.length - 1;
  let continuation = 0;
  while (
    lead >= 0 &&
    ((bytes[lead] ?? 0) & 0xc0) === 0x80 &&
    continuation < 3
  ) {
    lead -= 1;
    continuation += 1;
  }
  const first = lead >= 0 ? (bytes[lead] ?? 0) : 0;
  const expected =
    first >= 0xf0 ? 3 : first >= 0xe0 ? 2 : first >= 0xc0 ? 1 : 0;
  return first >= 0xc0 && expected > continuation
    ? bytes.subarray(0, lead)
    : bytes;
};

/**
 * Decode one stored text value. A well-formed value is validly encoded and ends
 * with a NUL code unit, which is not part of the returned text.
 * Invalid code units become U+FFFD; `well_formed` is null when a prefix was
 * returned and the remainder was not examined.
 */
export const decodeValueText = (
  bytes: Buffer,
  encoding: ValueEncoding,
): { text: string; truncated: boolean; well_formed: boolean | null } => {
  const unit = encoding === "utf-16le" ? 2 : 1;
  const whole = bytes.length - (bytes.length % unit);
  const terminated =
    whole >= unit &&
    whole === bytes.length &&
    bytes.subarray(whole - unit, whole).every((byte) => byte === 0);
  const body = bytes.subarray(0, terminated ? whole - unit : whole);
  const truncated = body.length > unit * VALUE_TEXT_UNITS;
  const selected = truncated ? body.subarray(0, unit * VALUE_TEXT_UNITS) : body;
  if (encoding === "utf-16le") {
    let text = selected.toString("utf16le");
    if (truncated && isHighSurrogate(text.charCodeAt(text.length - 1)))
      text = text.slice(0, -1);
    const valid = wellFormedUtf16(text);
    return {
      text: valid ? text : replaceUnpairedSurrogates(text),
      truncated,
      well_formed: truncated ? null : terminated && valid,
    };
  }
  if (encoding === "ascii") {
    const valid = selected.every((byte) => byte <= 0x7f);
    return {
      text: valid
        ? selected.toString("latin1")
        : Array.from(selected, (byte) =>
            byte <= 0x7f ? String.fromCharCode(byte) : "\uFFFD",
          ).join(""),
      truncated,
      well_formed: truncated ? null : terminated && valid,
    };
  }
  const prefix = truncated ? completeUtf8Prefix(selected) : selected;
  try {
    return {
      text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        prefix,
      ),
      truncated,
      well_formed: truncated ? null : terminated,
    };
  } catch {
    return {
      text: new TextDecoder("utf-8", { ignoreBOM: true }).decode(prefix),
      truncated,
      well_formed: truncated ? null : false,
    };
  }
};
