/** A byte decoding failure, separate from exceptions raised by a line consumer. */
export class Utf8NdjsonDecodingError extends Error {
  constructor(cause: unknown) {
    super("NDJSON frame is not valid UTF-8", { cause });
  }
}

/** One line, or the unterminated tail, reached the caller's byte ceiling. */
export class Utf8NdjsonOversizeError extends Error {
  constructor(
    readonly maximumBytes: number,
    readonly observedBytes: number,
  ) {
    super(
      `NDJSON line reached ${String(observedBytes)} bytes, above the ${String(maximumBytes)}-byte line limit`,
    );
  }
}

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
  readonly #decoder = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  });

  constructor(maxLineBytes: () => number) {
    this.#maxLineBytes = maxLineBytes;
  }

  /**
   * Yield each complete trimmed nonblank line; preserve unconsumed lines on
   * early return. Throws `Utf8NdjsonOversizeError`, after discarding every
   * buffered byte, when a line or the tail still waiting for its LF exceeds
   * the ceiling.
   */
  *push(chunk: Buffer): Generator<string> {
    const maximumBytes = this.#maxLineBytes();
    this.#fragments.push(chunk);
    this.#fragmentBytes += chunk.length;
    if (!chunk.includes(10) && this.#nextNewline < 0) {
      this.#refuseTail(maximumBytes);
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
        throw new Utf8NdjsonOversizeError(maximumBytes, observedBytes);
      }
      const encodedLine = this.#buffer.subarray(0, this.#nextNewline);
      const rest = this.#buffer.subarray(this.#nextNewline + 1);
      // An empty view would keep the drained frame's allocation for the session.
      this.#buffer = rest.length === 0 ? Buffer.alloc(0) : rest;
      this.#nextNewline = this.#buffer.indexOf(10);
      const line = this.#decode(encodedLine).trim();
      if (line.length > 0) yield line;
    }
    this.#refuseTail(maximumBytes);
  }

  /** Validate the unfinished tail at EOF without treating it as a complete response. */
  finish(): void {
    this.#decode(Buffer.concat([this.#buffer, ...this.#fragments]));
  }

  #refuseTail(maximumBytes: number): void {
    const pendingBytes = this.#buffer.length + this.#fragmentBytes;
    if (this.#nextNewline >= 0 || pendingBytes <= maximumBytes) return;
    // Drop the refused bytes rather than retaining them until reconnect.
    this.reset();
    throw new Utf8NdjsonOversizeError(maximumBytes, pendingBytes);
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
