import { strictUtf8Decoder } from "../domain/strictUtf8.js";
import { malformedInput, ParseFailureError } from "../domain/parseFailure.js";
import { err, ok, type Result } from "../domain/result.js";

/**
 * One line, or the unterminated tail, reached the caller's byte ceiling: a
 * `limit` parse failure that also keeps the bytes observed when framing
 * stopped, which the transport error reports.
 */
export class Utf8NdjsonOversizeError extends ParseFailureError<"limit"> {
  constructor(
    readonly maximumBytes: number,
    readonly observedBytes: number,
  ) {
    super({
      kind: "limit",
      format: "ndjson",
      detail: `NDJSON line reached ${String(observedBytes)} bytes, above the ${String(maximumBytes)}-byte line limit`,
      limit: { name: "ndjson-line-bytes", maximum: maximumBytes },
    });
    this.name = "Utf8NdjsonOversizeError";
  }
}

/**
 * A line, or why framing stopped: bytes that are not UTF-8, or a line above
 * the ceiling. Failures are values, so they cannot be confused with a
 * consumer's exception.
 */
type Utf8NdjsonLine = Result<
  string,
  ParseFailureError<"malformed"> | Utf8NdjsonOversizeError
>;

/**
 * Frame socket bytes before decoding, so later malformed frames cannot erase
 * earlier lines. Every line is bounded: `maxLineBytes` is read on each push so
 * a runtime setting change applies to the next chunk.
 */
export class Utf8NdjsonLineBuffer {
  #buffer: Buffer = Buffer.alloc(0);
  #fragments: Buffer[] = [];
  #fragmentBytes = 0;
  #nextNewline = -1;
  readonly #maxLineBytes: () => number;
  readonly #decoder = strictUtf8Decoder("preserve");

  constructor(maxLineBytes: () => number) {
    this.#maxLineBytes = maxLineBytes;
  }

  /**
   * Yield each complete trimmed nonblank line; preserve unconsumed lines on
   * early return. A line that is not UTF-8 is yielded as a failure and ends
   * the iteration. A line or the tail still waiting for its LF above the
   * ceiling is yielded as `Utf8NdjsonOversizeError`, after discarding every
   * buffered byte, and ends the iteration.
   */
  *push(chunk: Buffer): Generator<Utf8NdjsonLine> {
    const maximumBytes = this.#maxLineBytes();
    this.#fragments.push(chunk);
    this.#fragmentBytes += chunk.length;
    if (!chunk.includes(10) && this.#nextNewline < 0) {
      const refused = this.#refuseTail(maximumBytes);
      if (refused !== undefined) yield err(refused);
      return;
    }
    this.#buffer = Buffer.concat([this.#buffer, ...this.#fragments]);
    this.#fragments = [];
    this.#fragmentBytes = 0;
    if (this.#nextNewline < 0) this.#nextNewline = this.#buffer.indexOf(10);
    while (this.#nextNewline >= 0) {
      if (this.#nextNewline > maximumBytes) {
        const observedBytes = this.#nextNewline;
        this.reset();
        yield err(new Utf8NdjsonOversizeError(maximumBytes, observedBytes));
        return;
      }
      const encodedLine = this.#buffer.subarray(0, this.#nextNewline);
      const rest = this.#buffer.subarray(this.#nextNewline + 1);
      // An empty view would keep the drained frame's allocation for the session.
      this.#buffer = rest.length === 0 ? Buffer.alloc(0) : rest;
      this.#nextNewline = this.#buffer.indexOf(10);
      const line = this.#decode(encodedLine);
      if (!line.ok) {
        yield line;
        return;
      }
      const trimmed = line.value.trim();
      if (trimmed.length > 0) yield ok(trimmed);
    }
    const refused = this.#refuseTail(maximumBytes);
    if (refused !== undefined) yield err(refused);
  }

  /** Validate the unfinished tail at EOF without treating it as a complete response. */
  finish(): Result<null, ParseFailureError<"malformed">> {
    const tail = this.#decode(
      Buffer.concat([this.#buffer, ...this.#fragments]),
    );
    return tail.ok ? ok(null) : tail;
  }

  #refuseTail(maximumBytes: number): Utf8NdjsonOversizeError | undefined {
    const pendingBytes = this.#buffer.length + this.#fragmentBytes;
    if (this.#nextNewline >= 0 || pendingBytes <= maximumBytes)
      return undefined;
    // Drop the refused bytes rather than retaining them until reconnect.
    this.reset();
    return new Utf8NdjsonOversizeError(maximumBytes, pendingBytes);
  }

  #decode(bytes: Buffer): Result<string, ParseFailureError<"malformed">> {
    try {
      return ok(this.#decoder.decode(bytes));
    } catch (cause: unknown) {
      if (!(cause instanceof TypeError)) throw cause;
      return err(
        malformedInput("ndjson", "NDJSON frame is not valid UTF-8", { cause }),
      );
    }
  }

  reset(): void {
    this.#buffer = Buffer.alloc(0);
    this.#fragments = [];
    this.#fragmentBytes = 0;
    this.#nextNewline = -1;
  }

  /** Bytes still held after complete lines are removed. An empty tail keeps no drained frame. */
  retainedTail(): {
    readonly pendingBytes: number;
    readonly backingBytes: number;
  } {
    const pendingBytes = this.#buffer.length + this.#fragmentBytes;
    const backingBytes =
      this.#buffer.buffer.byteLength +
      this.#fragments.reduce(
        (sum, fragment) => sum + fragment.buffer.byteLength,
        0,
      );
    return { pendingBytes, backingBytes };
  }
}
