import { ProviderResponseLines } from "../process/ProviderResponseLines.js";
import {
  parseBridgeMessageLine,
  type HopperBridgeMessage,
} from "./protocol.js";
import { Utf8NdjsonLineBuffer } from "../process/Utf8NdjsonLineBuffer.js";

export interface HopperResponseStreamOptions {
  readonly accept: (message: HopperBridgeMessage) => boolean;
  readonly hasQueued: (id: number) => boolean;
  readonly nextRequestId: () => number;
  readonly abort: (message: string, cause?: Error) => void;
  /** Fail the request owning a reply too long to assemble; false ends the session. */
  readonly oversized: () => boolean;
}

/** Incrementally validates Hopper NDJSON response frames. */
export class HopperResponseStream {
  readonly #lines = new ProviderResponseLines({
    onLine: (line) => this.#acceptLine(line),
    onOverflow: () => this.options.oversized(),
  });
  readonly #lines = new DecodedNdjsonLineBuffer();

  constructor(readonly options: HopperResponseStreamOptions) {}

  push(chunk: string): void {
    this.#lines.push(chunk);
  readonly #lines = new Utf8NdjsonLineBuffer();

  constructor(readonly options: HopperResponseStreamOptions) {}

  push(chunk: Buffer): void {
    for (const line of this.#lines.push(chunk))
      if (!this.#acceptLine(line)) break;
  }

  finish(): void {
    this.#lines.finish();
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
