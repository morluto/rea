/** A byte decoding failure, separate from exceptions raised by a line consumer. */
export class Utf8NdjsonDecodingError extends Error {
  constructor(cause: unknown) {
    super("NDJSON frame is not valid UTF-8", { cause });
  }
}

/** Frame socket bytes before decoding, so later malformed frames cannot erase earlier lines. */
export class Utf8NdjsonLineBuffer {
  #buffer: Buffer = Buffer.alloc(0);
  #fragments: Buffer[] = [];
  #nextNewline = -1;
  readonly #decoder = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  });

  /** Yield each complete trimmed nonblank line; preserve unconsumed lines on early return. */
  *push(chunk: Buffer): Generator<string> {
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
      const line = this.#decode(encodedLine).trim();
      if (line.length > 0) yield line;
    }
  }

  /** Validate the unfinished tail at EOF without treating it as a complete response. */
  finish(): void {
    this.#decode(Buffer.concat([this.#buffer, ...this.#fragments]));
  }

  #decode(bytes: Buffer): string {
    try {
      return this.#decoder.decode(bytes);
    } catch (cause: unknown) {
      if (!(cause instanceof TypeError)) throw cause;
      throw new Utf8NdjsonDecodingError(cause);
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
