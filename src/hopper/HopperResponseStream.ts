import {
  parseBridgeMessageLine,
  type HopperBridgeMessage,
} from "./protocol.js";
import { Utf8NdjsonLineBuffer } from "../process/Utf8NdjsonLineBuffer.js";

interface HopperResponseStreamOptions {
  readonly accept: (message: HopperBridgeMessage) => boolean;
  readonly hasQueued: (id: number) => boolean;
  readonly nextRequestId: () => number;
  readonly abort: (message: string, cause?: Error) => void;
}

const NOT_UTF8 = "Hopper bridge response is not valid UTF-8";

/** Incrementally validates Hopper NDJSON response frames. */
export class HopperResponseStream {
  readonly #lines = new Utf8NdjsonLineBuffer();

  constructor(readonly options: HopperResponseStreamOptions) {}

  push(chunk: Buffer): void {
    for (const line of this.#lines.push(chunk)) {
      if (!line.ok) {
        this.options.abort(NOT_UTF8, line.error);
        break;
      }
      if (!this.#acceptLine(line.value)) break;
    }
  }

  finish(): void {
    const tail = this.#lines.finish();
    if (!tail.ok) this.options.abort(NOT_UTF8, tail.error);
  }

  reset(): void {
    this.#lines.reset();
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
