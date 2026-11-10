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
] as const;

/**
 * NeXTSTEP character encoding mapping table for octal bytes 0x80 (128) to 0xFF (255)
 * defined by Apple CoreFoundation CFOldStylePList / CFBuiltinConverters.
 */
const NEXT_STEP_LATIN_TABLE: readonly number[] = [
  0x00a0, 0x00c0, 0x00c1, 0x00c2, 0x00c3, 0x00c4, 0x00c5, 0x00c7, 0x00c8,
  0x00c9, 0x00ca, 0x00cb, 0x00cc, 0x00cd, 0x00ce, 0x00cf, 0x00d0, 0x00d1,
  0x00d2, 0x00d3, 0x00d4, 0x00d5, 0x00d6, 0x00d9, 0x00da, 0x00db, 0x00dc,
  0x00dd, 0x00de, 0x00b5, 0x00d7, 0x00f7, 0x00a9, 0x00a1, 0x00a2, 0x00a3,
  0x2044, 0x00a5, 0x0192, 0x00a7, 0x00a4, 0x2019, 0x201c, 0x00ab, 0x2039,
  0x203a, 0xfb01, 0xfb02, 0x00ae, 0x2013, 0x2020, 0x2021, 0x00b7, 0x00a6,
  0x00b6, 0x2022, 0x201a, 0x201e, 0x201d, 0x00bb, 0x2026, 0x2030, 0x00ac,
  0x00bf, 0x00b9, 0x02cb, 0x00b4, 0x02c6, 0x02dc, 0x00af, 0x02d8, 0x02d9,
  0x00a8, 0x00b2, 0x02da, 0x00b8, 0x00b3, 0x02dd, 0x02db, 0x02c7, 0x2014,
  0x00b1, 0x00bc, 0x00bd, 0x00be, 0x00e0, 0x00e1, 0x00e2, 0x00e3, 0x00e4,
  0x00e5, 0x00e7, 0x00e8, 0x00e9, 0x00ea, 0x00eb, 0x00ec, 0x00c6, 0x00ed,
  0x00aa, 0x00ee, 0x00ef, 0x00f0, 0x00f1, 0x0141, 0x00d8, 0x0152, 0x00ba,
  0x00f2, 0x00f3, 0x00f4, 0x00f5, 0x00f6, 0x00e6, 0x00f9, 0x00fa, 0x00fb,
  0x0131, 0x00fc, 0x00fd, 0x0142, 0x00f8, 0x0153, 0x00df, 0x00fe, 0x00ff,
  0xfffd, 0xfffd,
];

/**
 * Decode OpenStep quoted string escape sequences according to Apple CoreFoundation CFOldStylePList:
 * supports \a, \b, \f, \n, \r, \t, \v, \", \\, \Uxxxx (4-hex unicode), and \ooo (1-3 octal digits in NeXTSTEP encoding).
 */
export const decodeOpenStepQuotedString = (token: string): string => {
  // Validate token syntax with pinned parser to preserve parser error diagnosis.
  parseOpenStep(token);
  const content = token.slice(1, -1);
  let result = "";
  let i = 0;
  while (i < content.length) {
    const ch = content[i]!;
    if (ch !== "\\") {
      result += ch;
      i += 1;
      continue;
    }
    i += 1;
    if (i >= content.length) break;
    const esc = content[i]!;
    i += 1;
    switch (esc) {
      case "a":
        result += "\u0007";
        break;
      case "b":
        result += "\b";
        break;
      case "f":
        result += "\f";
        break;
      case "n":
        result += "\n";
        break;
      case "r":
        result += "\r";
        break;
      case "t":
        result += "\t";
        break;
      case "v":
        result += "\v";
        break;
      case '"':
        result += '"';
        break;
      case "\\":
        result += "\\";
        break;
      case "\n":
        result += "\n";
        break;
      case "U": {
        let num = 0;
        let digits = 0;
        while (digits < 4 && i < content.length) {
          const hexChar = content[i]!;
          if (/^[0-9a-fA-F]$/.test(hexChar)) {
            num = (num << 4) | parseInt(hexChar, 16);
            i += 1;
            digits += 1;
          } else {
            break;
          }
        }
        if (num >= 0xd800 && num <= 0xdbff) {
          if (content[i] === "\\" && content[i + 1] === "U") {
            let lowNum = 0;
            let lowDigits = 0;
            let j = i + 2;
            while (lowDigits < 4 && j < content.length) {
              const hexChar = content[j]!;
              if (/^[0-9a-fA-F]$/.test(hexChar)) {
                lowNum = (lowNum << 4) | parseInt(hexChar, 16);
                j += 1;
                lowDigits += 1;
              } else {
                break;
              }
            }
            if (lowDigits === 4 && lowNum >= 0xdc00 && lowNum <= 0xdfff) {
              i = j;
              result += String.fromCharCode(num, lowNum);
              break;
            }
          }
          result += "\ufffd";
        } else if (num >= 0xdc00 && num <= 0xdfff) {
          result += "\ufffd";
        } else {
          result += String.fromCharCode(num);
        }
        break;
      }
      case "0":
      case "1":
      case "2":
      case "3":
      case "4":
      case "5":
      case "6":
      case "7": {
        let num = esc.charCodeAt(0) - 48;
        for (let j = 0; j < 2; j += 1) {
          if (i < content.length) {
            const octChar = content[i]!;
            if (octChar >= "0" && octChar <= "7") {
              num = ((num << 3) + (octChar.charCodeAt(0) - 48)) & 0xff;
              i += 1;
            } else {
              break;
            }
          }
        }
        if (num < 0x80) {
          result += String.fromCharCode(num);
        } else {
          const codePoint = NEXT_STEP_LATIN_TABLE[num - 0x80];
          result +=
            codePoint !== undefined ? String.fromCharCode(codePoint) : "\ufffd";
        }
        break;
      }
      default:
        result += esc;
        break;
    }
  }
  return result;
};

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
 * The pinned scalar decoder retains its quoted escape and hexadecimal semantics.
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
    if (character === '"') {
      return decodeOpenStepQuotedString(token);
    }
    return character === "<" ? parseOpenStep(token) : token;
  };
  // The pinned format reads one root and leaves all trailing source untouched.
  return value(0);
};
