import { parseResponseLine, type HopperResponse } from "./protocol.js";

const MAX_LINE_BYTES = 10 * 1024 * 1024;

export interface HopperResponseStreamOptions {
  readonly accept: (response: HopperResponse) => boolean;
  readonly hasQueued: (id: number) => boolean;
  readonly nextRequestId: () => number;
  readonly abort: (message: string, cause?: Error) => void;
}

/** Incrementally validates bounded Hopper NDJSON response frames. */
export class HopperResponseStream {
  #buffer = "";

  constructor(readonly options: HopperResponseStreamOptions) {}

  push(chunk: string): void {
    this.#buffer += chunk;
    let newline = this.#buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
        this.options.abort("Hopper response exceeded the maximum line size");
        return;
      }
      if (line.length > 0 && !this.#acceptLine(line)) return;
      newline = this.#buffer.indexOf("\n");
    }
    if (Buffer.byteLength(this.#buffer) > MAX_LINE_BYTES) {
      this.options.abort("Hopper response exceeded the maximum line size");
    }
  }

  reset(): void {
    this.#buffer = "";
  }

  #acceptLine(line: string): boolean {
    const parsed = parseResponseLine(line);
    if (!parsed.ok) {
      this.options.abort(parsed.error.message, parsed.error);
      return false;
    }
    if (this.options.accept(parsed.value)) return true;
    if (
      parsed.value.id >= this.options.nextRequestId() ||
      this.options.hasQueued(parsed.value.id)
    ) {
      this.options.abort("Hopper returned an unknown response id");
      return false;
    }
    return true;
  }
}
