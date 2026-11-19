import type { Socket } from "node:net";

import {
  admitBridgeRequestLimit,
  bridgeRequestOversizeError,
  type BridgeMaxRequestBytes,
} from "../config/bridgeMaxRequestBytes.js";
import {
  admitBridgeReplyLimit,
  DEFAULT_BRIDGE_MAX_REPLY,
  type BridgeMaxReplyBytes,
} from "../config/bridgeMaxReplyBytes.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { jsonValueByteLength } from "../domain/jsonValueByteLength.js";
import { err, ok, type Result } from "../domain/result.js";
import type { ConfigurationError } from "../domain/configurationErrors.js";
import type { Logger } from "pino";
import type { PendingOperations } from "../process/PendingOperations.js";
import type {
  GhidraAdmittedLimits,
  GhidraRequestOptions,
} from "./GhidraClientTypes.js";
import type {
  GhidraSessionError,
  GhidraSessionFailureFactory,
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
  readonly logger: Logger;
  readonly failure: GhidraSessionFailureFactory;
  /** Effective Ghidra request ceiling; the bridge itself enforces none. */
  readonly bridgeMaxRequestBytes: BridgeMaxRequestBytes;
  /** Effective reply line ceiling, admitted with each request. */
  readonly bridgeMaxReplyBytes: BridgeMaxReplyBytes;
}

/** Owns the socket write and pending-reply lifecycle for one bridge session. */
export class GhidraWire {
  readonly #options: GhidraWireOptions;
  #replyLimit: BridgeMaxReplyBytes = DEFAULT_BRIDGE_MAX_REPLY;
  #sessionLimits: GhidraAdmittedLimits | undefined;

  constructor(options: GhidraWireOptions) {
    this.#options = options;
  }

  /** Reply ceiling of the request last written; the default before any. */
  replyLimit(): BridgeMaxReplyBytes {
    return this.#replyLimit;
  }

  /**
   * Copy the effective request and reply ceilings in the admitting caller's
   * context. A malformed launch seed no override covers is an admission
   * refusal carrying its `ConfigurationError`.
   */
  admitLimits(): Result<GhidraAdmittedLimits, GhidraSessionError> {
    const requestLimit = admitBridgeRequestLimit(
      this.#options.bridgeMaxRequestBytes,
    );
    if (!requestLimit.ok) return err(this.#refused(requestLimit.error));
    const replyLimit = admitBridgeReplyLimit(this.#options.bridgeMaxReplyBytes);
    if (!replyLimit.ok) return err(this.#refused(replyLimit.error));
    return ok({
      requestLimit: requestLimit.value,
      replyLimit: replyLimit.value,
    });
  }

  /**
   * Admit the ceilings a session starts with and keep them for its cleanup.
   * Cleanup must not depend on the current settings: an override reset after
   * startup can expose a malformed launch seed, and refusing the checkpoint or
   * shutdown request then would leave the JVM and its files behind.
   */
  admitSessionLimits(): Result<GhidraAdmittedLimits, GhidraSessionError> {
    const limits = this.admitLimits();
    if (limits.ok) this.#sessionLimits = limits.value;
    return limits;
  }

  /** Ceilings admitted when the current session started, for its cleanup. */
  sessionLimits(): GhidraAdmittedLimits | undefined {
    return this.#sessionLimits;
  }

  #refused(cause: ConfigurationError): GhidraSessionError {
    return this.#options.failure("admission", cause.message, cause);
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
      return err(this.#cancelled(options.signal));
    const id = this.#options.nextId();
    if (options.timeoutMs !== undefined && options.timeoutMs <= 0)
      return err(
        this.#options.failure(
          "timeout",
          "Ghidra request deadline elapsed",
          undefined,
          { timeoutMs: options.timeoutMs },
        ),
      );
    const timeoutMs = options.timeoutMs;
    const payloadValue = {
      id,
      token,
      method,
      params,
      ...(options.decompileTimeoutSeconds === undefined
        ? {}
        : { decompile_timeout_seconds: options.decompileTimeoutSeconds }),
      ...(options.valueFlowLimits === undefined
        ? {}
        : { value_flow_limits: options.valueFlowLimits }),
      ...(options.decompileMaxPayloadMiB === undefined
        ? {}
        : { decompile_max_payload_mib: options.decompileMaxPayloadMiB }),
    };
    const limits =
      options.limits === undefined ? this.admitLimits() : ok(options.limits);
    if (!limits.ok) return limits;
    const { requestLimit, replyLimit } = limits.value;
    const payloadBytes = jsonValueByteLength(payloadValue);
    // Refuse before registering the operation and before any socket write, so
    // an oversized request never reaches the bridge or occupies a pending key.
    if (payloadBytes > requestLimit.maximumBytes) {
      const oversize = bridgeRequestOversizeError(
        method,
        requestLimit,
        payloadBytes,
        "Ghidra",
      );
      return err(
        this.#options.failure("admission", oversize.message, oversize),
      );
    }
    const payload = JSON.stringify(payloadValue);
    // Only the request being written owns the next reply's ceiling; a
    // refused or still-queued request never changes it.
    this.#replyLimit = replyLimit;
    const response = this.#options.pending.wait(id, {
      ...(timeoutMs === undefined
        ? {}
        : {
            timeoutMs,
            timeoutValue: () =>
              err(
                this.#options.failure(
                  "timeout",
                  "Ghidra bridge request timed out",
                  undefined,
                  { timeoutMs },
                ),
              ),
          }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      cancelledValue: () => err(this.#cancelled(options.signal)),
    });
    socket.write(`${payload}\n`, (cause) => {
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
    });
    const result = await response;
    this.#options.logger[result.ok ? "debug" : "warn"](
      { method, status: result.ok ? "ok" : "error" },
      "Ghidra bridge request completed",
    );
    return result;
  }
  #cancelled(signal: AbortSignal | undefined): GhidraSessionError {
    return this.#options.failure(
      "cancelled",
      "Ghidra request was cancelled",
      signal?.reason,
      signal === undefined ? {} : { cancellation: { reason: signal.reason } },
    );
  }
}
