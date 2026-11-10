/** Incrementally splits decoded newline-delimited JSON socket data into lines. */
export class DecodedNdjsonLineBuffer {
  #buffer = "";
  #fragments: string[] = [];
  #nextNewline = -1;

  /**
   * Consume a chunk and yield each complete, trimmed, nonblank line.
   * Unconsumed complete lines remain buffered if iteration stops early.
   */
  *push(chunk: string): Generator<string> {
    this.#fragments.push(chunk);
    if (!chunk.includes("\n") && this.#nextNewline < 0) return;
    this.#buffer += this.#fragments.join("");
    this.#fragments = [];

    if (this.#nextNewline < 0) this.#nextNewline = this.#buffer.indexOf("\n");
    while (this.#nextNewline >= 0) {
      const encodedLine = this.#buffer.slice(0, this.#nextNewline);
      this.#buffer = this.#buffer.slice(this.#nextNewline + 1);
      // Update before yielding: a consumer may stop with complete lines left.
      this.#nextNewline = this.#buffer.indexOf("\n");
      const line = encodedLine.trim();
      if (line.length > 0) yield line;
    }
  }

  /** Drop incomplete and unconsumed lines when a session closes. */
  reset(): void {
    this.#buffer = "";
    this.#fragments = [];
    this.#nextNewline = -1;
  }
}
