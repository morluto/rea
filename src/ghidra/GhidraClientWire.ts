import type { Socket } from "node:net";

import type { JsonValue } from "../domain/jsonValue.js";
import { err, type Result } from "../domain/result.js";
import type { Logger } from "../logger.js";
import type { PendingOperations } from "../process/PendingOperations.js";
import type { GhidraRequestOptions } from "./GhidraClientTypes.js";
import type {
  GhidraSessionError,
  GhidraSessionErrorOptions,
  GhidraSessionFailureKind,
} from "./GhidraSessionError.js";

/** Dependencies needed to write one authenticated line and await its reply. */
export interface GhidraWireOptions {
  readonly getSocket: () => Socket | undefined;
  readonly getToken: () => string | undefined;
  readonly nextId: () => number;
  readonly pending: PendingOperations<
    number,
    Result<JsonValue, GhidraSessionError>
  >;
  readonly requestTimeoutMs: number;
  readonly logger: Logger;
  readonly failure: (
    kind: GhidraSessionFailureKind,
    message: string,
    cause?: unknown,
    options?: Pick<GhidraSessionErrorOptions, "timeoutMs" | "remoteCode">,
  ) => GhidraSessionError;
}

/** Owns the socket write and pending-reply lifecycle for one bridge session. */
export class GhidraWire {
  readonly #options: GhidraWireOptions;

  constructor(options: GhidraWireOptions) {
    this.#options = options;
  }

  /** Write one authenticated request and return its correlated reply. */
  async request(
    method: string,
    params: JsonValue,
    options: GhidraRequestOptions,
  ): Promise<Result<JsonValue, GhidraSessionError>> {
    const socket = this.#options.getSocket();
    const token = this.#options.getToken();
    if (socket === undefined || socket.destroyed || token === undefined)
      return err(
        this.#options.failure("process", "Ghidra bridge is unavailable"),
      );
    if (options.signal?.aborted === true)
      return err(
        this.#options.failure("cancelled", "Ghidra request was cancelled"),
      );
    const id = this.#options.nextId();
    const timeoutMs = options.timeoutMs ?? this.#options.requestTimeoutMs;
    if (timeoutMs <= 0)
      return err(
        this.#options.failure(
          "timeout",
          "Ghidra request deadline elapsed",
          undefined,
          { timeoutMs },
        ),
      );
    const response = this.#options.pending.wait(id, {
      timeoutMs,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      timeoutValue: () =>
        err(
          this.#options.failure(
            "timeout",
            "Ghidra bridge request timed out",
            undefined,
            { timeoutMs },
          ),
        ),
      cancelledValue: () =>
        err(this.#options.failure("cancelled", "Ghidra request was cancelled")),
    });
    socket.write(
      `${JSON.stringify({ id, token, method, params })}\n`,
      (cause) => {
        if (cause !== undefined && cause !== null)
          this.#options.pending.settle(
            id,
            err(
              this.#options.failure(
                "process",
                "Ghidra bridge write failed",
                cause,
              ),
            ),
          );
      },
    );
    const result = await response;
    this.#options.logger[result.ok ? "debug" : "warn"](
      { method, status: result.ok ? "ok" : "error" },
      "Ghidra bridge request completed",
    );
    return result;
  }
}
