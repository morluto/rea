import { posix, win32 } from "node:path";

/** Upper bound on a single buffered `include "..."` path before passing it through verbatim. */
const MAX_INCLUDE_PATH_BYTES = 64 * 1024;

type LexState =
  | "code"
  | "slash_pending"
  | "line_comment"
  | "block_comment"
  | "block_comment_star"
  | "string"
  | "string_escape"
  | "regex"
  | "regex_escape"
  | "include_ws"
  | "include_path";

const isIdentChar = (byte: number): boolean =>
  (byte >= 0x41 && byte <= 0x5a) ||
  (byte >= 0x61 && byte <= 0x7a) ||
  (byte >= 0x30 && byte <= 0x39) ||
  byte === 0x5f;

const isHorizSpace = (byte: number): boolean => byte === 0x20 || byte === 0x09;

const isWhitespace = (byte: number): boolean =>
  byte === 0x20 ||
  byte === 0x09 ||
  byte === 0x0a ||
  byte === 0x0d ||
  byte === 0x0c ||
  byte === 0x0b;

/**
 * YARA keywords that act as operators or expression prefixes, so a following
 * `/` begins a regex literal rather than numeric division.
 */
const REGEX_INTRO_KEYWORDS = new Set([
  "matches",
  "contains",
  "icontains",
  "startswith",
  "istartswith",
  "endswith",
  "iendswith",
  "iequals",
  "and",
  "or",
  "not",
  "defined",
  "in",
  "at",
]);

/** Streaming byte-preserving rewriter for relative YARA `include "..."` directives. */
export interface YaraIncludeRewriter {
  push(chunk: Buffer): Buffer;
  finish(): Buffer;
}

const isAsciiLetter = (byte: number): boolean =>
  (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a);

const isAbsoluteIncludeBytes = (
  rawBytes: readonly number[],
  platform: NodeJS.Platform,
): boolean => {
  const first = rawBytes[0];
  if (first === undefined) return false;
  if (platform !== "win32") return first === 0x2f;
  if (first === 0x2f || first === 0x5c) return true;
  return rawBytes.length >= 2 && isAsciiLetter(first) && rawBytes[1] === 0x3a;
};

/**
 * Resolve relative `include "..."` directives in a staged YARA rule file
 * against the caller-selected rule file's directory so YARA keeps the
 * original include lookup when compiling from an owned temporary snapshot.
 *
 * Operates on raw bytes to preserve non-UTF-8 content and exact line numbers,
 * and skips comments, double-quoted strings, and regex literals.
 */
export const createYaraIncludeRewriter = (
  sourcePath: string,
  platform: NodeJS.Platform,
): YaraIncludeRewriter => {
  const pathApi = platform === "win32" ? win32 : posix;
  const baseDir = pathApi.dirname(sourcePath);
  const baseDirPrefix =
    platform === "win32"
      ? /[\\/]$/u.test(baseDir)
        ? baseDir
        : `${baseDir}\\`
      : baseDir.endsWith("/")
        ? baseDir
        : `${baseDir}/`;
  // YARA's `<include>[^\"]+` lexer rule ends at the first quote and cannot
  // represent line breaks; pass through verbatim if unrepresentable.
  const baseDirPrefixBytes =
    baseDirPrefix.includes('"') || /[\r\n]/u.test(baseDirPrefix)
      ? null
      : Buffer.from(baseDirPrefix, "utf8");

  let state: LexState = "code";
  let ident = "";
  let identOverflow = false;
  let braceDepth = 0;
  let canStartRegex = true;
  let includePathBytes: number[] = [];

  const rewritePath = (rawBytes: readonly number[]): Buffer => {
    const rawBuffer = Buffer.from(rawBytes);
    if (rawBytes.length === 0 || isAbsoluteIncludeBytes(rawBytes, platform))
      return rawBuffer;
    if (platform !== "win32") {
      // Preserve raw filename bytes and POSIX `link/..` components by prefixing
      // the rule file's parent directory directly without lexical normalization.
      if (baseDirPrefixBytes === null) return rawBuffer;
      return Buffer.concat([baseDirPrefixBytes, rawBuffer]);
    }
    const raw = rawBuffer.toString("utf8");
    if (Buffer.from(raw, "utf8").equals(rawBuffer)) {
      const resolved = win32.resolve(baseDir, raw);
      if (resolved.includes('"') || /[\r\n]/u.test(resolved)) return rawBuffer;
      return Buffer.from(resolved, "utf8");
    }
    if (baseDirPrefixBytes === null) return rawBuffer;
    return Buffer.concat([baseDirPrefixBytes, rawBuffer]);
  };

  return {
    push(chunk: Buffer): Buffer {
      const out: number[] = [];
      const emit = (byte: number): void => {
        out.push(byte);
      };
      const emitBuffer = (bytes: Uint8Array | readonly number[]): void => {
        for (const byte of bytes) out.push(byte);
      };

      const processCodeByte = (byte: number): void => {
        if (ident.length > 0 && !isIdentChar(byte)) {
          const word = identOverflow ? "" : ident;
          ident = "";
          identOverflow = false;
          if (braceDepth === 0 && word === "include" && isHorizSpace(byte)) {
            emit(byte);
            canStartRegex = false;
            state = "include_ws";
            return;
          }
          canStartRegex = REGEX_INTRO_KEYWORDS.has(word);
        }
        if (isIdentChar(byte)) {
          emit(byte);
          if (!identOverflow) {
            if (ident.length < 16) ident += String.fromCharCode(byte);
            else identOverflow = true;
          }
          return;
        }
        if (byte === 0x2f) {
          emit(byte);
          state = "slash_pending";
          return;
        }
        if (byte === 0x22) {
          emit(byte);
          canStartRegex = false;
          state = "string";
          return;
        }
        if (byte === 0x7b) {
          braceDepth += 1;
          canStartRegex = true;
          emit(byte);
          return;
        }
        if (byte === 0x7d) {
          if (braceDepth > 0) braceDepth -= 1;
          canStartRegex = true;
          emit(byte);
          return;
        }
        emit(byte);
        if (!isWhitespace(byte)) {
          // `)` (0x29) and `]` (0x5d) end a value expression, so a following
          // `/` is numeric division; other punctuation (such as `(`, `,`, `=`,
          // operators) can precede a regex literal.
          canStartRegex = byte !== 0x29 && byte !== 0x5d;
        }
      };

      for (const byte of chunk) {
        switch (state) {
          case "code":
            processCodeByte(byte);
            break;
          case "slash_pending":
            if (byte === 0x2f) {
              emit(byte);
              state = "line_comment";
            } else if (byte === 0x2a) {
              emit(byte);
              state = "block_comment";
            } else if (canStartRegex) {
              canStartRegex = false;
              emit(byte);
              if (byte === 0x5c) state = "regex_escape";
              else if (byte === 0x0a) state = "code";
              else state = "regex";
            } else {
              canStartRegex = true;
              state = "code";
              processCodeByte(byte);
            }
            break;
          case "line_comment":
            emit(byte);
            if (byte === 0x0a) state = "code";
            break;
          case "block_comment":
            emit(byte);
            if (byte === 0x2a) state = "block_comment_star";
            break;
          case "block_comment_star":
            emit(byte);
            if (byte === 0x2f) state = "code";
            else if (byte !== 0x2a) state = "block_comment";
            break;
          case "string":
            emit(byte);
            if (byte === 0x5c) state = "string_escape";
            else if (byte === 0x22) state = "code";
            break;
          case "string_escape":
            emit(byte);
            state = "string";
            break;
          case "regex":
            emit(byte);
            if (byte === 0x5c) state = "regex_escape";
            else if (byte === 0x2f || byte === 0x0a) state = "code";
            break;
          case "regex_escape":
            emit(byte);
            state = byte === 0x0a ? "code" : "regex";
            break;
          case "include_ws":
            if (isHorizSpace(byte)) {
              emit(byte);
            } else if (byte === 0x22) {
              emit(byte);
              includePathBytes = [];
              state = "include_path";
            } else {
              state = "code";
              processCodeByte(byte);
            }
            break;
          case "include_path":
            if (byte === 0x22) {
              emitBuffer(rewritePath(includePathBytes));
              emit(byte);
              includePathBytes = [];
              state = "code";
            } else if (
              byte === 0x0a ||
              byte === 0x0d ||
              includePathBytes.length >= MAX_INCLUDE_PATH_BYTES
            ) {
              emitBuffer(includePathBytes);
              includePathBytes = [];
              emit(byte);
              state = "code";
            } else {
              includePathBytes.push(byte);
            }
            break;
        }
      }
      return Buffer.from(out);
    },

    finish(): Buffer {
      if (state === "include_path" && includePathBytes.length > 0) {
        const tail = Buffer.from(includePathBytes);
        includePathBytes = [];
        state = "code";
        return tail;
      }
      return Buffer.alloc(0);
    },
  };
};
