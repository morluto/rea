import { isUtf8 } from "node:buffer";
import { err, ok, type Result } from "../domain/result.js";

/** GDB MI result classes (GDB manual, "GDB/MI Result Records"). */
export type GdbMiResultClass =
  | "done"
  | "running"
  | "connected"
  | "error"
  | "exit";

/** One MI value. A C-string constant keeps the bytes its escapes encode. */
export type GdbMiValue =
  | { readonly kind: "const"; readonly bytes: Uint8Array }
  | { readonly kind: "tuple"; readonly results: readonly GdbMiResult[] }
  | { readonly kind: "list"; readonly values: readonly GdbMiValue[] }
  | { readonly kind: "result-list"; readonly results: readonly GdbMiResult[] };

/** `variable=value` inside a record, tuple or list. */
export interface GdbMiResult {
  readonly name: string;
  readonly value: GdbMiValue;
}

/** A complete MI result record: `[token]^class(,result)*`. */
export interface GdbMiResultRecord {
  readonly token: string | undefined;
  readonly resultClass: GdbMiResultClass;
  readonly results: readonly GdbMiResult[];
}

/** A stream record: `~` console, `@` target or `&` log output. */
export interface GdbMiStreamRecord {
  readonly kind: "console" | "target" | "log";
  readonly value: GdbMiValue;
}

const STREAM_KINDS: Readonly<Record<string, GdbMiStreamRecord["kind"]>> = {
  "~": "console",
  "@": "target",
  "&": "log",
};

/** Why a line is not a well-formed MI result record. */
export interface GdbMiRecordFailure {
  readonly kind: "malformed-mi-record";
  readonly reason: string;
  /** UTF-16 offset in the line where parsing stopped. */
  readonly offset: number;
}

/** Bound parser recursion when a capped MI record contains extreme nesting. */
const MAX_GDB_MI_NESTED_VALUE_FRAMES = 256;

const SIMPLE_ESCAPES: Readonly<Record<string, number>> = {
  a: 7,
  b: 8,
  f: 12,
  n: 10,
  r: 13,
  t: 9,
  v: 11,
  "\\": 92,
  '"': 34,
  "'": 39,
  "?": 63,
};

const HEX_DIGITS = /[0-9a-f]+/iy;
const OCTAL_DIGITS = /[0-7]{1,3}/y;

const HEADER = /^(\d*)\^(done|running|connected|error|exit)(?=,|$)/u;

/**
 * Read only the token and class of a line shaped like a tokenized result
 * record. The stream dispatcher uses this to correlate replies; the record
 * body is parsed by `parseGdbMiResultRecord` where its results are consumed.
 */
export const gdbMiResultHeader = (
  line: string,
):
  | { readonly token: number; readonly resultClass: GdbMiResultClass }
  | undefined => {
  const match = HEADER.exec(line);
  if (match?.[1] === undefined || match[1] === "") return undefined;
  return {
    token: Number(match[1]),
    resultClass: match[2] as GdbMiResultClass,
  };
};

class MiParser {
  #cursor = 0;
  readonly #line: string;

  constructor(line: string) {
    this.#line = line;
  }

  get cursor(): number {
    return this.#cursor;
  }

  fail(reason: string): GdbMiRecordFailure {
    return { kind: "malformed-mi-record", reason, offset: this.#cursor };
  }

  record(): Result<GdbMiResultRecord, GdbMiRecordFailure> {
    const header = HEADER.exec(this.#line);
    if (header === null)
      return err(this.fail("line is not an MI result record"));
    const token = header[1] === "" ? undefined : header[1];
    const resultClass = header[2] as GdbMiResultClass;
    this.#cursor = header[0].length;
    const results: GdbMiResult[] = [];
    while (this.#cursor < this.#line.length) {
      if (this.#line[this.#cursor] !== ",")
        return err(this.fail("expected ',' between results"));
      this.#cursor += 1;
      const result = this.#result(0);
      if (!result.ok) return result;
      results.push(result.value);
    }
    return ok({ token, resultClass, results });
  }

  stream(): Result<GdbMiStreamRecord, GdbMiRecordFailure> {
    const kind = STREAM_KINDS[this.#line[0] ?? ""];
    if (kind === undefined || this.#line[1] !== '"')
      return err(this.fail("line is not an MI stream record"));
    this.#cursor = 1;
    const text = this.#cString();
    if (!text.ok) return text;
    if (this.#cursor !== this.#line.length)
      return err(this.fail("text after the stream record's C-string"));
    return ok({ kind, value: text.value });
  }

  #isNameCharacter(character: string | undefined): boolean {
    return (
      character !== undefined &&
      !/[=,{}[\]"\s]/u.test(character) &&
      character.charCodeAt(0) >= 0x20
    );
  }

  #name(): string | undefined {
    const start = this.#cursor;
    while (this.#isNameCharacter(this.#line[this.#cursor])) this.#cursor += 1;
    if (this.#cursor === start || this.#line[this.#cursor] !== "=") {
      this.#cursor = start;
      return undefined;
    }
    const name = this.#line.slice(start, this.#cursor);
    this.#cursor += 1;
    return name;
  }

  #result(depth: number): Result<GdbMiResult, GdbMiRecordFailure> {
    const name = this.#name();
    if (name === undefined) return err(this.fail("expected variable="));
    const value = this.#value(depth);
    return value.ok ? ok({ name, value: value.value }) : value;
  }

  #value(depth: number): Result<GdbMiValue, GdbMiRecordFailure> {
    const character = this.#line[this.#cursor];
    if (character === '"') return this.#cString();
    if (character !== "{" && character !== "[")
      return err(this.fail("expected a C-string, tuple or list"));
    if (depth >= MAX_GDB_MI_NESTED_VALUE_FRAMES)
      return err(this.fail("MI value nesting exceeds the parser bound"));
    this.#cursor += 1;
    const close = character === "{" ? "}" : "]";
    if (this.#line[this.#cursor] === close) {
      this.#cursor += 1;
      return ok(
        character === "{"
          ? { kind: "tuple", results: [] }
          : { kind: "list", values: [] },
      );
    }
    if (character === "{") {
      const results = this.#sequence(close, () => this.#result(depth + 1));
      return results.ok
        ? ok({ kind: "tuple", results: results.value })
        : results;
    }
    // A list holds only values or only results; the first item decides.
    const start = this.#cursor;
    const listOfResults = this.#name() !== undefined;
    this.#cursor = start;
    if (listOfResults) {
      const results = this.#sequence(close, () => this.#result(depth + 1));
      return results.ok
        ? ok({ kind: "result-list", results: results.value })
        : results;
    }
    const values = this.#sequence(close, () => this.#value(depth + 1));
    return values.ok ? ok({ kind: "list", values: values.value }) : values;
  }

  #sequence<T>(
    close: "}" | "]",
    item: () => Result<T, GdbMiRecordFailure>,
  ): Result<T[], GdbMiRecordFailure> {
    const items: T[] = [];
    while (true) {
      const next = item();
      if (!next.ok) return next;
      items.push(next.value);
      const separator = this.#line[this.#cursor];
      this.#cursor += 1;
      if (separator === close) return ok(items);
      if (separator !== ",") {
        this.#cursor -= 1;
        return err(this.fail(`expected ',' or '${close}'`));
      }
    }
  }

  /**
   * Decode one C-string; escapes produce bytes, other characters UTF-8. Runs
   * of unescaped characters are validated in place and encoded once.
   */
  #cString(): Result<GdbMiValue, GdbMiRecordFailure> {
    const line = this.#line;
    const chunks: Uint8Array[] = [];
    let escaped: number[] = [];
    let index = this.#cursor + 1;
    let runStart = index;
    const flushEscaped = (): void => {
      if (escaped.length === 0) return;
      chunks.push(Uint8Array.from(escaped));
      escaped = [];
    };
    const flushRun = (): void => {
      if (index === runStart) return;
      flushEscaped();
      chunks.push(Buffer.from(line.slice(runStart, index), "utf8"));
    };
    const failAt = (at: number, reason: string) => {
      this.#cursor = at;
      return err(this.fail(reason));
    };
    while (index < line.length) {
      const code = line.charCodeAt(index);
      if (code === 0x22) {
        flushRun();
        flushEscaped();
        this.#cursor = index + 1;
        const joined = Buffer.concat(chunks);
        return ok({
          kind: "const",
          bytes: new Uint8Array(
            joined.buffer,
            joined.byteOffset,
            joined.byteLength,
          ),
        });
      }
      if (code !== 0x5c) {
        if (code < 0x20)
          return failAt(index, "unescaped control character in C-string");
        if (code >= 0xd800 && code <= 0xdbff) {
          const low = line.charCodeAt(index + 1);
          if (!(low >= 0xdc00 && low <= 0xdfff))
            return failAt(index, "lone surrogate in C-string");
          index += 2;
          continue;
        }
        if (code >= 0xdc00 && code <= 0xdfff)
          return failAt(index, "lone surrogate in C-string");
        index += 1;
        continue;
      }
      flushRun();
      const escape = line[index + 1];
      const simple = escape === undefined ? undefined : SIMPLE_ESCAPES[escape];
      if (simple !== undefined) {
        escaped.push(simple);
        index += 2;
      } else if (escape === "x") {
        HEX_DIGITS.lastIndex = index + 2;
        const hex = HEX_DIGITS.exec(line)?.[0];
        if (hex === undefined)
          return failAt(index, "\\x escape without hex digits");
        escaped.push(Number.parseInt(hex.slice(-2), 16));
        index += 2 + hex.length;
      } else if (escape !== undefined && escape >= "0" && escape <= "7") {
        OCTAL_DIGITS.lastIndex = index + 1;
        const octal = OCTAL_DIGITS.exec(line)![0];
        escaped.push(Number.parseInt(octal, 8) & 0xff);
        index += 1 + octal.length;
      } else return failAt(index, "invalid C-string escape");
      runStart = index;
    }
    return failAt(index, "unterminated C-string");
  }
}

/** Parse one complete MI result record line (without its newline). */
export const parseGdbMiResultRecord = (
  line: string,
): Result<GdbMiResultRecord, GdbMiRecordFailure> => new MiParser(line).record();

/** Parse one complete MI stream record line (without its newline). */
export const parseGdbMiStreamRecord = (
  line: string,
): Result<GdbMiStreamRecord, GdbMiRecordFailure> => new MiParser(line).stream();

/**
 * Parse a tokenized `^done` record. Any other class, an untokenized record and
 * a malformed record are refusals; the failure says which.
 */
export const parseGdbMiDoneRecord = (
  line: string,
): Result<GdbMiResultRecord, GdbMiRecordFailure> => {
  const parsed = parseGdbMiResultRecord(line);
  if (!parsed.ok) return parsed;
  if (parsed.value.token === undefined)
    return err({
      kind: "malformed-mi-record",
      reason: "result record has no token",
      offset: 0,
    });
  if (parsed.value.resultClass !== "done")
    return err({
      kind: "malformed-mi-record",
      reason: `result class is ${parsed.value.resultClass}, not done`,
      offset: 0,
    });
  return parsed;
};

/** The text of a C-string constant, or undefined if it is not strict UTF-8. */
export const gdbMiConstText = (value: GdbMiValue): string | undefined =>
  value.kind === "const" && isUtf8(value.bytes)
    ? Buffer.from(value.bytes).toString("utf8")
    : undefined;

/** Every result named `name` in a result sequence. */
export const gdbMiResultsNamed = (
  results: readonly GdbMiResult[],
  name: string,
): readonly GdbMiValue[] =>
  results.flatMap((result) => (result.name === name ? [result.value] : []));
