import { parseOpenStep } from "plist";

import { MAX_PLIST_DEPTH, PlistNestingLimitError } from "./apple/plistValue.js";
import { markPlistDictionary } from "./apple/plistUid.js";

const OPEN_STEP_SYNTAX_CODES = [
  "unterminated_block_comment",
  "unexpected_end",
  "unterminated_dictionary",
  "expected_equals",
  "unterminated_array",
  "expected_separator",
  "unexpected_character",
  "invalid_octal_escape",
] as const;

export type OpenStepPropertyListCode = (typeof OPEN_STEP_SYNTAX_CODES)[number];

/** OpenStep syntax refusal. `code` is the contract; `position` is the source offset. */
export class OpenStepPropertyListError extends Error {
  readonly _tag = "OpenStepPropertyListError";

  constructor(
    readonly code: OpenStepPropertyListCode,
    readonly position?: number,
  ) {
    super(code);
    this.name = "OpenStepPropertyListError";
  }
}

/** Locate the first value for the XML owner's existing OpenStep autodetection. */
export const startsOpenStepPropertyList = (text: string): boolean => {
  const cursor = skipTrivia(text, 0, false);
  return text[cursor] === "{" || text[cursor] === "(";
};

const skipTrivia = (text: string, start: number, strict = true): number => {
  let cursor = start;
  while (cursor < text.length) {
    if (/\s/u.test(text[cursor]!)) cursor += 1;
    else if (text.startsWith("//", cursor)) {
      cursor += 2;
      // CoreFoundation line comments end at LF, CR, LS or PS. Do not consume
      // subsequent data merely because the producer used another line ending.
      while (
        cursor < text.length &&
        !"\n\r\u2028\u2029".includes(text[cursor]!)
      )
        cursor += 1;
    } else if (text.startsWith("/*", cursor)) {
      const end = text.indexOf("*/", cursor + 2);
      if (end < 0) {
        if (strict)
          throw new OpenStepPropertyListError(
            "unterminated_block_comment",
            cursor,
          );
        return text.length;
      }
      cursor = end + 2;
    } else break;
  }
  return cursor;
};

/**
 * Own OpenStep containers, source depth and dictionary members together.
 * Quoted strings use Foundation escape semantics; hex data stays with plist.
 */
export const decodeOpenStepPropertyList = (
  text: string,
  maximumDepth = MAX_PLIST_DEPTH,
): unknown => {
  let cursor = 0;
  const trivia = () => {
    cursor = skipTrivia(text, cursor);
  };
  const assertDepth = (depth: number) => {
    if (depth > maximumDepth) throw new PlistNestingLimitError(maximumDepth);
  };
  const value = (depth: number, dictionaryKey = false): unknown => {
    trivia();
    if (cursor >= text.length)
      throw new OpenStepPropertyListError("unexpected_end", cursor);
    const character = text[cursor]!;
    if (character === "{") {
      assertDepth(depth);
      cursor += 1;
      const dictionary: Record<string, unknown> = {};
      markPlistDictionary(dictionary);
      while (true) {
        trivia();
        if (cursor >= text.length)
          throw new OpenStepPropertyListError(
            "unterminated_dictionary",
            cursor,
          );
        if (text[cursor] === "}") {
          cursor += 1;
          return dictionary;
        }
        const key = value(depth + 1, true);
        trivia();
        if (text[cursor] !== "=")
          throw new OpenStepPropertyListError("expected_equals", cursor);
        cursor += 1;
        const entry = value(depth + 1);
        Object.defineProperty(dictionary, String(key), {
          value: entry,
          enumerable: true,
          configurable: true,
          writable: true,
        });
        trivia();
        if (text[cursor] === ";") cursor += 1;
      }
    }
    if (character === "(") {
      assertDepth(depth);
      cursor += 1;
      const array: unknown[] = [];
      trivia();
      if (text[cursor] === ")") {
        cursor += 1;
        return array;
      }
      while (true) {
        array.push(value(depth + 1));
        trivia();
        if (cursor >= text.length)
          throw new OpenStepPropertyListError("unterminated_array", cursor);
        if (text[cursor] === ")") {
          cursor += 1;
          return array;
        }
        if (text[cursor] !== ",")
          throw new OpenStepPropertyListError("expected_separator", cursor);
        cursor += 1;
        trivia();
        if (text[cursor] === ")") {
          cursor += 1;
          return array;
        }
      }
    }
    const start = cursor;
    if (character === '"') {
      cursor += 1;
      while (cursor < text.length) {
        const next = text[cursor]!;
        cursor += next === "\\" ? 2 : 1;
        if (next === '"') break;
      }
    } else if (character === "<") {
      const end = text.indexOf(">", cursor + 1);
      cursor = end < 0 ? text.length : end + 1;
    } else {
      while (cursor < text.length && /[a-zA-Z0-9._/$:-]/u.test(text[cursor]!))
        cursor += 1;
      if (cursor === start)
        throw new OpenStepPropertyListError("unexpected_character", cursor);
    }
    // Scalar dictionary keys do not add source-value nesting; compound keys do.
    if (!dictionaryKey) assertDepth(depth);
    const token = text.slice(start, cursor);
    if (character === '"') return decodeQuotedString(token, start);
    return character === "<" ? parseOpenStep(token) : token;
  };
  // The pinned format reads one root and leaves all trailing source untouched.
  return value(0);
};

// NeXTSTEP octets 0x80..0xfd, verified against CoreFoundation's old-style
// plist reader. Octal escapes are neither UTF-8 sequences nor Latin-1.
const NEXTSTEP_HIGH_CHARACTERS =
  "\u00a0ÀÁÂÃÄÅÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖÙÚÛÜÝÞµ×÷" +
  "©¡¢£⁄¥ƒ§¤’“«‹›ﬁﬂ®–†‡·¦¶•‚„”»…‰¬¿" +
  "¹ˋ´ˆ˜¯˘˙¨²˚¸³˝˛ˇ—±¼½¾àáâãäåçèéêë" +
  "ìÆíªîïðñŁØŒºòóôõöæùúûıüýłøœßþÿ";

const QUOTED_CONTROL_ESCAPES: Readonly<Record<string, string>> = {
  a: "\u0007",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
};

/** Decode keys and values once, after the existing scalar syntax validation. */
const decodeQuotedString = (token: string, sourceStart: number): string => {
  const pinned = parseOpenStep(token) as string;
  if (!token.includes("\\")) return pinned;
  return token
    .slice(1, -1)
    .replace(
      /\\(?:U([\da-fA-F]{0,4})|([0-7]{1,3})|([\s\S]))/gu,
      (
        _escape,
        unicode: string | undefined,
        octal: string | undefined,
        character: string | undefined,
        offset: number,
      ) => {
        if (unicode !== undefined)
          return String.fromCharCode(Number.parseInt(unicode || "0", 16));
        if (octal !== undefined) {
          // Foundation accumulates at most three octal digits into one octet.
          const octet = Number.parseInt(octal, 8) & 0xff;
          if (octet < 0x80) return String.fromCharCode(octet);
          const decoded = NEXTSTEP_HIGH_CHARACTERS[octet - 0x80];
          if (decoded === undefined)
            throw new OpenStepPropertyListError(
              "invalid_octal_escape",
              sourceStart + 1 + offset,
            );
          return decoded;
        }
        return QUOTED_CONTROL_ESCAPES[character!] ?? character!;
      },
    );
};
