/** Callbacks for one bounded newline-delimited Ghidra response stream. */
export interface GhidraResponseBufferOptions {
  readonly maxLineBytes: number;
  readonly onLine: (line: string) => void;
  readonly onFailure: (message: string) => void;
}

/** Splits fragmented UTF-8 socket data while enforcing a byte limit per line. */
export class GhidraResponseBuffer {
  readonly #options: GhidraResponseBufferOptions;
  #buffer = "";

  constructor(options: GhidraResponseBufferOptions) {
    this.#options = options;
  }

  /** Consume one decoded socket chunk. */
  push(chunk: string): void {
    this.#buffer += chunk;
    let newline = this.#buffer.indexOf("\n");
    while (newline >= 0) {
      const encodedLine = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (Buffer.byteLength(encodedLine) > this.#options.maxLineBytes) {
        this.#options.onFailure(
          "Ghidra response exceeded the maximum line size",
        );
        return;
      }
      const line = encodedLine.trim();
      if (line.length > 0) this.#options.onLine(line);
      newline = this.#buffer.indexOf("\n");
    }
    if (Buffer.byteLength(this.#buffer) > this.#options.maxLineBytes)
      this.#options.onFailure("Ghidra response exceeded the maximum line size");
  }

  /** Drop any incomplete line when a session closes. */
  reset(): void {
    this.#buffer = "";
  }
}
