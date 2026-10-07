import {
  parseBridgeMessageLine,
  type HopperBridgeMessage,
} from "./protocol.js";

export interface HopperResponseStreamOptions {
  readonly accept: (message: HopperBridgeMessage) => boolean;
  readonly hasQueued: (id: number) => boolean;
  readonly nextRequestId: () => number;
  readonly abort: (message: string, cause?: Error) => void;
}

/** Incrementally validates Hopper NDJSON response frames. */
export class HopperResponseStream {
  #buffer = "";
  #fragments: string[] = [];

  constructor(readonly options: HopperResponseStreamOptions) {}

  push(chunk: string): void {
    this.#fragments.push(chunk);
    if (!chunk.includes("\n")) return;
    this.#buffer += this.#fragments.join("");
    this.#fragments = [];
    let newline = this.#buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.length > 0 && !this.#acceptLine(line)) return;
      newline = this.#buffer.indexOf("\n");
    }
  }

  reset(): void {
    this.#buffer = "";
    this.#fragments = [];
  }

  #acceptLine(line: string): boolean {
    const parsed = parseBridgeMessageLine(line);
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
