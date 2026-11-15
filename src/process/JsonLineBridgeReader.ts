import type { Result } from "../domain/result.js";
import {
  Utf8NdjsonDecodingError,
  Utf8NdjsonLineBuffer,
  Utf8NdjsonOversizeError,
} from "./Utf8NdjsonLineBuffer.js";

/**
 * Reply id a REA-owned bridge uses for a failure it cannot attribute to one
 * request, such as an unparseable or oversized request frame. No client
 * request uses it: both clients number requests from 1.
 */
export const BRIDGE_CONNECTION_FAILURE_ID = 0;

/** Why the reply stream can no longer be trusted. The connection must close. */
export type JsonLineBridgeFailure =
  | {
      readonly kind: "reply_oversize";
      readonly maximumBytes: number;
      readonly observedBytes: number;
    }
  | { readonly kind: "utf8"; readonly cause: Error }
  /** The line is not JSON or is outside the bridge envelope. */
  | { readonly kind: "envelope"; readonly cause: Error }
  /** A reply names an id REA never sent, or a success on the reserved id. */
  | { readonly kind: "unknown_id"; readonly id: number }
  /** The bridge rejected the connection while no request was in flight. */
  | { readonly kind: "connection_rejected"; readonly cause: Error };

/** Bridge-specific reply envelope: the only part Ghidra and Hopper do not share. */
export interface JsonLineBridgeEnvelope<Message, Failure extends Error> {
  readonly parse: (line: string) => Result<Message, Error>;
  readonly id: (message: Message) => number;
  /** The remote failure a message carries, or undefined for a result or event. */
  readonly remoteFailure: (message: Message) => Failure | undefined;
}

export interface JsonLineBridgeReaderOptions<Message, Failure extends Error> {
  readonly envelope: JsonLineBridgeEnvelope<Message, Failure>;
  /** Effective reply line ceiling, read per chunk. */
  readonly maxReplyBytes: () => number;
  /** Settle the in-flight request or forward its event; false when the id is not in flight. */
  readonly deliver: (message: Message) => boolean;
  /** Whether REA already wrote this id; a late reply for it is ignored. */
  readonly wasSent: (id: number) => boolean;
  /** Fail every in-flight request with the bridge's reason; false when none. */
  readonly rejectInFlight: (cause: Failure) => boolean;
  /** The stream is unusable; the owner fails its requests and closes the socket. */
  readonly fail: (failure: JsonLineBridgeFailure) => void;
}

/**
 * Reads one REA-owned JSON-line bridge connection: bounded UTF-8 framing,
 * envelope parsing, and request-id correlation including connection-level
 * rejections on the reserved id. After the first failure it ignores input
 * until `reset`, because the owner closes the connection.
 */
export class JsonLineBridgeReader<Message, Failure extends Error> {
  readonly #options: JsonLineBridgeReaderOptions<Message, Failure>;
  readonly #lines: Utf8NdjsonLineBuffer;
  #failed = false;

  constructor(options: JsonLineBridgeReaderOptions<Message, Failure>) {
    this.#options = options;
    this.#lines = new Utf8NdjsonLineBuffer(options.maxReplyBytes);
  }

  push(chunk: Buffer): void {
    if (this.#failed) return;
    this.#framed(() => {
      for (const line of this.#lines.push(chunk))
        if (!this.#route(line)) return;
    });
  }

  /** Validate the unterminated tail at EOF. */
  finish(): void {
    if (this.#failed) return;
    this.#framed(() => this.#lines.finish());
  }

  /** Discard buffered bytes and accept input again for a new connection. */
  reset(): void {
    this.#lines.reset();
    this.#failed = false;
  }

  #framed(read: () => void): void {
    try {
      read();
    } catch (cause: unknown) {
      if (cause instanceof Utf8NdjsonOversizeError)
        this.#fail({
          kind: "reply_oversize",
          maximumBytes: cause.maximumBytes,
          observedBytes: cause.observedBytes,
        });
      else if (cause instanceof Utf8NdjsonDecodingError)
        this.#fail({ kind: "utf8", cause });
      else throw cause;
    }
  }

  /** Route one complete line; false once the stream has failed. */
  #route(line: string): boolean {
    const { envelope } = this.#options;
    const parsed = envelope.parse(line);
    if (!parsed.ok)
      return this.#fail({ kind: "envelope", cause: parsed.error });
    const message = parsed.value;
    const id = envelope.id(message);
    if (id === BRIDGE_CONNECTION_FAILURE_ID) {
      const cause = envelope.remoteFailure(message);
      if (cause === undefined) return this.#fail({ kind: "unknown_id", id });
      // The bridge could not attribute the rejected request and closes the
      // connection, so every request in flight fails with its remote reason.
      if (!this.#options.rejectInFlight(cause))
        return this.#fail({ kind: "connection_rejected", cause });
      return true;
    }
    if (this.#options.deliver(message)) return true;
    if (this.#options.wasSent(id)) return true;
    return this.#fail({ kind: "unknown_id", id });
  }

  #fail(failure: JsonLineBridgeFailure): false {
    this.#failed = true;
    this.#lines.reset();
    this.#options.fail(failure);
    return false;
  }
}
