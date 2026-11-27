import { Writable } from "node:stream";

import { Budget } from "../domain/budget.js";
import { decodeStrictUtf8, isStrictUtf8 } from "../domain/strictUtf8.js";
import { err, ok, type Result } from "../domain/result.js";
import type {
  YaraMeta,
  YaraRuleMatch,
  YaraStringMatch,
} from "../domain/yara/yaraMatches.js";

/** Output of `yara -s -L -m -g` for one scanned file, read once here. */
export interface YaraParsedMatches {
  readonly matches: readonly YaraRuleMatch[];
  /** Every string match yara reported, listed or not. */
  readonly stringMatches: number;
  readonly listedStringMatches: number;
}

/** Where yara stdout stopped matching its documented line grammar. */
export interface YaraOutputFailure {
  /** One-based stdout line number. */
  readonly line: number;
  readonly reason: string;
}

const NEWLINE = 0x0a;
const RULE_PREFIX =
  /^([A-Za-z_][A-Za-z0-9_]*) \[([A-Za-z0-9_,]*)\] \[(.*)\]$/su;
const STRING_LINE = /^0x([0-9a-f]+):(\d+):(\$[A-Za-z0-9_]*): (.*)$/su;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const DECIMAL = /^-?\d+$/u;

const safeInteger = (text: string, radix: 10 | 16): number | undefined => {
  const value = BigInt(radix === 16 ? `0x${text}` : text);
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : undefined;
};

/**
 * The escapes yara 4.x `cli/yara.c` `print_escaped_data` writes for a string
 * meta value (unchanged from v4.2.0 to v4.6.0): a backslash before a double
 * quote, a single quote or a backslash; the C escapes a, b, t, n, v, f and r
 * for bytes 0x07 to 0x0d; and a backslash with exactly three octal digits for
 * every other byte below 0x20 or at or above 0x7f.
 */
const META_ESCAPES: Readonly<Record<string, number>> = {
  '"': 0x22,
  "'": 0x27,
  "\\": 0x5c,
  a: 0x07,
  b: 0x08,
  t: 0x09,
  n: 0x0a,
  v: 0x0b,
  f: 0x0c,
  r: 0x0d,
};
const META_OCTAL_ESCAPE = /^[0-3][0-7]{2}/u;

/** Decode one quoted meta string as yara escapes it. */
const decodeMetaString = (
  text: string,
  start: number,
): { readonly bytes: Buffer; readonly end: number } | string => {
  const bytes: number[] = [];
  let index = start;
  while (index < text.length) {
    const char = text[index]!;
    if (char === '"') return { bytes: Buffer.from(bytes), end: index + 1 };
    if (char !== "\\") {
      bytes.push(char.charCodeAt(0));
      index += 1;
      continue;
    }
    const next = text[index + 1];
    const simple = next === undefined ? undefined : META_ESCAPES[next];
    if (simple !== undefined) {
      bytes.push(simple);
      index += 2;
      continue;
    }
    const octal = META_OCTAL_ESCAPE.exec(text.slice(index + 1, index + 4))?.[0];
    if (octal === undefined)
      return `unknown escape \\${next ?? ""} in a meta string`;
    bytes.push(Number.parseInt(octal, 8));
    index += 1 + octal.length;
  }
  return "unterminated meta string";
};

const metaValue = (identifier: string, bytes: Buffer): YaraMeta =>
  isStrictUtf8(bytes)
    ? {
        identifier,
        type: "string",
        value: decodeStrictUtf8(bytes, "preserve"),
      }
    : { identifier, type: "bytes", value: bytes.toString("hex") };

/** Parse the bracketed meta list of one rule line. */
export const parseYaraMeta = (text: string): YaraMeta[] | string => {
  const meta: YaraMeta[] = [];
  let index = 0;
  while (index < text.length) {
    // yara prints integer meta as `name =value` and the others as `name=value`.
    const equals = text.indexOf("=", index);
    if (equals === -1) return "meta entry without a value";
    const identifier = text.slice(index, equals).trimEnd();
    if (!IDENTIFIER.test(identifier))
      return `invalid meta identifier ${JSON.stringify(identifier)}`;
    let cursor = equals + 1;
    if (text[cursor] === '"') {
      const decoded = decodeMetaString(text, cursor + 1);
      if (typeof decoded === "string") return decoded;
      meta.push(metaValue(identifier, decoded.bytes));
      cursor = decoded.end;
    } else {
      const comma = text.indexOf(",", cursor);
      const token = text.slice(cursor, comma === -1 ? text.length : comma);
      if (token === "true" || token === "false")
        meta.push({ identifier, type: "boolean", value: token === "true" });
      else if (DECIMAL.test(token)) {
        const magnitude = safeInteger(token.replace(/^-/u, ""), 10);
        meta.push({
          identifier,
          type: "integer",
          value:
            magnitude === undefined
              ? token
              : token.startsWith("-")
                ? -magnitude
                : magnitude,
        });
      } else return `invalid meta value ${JSON.stringify(token)}`;
      cursor += token.length;
    }
    if (cursor === text.length) break;
    if (text[cursor] !== ",") return "meta entries are not comma separated";
    index = cursor + 1;
  }
  return meta;
};

interface OpenRule {
  readonly rule: string;
  readonly tags: string[];
  readonly meta: YaraMeta[];
  readonly strings: YaraStringMatch[];
  stringMatchCount: number;
}

/**
 * Incremental parser of one scan's stdout. Rule lines end with the scanned
 * path exactly as it was passed to yara, which keeps paths containing spaces
 * or brackets unambiguous. String matches beyond `maxListed` are counted but
 * not retained.
 */
export class YaraMatchOutputParser {
  readonly #suffix: Buffer;
  readonly #listing: Budget;
  readonly #pending: Buffer[] = [];
  readonly #matches: YaraRuleMatch[] = [];
  #open: OpenRule | undefined;
  #line = 0;
  #stringMatches = 0;
  #failure: YaraOutputFailure | undefined;

  constructor(scannedPath: string, maxListed: number) {
    this.#suffix = Buffer.from(` ${scannedPath}`, "utf8");
    this.#listing = new Budget(maxListed);
  }

  /** Accept one stdout chunk; a grammar failure is kept, never thrown. */
  push(chunk: Buffer): void {
    if (this.#failure !== undefined) return;
    let start = 0;
    for (
      let newline = chunk.indexOf(NEWLINE, start);
      newline !== -1;
      newline = chunk.indexOf(NEWLINE, start)
    ) {
      this.#pending.push(chunk.subarray(start, newline));
      const line = Buffer.concat(this.#pending);
      this.#pending.length = 0;
      start = newline + 1;
      this.#parseLine(line);
      if (this.#failure !== undefined) return;
    }
    if (start < chunk.length)
      this.#pending.push(Buffer.from(chunk.subarray(start)));
  }

  /** The parsed matches once stdout has ended. */
  finish(): Result<YaraParsedMatches, YaraOutputFailure> {
    if (this.#failure !== undefined) return err(this.#failure);
    if (this.#pending.some((part) => part.length > 0))
      return err({
        line: this.#line + 1,
        reason: "stdout ended inside a line",
      });
    this.#close();
    return ok({
      matches: this.#matches,
      stringMatches: this.#stringMatches,
      listedStringMatches: this.#listing.used,
    });
  }

  #parseLine(raw: Buffer): void {
    this.#line += 1;
    // yara on Windows writes CRLF line ends.
    const line = raw.at(-1) === 0x0d ? raw.subarray(0, -1) : raw;
    const fail = (reason: string) => {
      this.#failure = { line: this.#line, reason };
    };
    if (line.subarray(0, 2).toString("latin1") === "0x") {
      const parsed = STRING_LINE.exec(line.toString("latin1"));
      if (parsed === null) return fail("malformed string match line");
      if (this.#open === undefined)
        return fail("string match line before any rule line");
      const offset = safeInteger(parsed[1]!, 16);
      const length = safeInteger(parsed[2]!, 10);
      if (offset === undefined || length === undefined)
        return fail("string match offset or length exceeds the safe range");
      this.#open.stringMatchCount += 1;
      this.#stringMatches += 1;
      if (this.#listing.tryCharge(1))
        this.#open.strings.push({
          identifier: parsed[3]!,
          file_offset: offset,
          length,
          data: parsed[4]!,
        });
      return;
    }
    if (
      line.length <= this.#suffix.length ||
      !line.subarray(line.length - this.#suffix.length).equals(this.#suffix)
    )
      return fail("rule line does not name the scanned file");
    const prefix = line
      .subarray(0, line.length - this.#suffix.length)
      .toString("latin1");
    const parsed = RULE_PREFIX.exec(prefix);
    if (parsed === null) return fail("malformed rule line");
    const meta = parseYaraMeta(parsed[3]!);
    if (typeof meta === "string") return fail(meta);
    this.#close();
    this.#open = {
      rule: parsed[1]!,
      tags: parsed[2] === "" ? [] : parsed[2]!.split(","),
      meta,
      strings: [],
      stringMatchCount: 0,
    };
  }

  #close(): void {
    if (this.#open === undefined) return;
    const { rule, tags, meta, strings, stringMatchCount } = this.#open;
    this.#matches.push({
      rule,
      tags,
      meta,
      string_match_count: stringMatchCount,
      strings,
    });
    this.#open = undefined;
  }
}

/** A stdout sink that feeds one parser and never rejects a write. */
export const yaraMatchOutputSink = (parser: YaraMatchOutputParser): Writable =>
  new Writable({
    write(chunk: Buffer, _encoding, callback) {
      parser.push(chunk);
      callback();
    },
  });

/**
 * What a rule compile error means for the caller's repair. The kinds follow
 * libyara 4.x message text (`yr_compiler_get_error_message`); any other
 * message is `other` and keeps its text. Include errors cannot arise: rule
 * files with include directives are refused before yara starts.
 */
export type YaraCompileErrorKind =
  | "syntax"
  | "undefined"
  | "duplicate"
  | "unreadable_file"
  | "other";

/** One rule compile error; `source` is the file yara named. */
export interface YaraCompileError {
  readonly kind: YaraCompileErrorKind;
  /**
   * The file yara named, or `null` with `line: null` when the text cannot be
   * split into a file and line unambiguously; `message` then keeps it whole.
   */
  readonly source: string | null;
  readonly line: number | null;
  /** The rule yara named, when the error belongs to one. */
  readonly rule: string | null;
  readonly message: string;
}

/** Every diagnostic yara wrote to stderr, read once here. */
export interface YaraDiagnostics {
  readonly warnings: readonly string[];
  readonly compileErrors: readonly YaraCompileError[];
  readonly scanErrors: readonly {
    readonly path: string;
    readonly reason: string;
  }[];
  /** Lines that match none of the documented forms, kept verbatim. */
  readonly unrecognized: readonly string[];
}

// yara 4.x cli/yara.c print_compiler_error writes exactly two forms:
//   LEVEL: rule "RULE" in FILE(LINE): MESSAGE   (the error belongs to a rule)
//   FILE(LINE): LEVEL: MESSAGE                  (it does not)
// cli/common.c writes `error: could not open file: FILE` for a rule file it
// cannot open. FILE is the path passed to yara, after any NAMESPACE: prefix.
// A file name and a message can both contain `(N): `. A FILE yara was given
// is matched exactly. Any other FILE (yara names only files it was given, as
// rule files with includes are refused, so this is defensive) is split at
// every `(N): ` that leaves a complete diagnostic; one such split is the
// location, and several leave the location unknown.
const RULE_DIAGNOSTIC_PREFIX = /^(error|warning): rule "([^"]*)" in /u;
const LEVELS = ["error", "warning"] as const;
type YaraLevel = (typeof LEVELS)[number];
const LOCATION = /\((\d+)\): /gu;
const OPEN_ERROR = /^error: could not open file: (.+)$/u;
const BARE_WARNING = /^warning: .+$/u;

interface Located {
  readonly source: string;
  readonly line: number;
  readonly rest: string;
}

/** Every `FILE(LINE): REST` split of `text`; a FILE yara was given wins. */
const locations = (
  text: string,
  sources: readonly string[],
): readonly Located[] => {
  const all: Located[] = [];
  for (const match of text.matchAll(LOCATION)) {
    if (match.index === 0) continue;
    all.push({
      source: text.slice(0, match.index),
      line: Number(match[1]),
      rest: text.slice(match.index + match[0].length),
    });
  }
  const given = all.filter((candidate) => sources.includes(candidate.source));
  return given.length > 0 ? given.slice(0, 1) : all;
};

/** Classify one compiler message by the libyara text that produced it. */
export const yaraCompileErrorKind = (message: string): YaraCompileErrorKind =>
  message.startsWith("syntax error")
    ? "syntax"
    : /^(?:undefined (?:identifier|string) |unknown module )/u.test(message)
      ? "undefined"
      : message.startsWith("duplicated ")
        ? "duplicate"
        : "other";

/**
 * Classify yara stderr by line; scan errors must name the scanned path.
 * `ruleSources` are the rule file paths yara was given, matched exactly.
 */
export const parseYaraDiagnostics = (
  stderr: string,
  scannedPath: string,
  ruleSources: readonly string[] = [],
): YaraDiagnostics => {
  const scanError = `error scanning ${scannedPath}: `;
  const warnings: string[] = [];
  const compileErrors: YaraCompileError[] = [];
  const scanErrors: YaraDiagnostics["scanErrors"][number][] = [];
  const unrecognized: string[] = [];
  const record = (
    level: YaraLevel,
    rule: string | null,
    candidates: readonly {
      readonly located: Located;
      readonly message: string;
    }[],
    whole: string,
    raw: string,
  ): void => {
    if (level === "warning") {
      warnings.push(raw);
      return;
    }
    const only = candidates.length === 1 ? candidates[0] : undefined;
    const kinds = new Set(
      candidates.map(({ message }) => yaraCompileErrorKind(message)),
    );
    compileErrors.push(
      only === undefined
        ? {
            kind: kinds.size === 1 ? [...kinds][0]! : "other",
            source: null,
            line: null,
            rule,
            message: whole,
          }
        : {
            kind: yaraCompileErrorKind(only.message),
            source: only.located.source,
            line: only.located.line,
            rule,
            message: only.message,
          },
    );
  };
  const parse = (line: string): boolean => {
    const ruled = RULE_DIAGNOSTIC_PREFIX.exec(line);
    if (ruled !== null) {
      const text = line.slice(ruled[0].length);
      const candidates = locations(text, ruleSources)
        .filter(({ rest }) => rest !== "")
        .map((located) => ({ located, message: located.rest }));
      if (candidates.length === 0) return false;
      record(ruled[1] as YaraLevel, ruled[2]!, candidates, text, line);
      return true;
    }
    const candidates = locations(line, ruleSources).flatMap((located) => {
      const level = LEVELS.find((candidate) =>
        located.rest.startsWith(`${candidate}: `),
      );
      const message =
        level === undefined ? "" : located.rest.slice(level.length + 2);
      return level === undefined || message === ""
        ? []
        : [{ located, level, message }];
    });
    if (candidates.length === 0) return false;
    // A split that reads as an error keeps the line a compile error.
    const level = candidates.some(({ level }) => level === "error")
      ? "error"
      : "warning";
    record(level, null, candidates, line, line);
    return true;
  };
  for (const raw of stderr.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.trim() === "") continue;
    let match: RegExpExecArray | null;
    if (line.startsWith(scanError) && line.length > scanError.length)
      scanErrors.push({
        path: scannedPath,
        reason: line.slice(scanError.length),
      });
    else if (parse(line)) continue;
    else if ((match = OPEN_ERROR.exec(line)) !== null)
      compileErrors.push({
        kind: "unreadable_file",
        source: match[1]!,
        line: null,
        rule: null,
        message: "could not open file",
      });
    else if (BARE_WARNING.test(line)) warnings.push(line);
    else unrecognized.push(line);
  }
  return { warnings, compileErrors, scanErrors, unrecognized };
};
