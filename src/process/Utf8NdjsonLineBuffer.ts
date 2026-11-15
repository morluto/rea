import {
  malformedInput,
  type ParseFailureError,
} from "../domain/parseFailure.js";
import { err, ok, type Result } from "../domain/result.js";

/** A frame that is not UTF-8; a value, so it cannot be confused with a consumer's exception. */
type Utf8NdjsonLine = Result<string, ParseFailureError<"malformed">>;

/** Frame socket bytes before decoding, so later malformed frames cannot erase earlier lines. */
export class Utf8NdjsonLineBuffer {
  #buffer: Buffer = Buffer.alloc(0);
  #fragments: Buffer[] = [];
  #nextNewline = -1;
  readonly #decoder = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  });

  /**
   * Yield each complete trimmed nonblank line; preserve unconsumed lines on
   * early return. A line that is not UTF-8 is yielded as a failure and ends
   * the iteration.
   */
  *push(chunk: Buffer): Generator<Utf8NdjsonLine> {
    this.#fragments.push(chunk);
    if (!chunk.includes(10) && this.#nextNewline < 0) return;
    this.#buffer = Buffer.concat([this.#buffer, ...this.#fragments]);
    this.#fragments = [];
    if (this.#nextNewline < 0) this.#nextNewline = this.#buffer.indexOf(10);
    while (this.#nextNewline >= 0) {
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
  }

  /** Validate the unfinished tail at EOF without treating it as a complete response. */
  finish(): Result<null, ParseFailureError<"malformed">> {
    const tail = this.#decode(
      Buffer.concat([this.#buffer, ...this.#fragments]),
    );
    return tail.ok ? ok(null) : tail;
  }

  #decode(bytes: Buffer): Utf8NdjsonLine {
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
    this.#nextNewline = -1;
  }

  /** Bytes still held after complete lines are removed. An empty tail keeps no drained frame. */
  retainedTail(): {
    readonly pendingBytes: number;
    readonly backingBytes: number;
  } {
    const pendingBytes =
      this.#buffer.length +
      this.#fragments.reduce((sum, fragment) => sum + fragment.length, 0);
    const backingBytes =
      this.#buffer.buffer.byteLength +
      this.#fragments.reduce(
        (sum, fragment) => sum + fragment.buffer.byteLength,
        0,
      );
    return { pendingBytes, backingBytes };
  }
}
