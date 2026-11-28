/**
 * Find the `include "..."` directives yara would act on in a rule file.
 *
 * yara opens an included file while it lexes, so its bytes are never part of
 * the hashed snapshot. This scanner follows libyara 4.x's flex lexer
 * (`libyara/lexer.l`, checked at v4.5.0) closely enough that every directive
 * yara's lexer starts is found:
 *
 * - `include[ \t]+\"` is an unqualified rule, so it fires anywhere the lexer
 *   is in its initial state, including inside a rule body, wherever a token
 *   starts.
 * - Flex picks the longest match, so `include` must begin a token: it is not
 *   part of a longer identifier (`xinclude`), a string identifier
 *   (`$include`, `#`, `@`, `!`), or a number with letters (`0xABinclude`
 *   ends the hex number before `include`; `0xinclude` is `0` then the
 *   identifier `xinclude`).
 * - Text strings (`"..."`, with backslash escapes), regular expressions (any
 *   bare `/`, with backslash escapes, closed by `/` and optional `i` then
 *   `s`), block comments and line comments are separate lexer states whose
 *   text is never a directive. Hex strings need no state of their own: their
 *   rule admits only hex digits, a few punctuation characters and comments, so
 *   it cannot span a directive.
 *
 * Where yara itself would stop with a syntax error (a line break inside a
 * string or regex), the scanner returns to the initial state. yara never
 * reaches the text after that error, so the scanner can only report more
 * directives than yara would act on, never fewer.
 */

import { decodeUtf8PreservingBomOrNull } from "../domain/strictUtf8.js";

/** One directive, located in the rule file's bytes. */
export interface YaraIncludeDirective {
  /** 1-based line, counting LF as yara does. */
  readonly line: number;
  /** 1-based byte column of the `i` in `include`. */
  readonly column: number;
  /**
   * The quoted path as UTF-8 text, or `null` when it is not valid UTF-8, is
   * longer than {@link MAX_RETAINED_PATH_BYTES}, or the file ends inside it.
   */
  readonly path: string | null;
}

export interface YaraIncludeScan {
  /** The first {@link MAX_RETAINED_DIRECTIVES} directives, in file order. */
  readonly directives: readonly YaraIncludeDirective[];
  /** Every directive found, including those not retained. */
  readonly total: number;
}

export interface YaraIncludeScanner {
  push(chunk: Uint8Array): void;
  finish(): YaraIncludeScan;
}

/** Directives retained per file; the rest are counted. */
export const MAX_RETAINED_DIRECTIVES = 32;
/** Path bytes retained per directive; a longer path is reported as `null`. */
export const MAX_RETAINED_PATH_BYTES = 1024;

type LexState =
  | "initial"
  | "identifier"
  | "prefixed_identifier"
  | "digits"
  | "zero_radix"
  | "hex_digits"
  | "oct_digits"
  | "unit"
  | "fraction_start"
  | "fraction"
  | "slash"
  | "line_comment"
  | "block_comment"
  | "block_comment_star"
  | "string"
  | "string_escape"
  | "regex"
  | "regex_escape"
  | "regex_flag_i"
  | "regex_flag_s"
  | "include_space"
  | "include_path";

const LF = 0x0a;
const SPACE = 0x20;
const TAB = 0x09;
const QUOTE = 0x22;
const SLASH = 0x2f;
const STAR = 0x2a;
const BACKSLASH = 0x5c;
const DOT = 0x2e;

const isLetter = (byte: number): boolean =>
  (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a);
const isDigit = (byte: number): boolean => byte >= 0x30 && byte <= 0x39;
const isOctDigit = (byte: number): boolean => byte >= 0x30 && byte <= 0x37;
const isHexDigit = (byte: number): boolean =>
  isDigit(byte) ||
  (byte >= 0x41 && byte <= 0x46) ||
  (byte >= 0x61 && byte <= 0x66);
/** `({letter}|{digit}|_)` in lexer.l. */
const isIdentifierChar = (byte: number): boolean =>
  isLetter(byte) || isDigit(byte) || byte === 0x5f;
/** String identifier prefixes: `$`, `#`, `@`, `!`. */
const isStringIdentifierPrefix = (byte: number): boolean =>
  byte === 0x24 || byte === 0x23 || byte === 0x40 || byte === 0x21;

const INCLUDE = [0x69, 0x6e, 0x63, 0x6c, 0x75, 0x64, 0x65]; // "include"

/** yara passes the path bytes through unchanged, so a BOM is path data. */
const decodePath = (bytes: readonly number[]): string | null =>
  decodeUtf8PreservingBomOrNull(Uint8Array.from(bytes));

export const createYaraIncludeScanner = (): YaraIncludeScanner => {
  let state: LexState = "initial";
  let line = 1;
  let column = 0;
  // The identifier being read and where it started; only its first eight
  // bytes are kept, which is enough to tell `include` from a longer word.
  let word: number[] = [];
  let wordLength = 0;
  let wordLine = 0;
  let wordColumn = 0;
  // The directive being read.
  let pending: { line: number; column: number } | undefined;
  let pathBytes: number[] = [];
  let pathOverflow = false;
  const directives: YaraIncludeDirective[] = [];
  let total = 0;

  const record = (path: string | null): void => {
    total += 1;
    if (pending !== undefined && directives.length < MAX_RETAINED_DIRECTIVES)
      directives.push({ line: pending.line, column: pending.column, path });
    pending = undefined;
    pathBytes = [];
    pathOverflow = false;
  };

  const isIncludeWord = (): boolean =>
    wordLength === INCLUDE.length &&
    word.every((byte, index) => byte === INCLUDE[index]);

  /** The byte at a token start in the initial state. */
  const initial = (byte: number): void => {
    if (isLetter(byte) || byte === 0x5f) {
      state = "identifier";
      word = [byte];
      wordLength = 1;
      wordLine = line;
      wordColumn = column;
      return;
    }
    if (isStringIdentifierPrefix(byte)) {
      state = "prefixed_identifier";
      return;
    }
    if (isDigit(byte)) {
      state = byte === 0x30 ? "zero_radix" : "digits";
      return;
    }
    if (byte === SLASH) {
      state = "slash";
      return;
    }
    if (byte === QUOTE) {
      state = "string";
      return;
    }
    state = "initial";
  };

  /** Starting an identifier on a letter that ended a number. */
  const identifierFrom = (byte: number): void => {
    state = "identifier";
    word = [byte];
    wordLength = 1;
    wordLine = line;
    wordColumn = column;
  };

  const step = (byte: number): void => {
    switch (state) {
      case "initial":
        initial(byte);
        return;
      case "identifier":
        if (isIdentifierChar(byte)) {
          if (word.length < 8) word.push(byte);
          wordLength += 1;
          return;
        }
        if ((byte === SPACE || byte === TAB) && isIncludeWord()) {
          pending = { line: wordLine, column: wordColumn };
          state = "include_space";
          return;
        }
        initial(byte);
        return;
      case "prefixed_identifier":
        if (isIdentifierChar(byte)) return;
        initial(byte);
        return;
      case "zero_radix":
        if (byte === 0x78 || byte === 0x6f) {
          // `0x` or `0o` needs a digit of its radix next; decided there.
          state = byte === 0x78 ? "hex_digits" : "oct_digits";
          wordLength = 0;
          word = [byte];
          wordLine = line;
          wordColumn = column;
          return;
        }
        state = "digits";
        step(byte);
        return;
      case "hex_digits":
      case "oct_digits": {
        const accepts = state === "hex_digits" ? isHexDigit : isOctDigit;
        if (accepts(byte)) {
          wordLength += 1;
          return;
        }
        if (wordLength === 0) {
          // No digit after `0x`/`0o`: the number was `0`, and the letter
          // starts an identifier that the current byte continues.
          identifierFrom(word[0]!);
          wordLine = line;
          wordColumn = column - 1;
          step(byte);
          return;
        }
        initial(byte);
        return;
      }
      case "digits":
        if (isDigit(byte)) return;
        if (byte === 0x4d || byte === 0x4b) {
          // `MB` or `KB` completes the number; otherwise the letter begins
          // an identifier.
          state = "unit";
          word = [byte];
          wordLine = line;
          wordColumn = column;
          return;
        }
        if (byte === DOT) {
          state = "fraction_start";
          return;
        }
        initial(byte);
        return;
      case "unit":
        if (byte === 0x42) {
          state = "initial";
          return;
        }
        identifierFrom(word[0]!);
        wordLine = line;
        wordColumn = column - 1;
        step(byte);
        return;
      case "fraction_start":
        if (isDigit(byte)) {
          state = "fraction";
          return;
        }
        // `5.` is `5` then `.`; the byte after the dot starts a token.
        initial(byte);
        return;
      case "fraction":
        if (isDigit(byte)) return;
        initial(byte);
        return;
      case "slash":
        if (byte === SLASH) {
          state = "line_comment";
          return;
        }
        if (byte === STAR) {
          state = "block_comment";
          return;
        }
        state = "regex";
        step(byte);
        return;
      case "line_comment":
        if (byte === LF) state = "initial";
        return;
      case "block_comment":
        if (byte === STAR) state = "block_comment_star";
        return;
      case "block_comment_star":
        if (byte === SLASH) state = "initial";
        else if (byte !== STAR) state = "block_comment";
        return;
      case "string":
        if (byte === BACKSLASH) state = "string_escape";
        else if (byte === QUOTE || byte === LF) state = "initial";
        return;
      case "string_escape":
        state = "string";
        return;
      case "regex":
        if (byte === BACKSLASH) state = "regex_escape";
        else if (byte === SLASH) state = "regex_flag_i";
        else if (byte === LF) state = "initial";
        return;
      case "regex_escape":
        state = byte === LF ? "initial" : "regex";
        return;
      case "regex_flag_i":
        if (byte === 0x69) state = "regex_flag_s";
        else if (byte === 0x73) state = "initial";
        else initial(byte);
        return;
      case "regex_flag_s":
        if (byte === 0x73) state = "initial";
        else initial(byte);
        return;
      case "include_space":
        if (byte === SPACE || byte === TAB) return;
        if (byte === QUOTE) {
          state = "include_path";
          pathBytes = [];
          pathOverflow = false;
          return;
        }
        // `include` was only an identifier.
        pending = undefined;
        initial(byte);
        return;
      case "include_path":
        if (byte === QUOTE) {
          record(pathOverflow ? null : decodePath(pathBytes));
          state = "initial";
          return;
        }
        if (pathBytes.length < MAX_RETAINED_PATH_BYTES) pathBytes.push(byte);
        else pathOverflow = true;
        return;
    }
  };

  return {
    push(chunk: Uint8Array): void {
      for (const byte of chunk) {
        column += 1;
        step(byte);
        if (byte === LF) {
          line += 1;
          column = 0;
        }
      }
    },
    finish(): YaraIncludeScan {
      // A directive whose path never closed was still started by yara's lexer.
      if (state === "include_path") record(null);
      state = "initial";
      return { directives: [...directives], total };
    },
  };
};
