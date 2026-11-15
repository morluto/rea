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

  /** Decode one C-string; escapes produce bytes, other characters UTF-8. */
  #cString(): Result<GdbMiValue, GdbMiRecordFailure> {
    const line = this.#line;
    const bytes: number[] = [];
    let index = this.#cursor + 1;
    while (index < line.length) {
      const character = line[index]!;
      if (character === '"') {
        this.#cursor = index + 1;
        return ok({ kind: "const", bytes: Uint8Array.from(bytes) });
      }
      if (character !== "\\") {
        const codePoint = line.codePointAt(index)!;
        if (codePoint < 0x20) {
          this.#cursor = index;
          return err(this.fail("unescaped control character in C-string"));
        }
        if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
          this.#cursor = index;
          return err(this.fail("lone surrogate in C-string"));
        }
        const text = String.fromCodePoint(codePoint);
        for (const byte of Buffer.from(text, "utf8")) bytes.push(byte);
        index += text.length;
        continue;
      }
      const escaped = line[index + 1];
      const simple =
        escaped === undefined ? undefined : SIMPLE_ESCAPES[escaped];
      if (simple !== undefined) {
        bytes.push(simple);
        index += 2;
        continue;
      }
      if (escaped === "x") {
        const hex = /^[0-9a-f]+/iu.exec(line.slice(index + 2))?.[0];
        if (hex === undefined) {
          this.#cursor = index;
          return err(this.fail("\\x escape without hex digits"));
        }
        bytes.push(Number.parseInt(hex.slice(-2), 16));
        index += 2 + hex.length;
        continue;
      }
      if (escaped !== undefined && escaped >= "0" && escaped <= "7") {
        const octal = /^[0-7]{1,3}/u.exec(line.slice(index + 1))![0];
        bytes.push(Number.parseInt(octal, 8) & 0xff);
        index += 1 + octal.length;
        continue;
      }
      this.#cursor = index;
      return err(this.fail("invalid C-string escape"));
    }
    this.#cursor = index;
    return err(this.fail("unterminated C-string"));
  }
}

/** Parse one complete MI result record line (without its newline). */
export const parseGdbMiResultRecord = (
  line: string,
): Result<GdbMiResultRecord, GdbMiRecordFailure> => new MiParser(line).record();

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
