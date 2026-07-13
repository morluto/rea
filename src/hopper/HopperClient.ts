import { randomBytes, randomUUID } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HopperCancelledError,
  type HopperError,
  HopperProcessError,
  HopperProtocolError,
  HopperStartError,
  hopperStartupFailure,
  HopperTimeoutError,
} from "../domain/errors.js";
import { err, ok, type Result } from "../domain/result.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { BridgeLaunch, BridgeLauncher } from "./BridgeLauncher.js";
import { silentLogger, type Logger } from "../logger.js";
import { parseResponseLine, responseResult } from "./protocol.js";

const MAX_LINE_BYTES = 10 * 1024 * 1024;
const SHUTDOWN_TIMEOUT_MS = 30_000;
const SESSION_ROOT = process.platform === "darwin" ? "/tmp" : tmpdir();

/** Dependencies, deadlines, and redacted diagnostics for one bridge client. */
export interface HopperClientOptions {
  readonly launcher: BridgeLauncher;
  readonly requestTimeoutMs?: number;
  readonly startupTimeoutMs?: number;
  readonly onDiagnostic?: (event: HopperDiagnostic) => void;
  readonly logger?: Logger;
}

/** Safe launcher telemetry; stderr content is intentionally never exposed. */
type HopperDiagnostic =
  | { readonly type: "launcher-stderr"; readonly bytes: number }
  | { readonly type: "launcher-exit"; readonly code: number | null };

export interface HopperServerInfo {
  readonly name: string;
  readonly version: string;
}

interface PendingRequest {
  readonly resolve: (result: Result<JsonValue, HopperError>) => void;
  readonly timer: NodeJS.Timeout;
  readonly signal: AbortSignal | undefined;
  readonly onAbort: (() => void) | undefined;
}

/**
 * Owns one authenticated NDJSON-over-Unix-socket bridge session.
 *
 * Each instance creates a private directory and random bearer token, correlates
 * concurrent requests by numeric id, and removes its artifacts on close. It
 * only terminates launch processes explicitly marked as owned; the normal
 * Hopper launcher does not confer ownership of the GUI application.
 */
export class HopperClient {
  readonly #options: Required<
    Pick<HopperClientOptions, "requestTimeoutMs" | "startupTimeoutMs">
  > &
    HopperClientOptions;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #logger: Logger;
  #socket: Socket | undefined;
  #launch: BridgeLaunch | undefined;
  #directory: string | undefined;
  #token: string | undefined;
  #nextId = 1;
  #buffer = "";
  #closing = false;
  #launcherExitCode: number | null | undefined;
  #startPromise: Promise<Result<HopperServerInfo, HopperError>> | undefined;
  #closePromise: Promise<void> | undefined;

  constructor(options: HopperClientOptions) {
    this.#logger = options.logger ?? silentLogger;
    this.#options = {
      ...options,
      requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
      startupTimeoutMs: options.startupTimeoutMs ?? 120_000,
    };
  }

  /** Launch the bridge once and complete its authenticated health handshake. */
  start(signal?: AbortSignal): Promise<Result<HopperServerInfo, HopperError>> {
    this.#startPromise ??= this.#start(signal);
    return this.#startPromise;
  }

  async #start(
    signal?: AbortSignal,
  ): Promise<Result<HopperServerInfo, HopperError>> {
    if (signal?.aborted === true) return err(new HopperCancelledError());
    if (this.#socket !== undefined || this.#directory !== undefined) {
      return err(new HopperProtocolError("Hopper client is already started"));
    }
    try {
      this.#directory = await mkdtemp(join(SESSION_ROOT, "rea-"));
    } catch (cause: unknown) {
      return err(new HopperStartError({ cause }));
    }
    const socketPath = join(this.#directory, "bridge.sock");
    this.#token = randomBytes(32).toString("hex");
    this.#launcherExitCode = undefined;
    const runId = randomUUID();
    const launched = await this.#options.launcher.launch(
      {
        directory: this.#directory,
        socketPath,
        token: this.#token,
        runId,
      },
      signal === undefined ? {} : { signal },
    );
    if (!launched.ok) {
      await this.close();
      return launched;
    }
    this.#launch = launched.value;
    this.#attachLauncher(launched.value);
    const connected = await this.#connect(socketPath, signal);
    if (!connected.ok) {
      await this.close();
      return connected;
    }
    const health = await this.#request(
      "health",
      {},
      {
        timeoutMs: this.#options.startupTimeoutMs,
        ...(signal === undefined ? {} : { signal }),
      },
    );
    if (!health.ok) {
      await this.close();
      return health;
    }
    const parsed = parseServerInfo(health.value, runId);
    if (!parsed.ok) await this.close();
    return parsed;
  }

  /** Invoke one declared operation, returning timeout and cancellation as values. */
  async callTool(
    name: string,
    arguments_: Readonly<Record<string, JsonValue>> = {},
    options: {
      readonly signal?: AbortSignal;
      readonly timeoutMs?: number;
    } = {},
  ): Promise<Result<JsonValue, HopperError>> {
    const started = await this.start(options.signal);
    if (!started.ok) return started;
    return this.#request(name, arguments_, options);
  }

  /** Stop the bridge, settle outstanding requests, and remove session artifacts. */
  close(): Promise<void> {
    this.#closePromise ??= Promise.resolve().then(() => this.#close());
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    this.#closing = true;
    try {
      const socket = this.#socket;
      if (socket !== undefined && !socket.destroyed) {
        const shutdown = await this.#request(
          "shutdown",
          {},
          { timeoutMs: SHUTDOWN_TIMEOUT_MS },
        ).catch(() => err(new HopperProcessError(null)));
        if (
          !shutdown.ok ||
          !isShutdownAcknowledgement(
            shutdown.value,
            this.#launch?.shutdownByCleanup === true,
          )
        )
          this.#logger.warn(
            { status: shutdown.ok ? "invalid-acknowledgement" : "failed" },
            "Hopper document shutdown was not confirmed",
          );
      }
      this.#failAll(new HopperProcessError(null));
      socket?.destroy();
      this.#socket = undefined;
      if (this.#launch?.ownsProcessLifetime === true) {
        if (this.#launch.cleanup !== undefined) {
          const cleanup = await this.#launch.cleanup();
          if (!cleanup.cleaned)
            this.#logger.warn(
              { reason: cleanup.reason },
              "Owned launcher cleanup failed closed",
            );
        } else this.#launch.process.kill("SIGTERM");
      }
      this.#launch = undefined;
      if (this.#directory !== undefined) {
        await rm(this.#directory, { recursive: true, force: true });
        this.#directory = undefined;
      }
      this.#token = undefined;
      this.#startPromise = undefined;
    } finally {
      this.#closing = false;
      this.#closePromise = undefined;
    }
  }

  async #connect(
    socketPath: string,
    signal?: AbortSignal,
  ): Promise<Result<undefined, HopperError>> {
    const deadline = Date.now() + this.#options.startupTimeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted === true) return err(new HopperCancelledError());
      if (this.#closing) return err(new HopperProcessError(null));
      if (
        this.#launcherExitCode !== undefined &&
        hopperStartupFailure(this.#launcherExitCode) !== undefined
      )
        return err(new HopperProcessError(this.#launcherExitCode));
      try {
        await access(socketPath);
      } catch {
        if (!(await waitForDelay(50, signal)))
          return err(new HopperCancelledError());
        continue;
      }
      const attempt = await connectOnce(socketPath);
      if (attempt.ok) {
        this.#socket = attempt.value;
        this.#attachSocket(attempt.value);
        return ok(undefined);
      }
      if (!(await waitForDelay(50, signal)))
        return err(new HopperCancelledError());
    }
    return err(new HopperTimeoutError(this.#options.startupTimeoutMs));
  }

  async #request(
    method: string,
    params: JsonValue,
    options: { readonly signal?: AbortSignal; readonly timeoutMs?: number },
  ): Promise<Result<JsonValue, HopperError>> {
    const socket = this.#socket;
    const token = this.#token;
    if (socket === undefined || socket.destroyed || token === undefined) {
      return err(new HopperProcessError(null));
    }
    if (options.signal?.aborted === true)
      return err(new HopperCancelledError());
    const id = this.#nextId++;
    const startedAt = performance.now();
    const timeoutMs = options.timeoutMs ?? this.#options.requestTimeoutMs;
    const response = new Promise<Result<JsonValue, HopperError>>((resolve) => {
      const onAbort =
        options.signal === undefined
          ? undefined
          : () => {
              this.#abandon(id, err(new HopperCancelledError()));
            };
      const timer = setTimeout(() => {
        this.#abandon(id, err(new HopperTimeoutError(timeoutMs)));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve,
        timer,
        signal: options.signal,
        onAbort,
      });
      options.signal?.addEventListener("abort", onAbort ?? (() => undefined), {
        once: true,
      });
    });
    socket.write(
      `${JSON.stringify({ id, token, method, params })}\n`,
      (cause) => {
        if (cause !== undefined && cause !== null)
          this.#settle(id, err(new HopperProcessError(null)));
      },
    );
    const result = await response;
    this.#logger[result.ok ? "debug" : "warn"](
      {
        method,
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
        status: result.ok ? "ok" : "error",
        ...(result.ok ? {} : { errorTag: result.error._tag }),
      },
      "Hopper bridge request completed",
    );
    return result;
  }

  #attachSocket(socket: Socket): void {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.#onData(chunk);
    });
    socket.on("error", () => {
      this.#failAll(new HopperProcessError(null));
    });
    socket.on("close", () => {
      if (!this.#closing) this.#failAll(new HopperProcessError(null));
    });
  }

  #attachLauncher(launch: BridgeLaunch): void {
    launch.process.stderr?.on("data", (chunk: Buffer) => {
      this.#options.onDiagnostic?.({
        type: "launcher-stderr",
        bytes: chunk.byteLength,
      });
    });
    launch.process.on("exit", (code) => {
      this.#launcherExitCode = code;
      this.#options.onDiagnostic?.({ type: "launcher-exit", code });
      if (launch.ownsProcessLifetime && !this.#closing) {
        this.#failAll(new HopperProcessError(code));
      }
    });
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    let newline = this.#buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
        this.#abortProtocol("Hopper response exceeded the maximum line size");
        return;
      }
      if (line.length > 0) this.#onLine(line);
      newline = this.#buffer.indexOf("\n");
    }
    if (Buffer.byteLength(this.#buffer) > MAX_LINE_BYTES) {
      this.#abortProtocol("Hopper response exceeded the maximum line size");
    }
  }

  #onLine(line: string): void {
    const parsed = parseResponseLine(line);
    if (!parsed.ok) {
      this.#abortProtocol(parsed.error.message, parsed.error);
      return;
    }
    if (!this.#pending.has(parsed.value.id)) {
      if (parsed.value.id >= this.#nextId) {
        this.#abortProtocol("Hopper returned an unknown response id");
      }
      return;
    }
    this.#settle(parsed.value.id, responseResult(parsed.value));
  }

  #abortProtocol(message: string, cause?: Error): void {
    this.#failAll(new HopperProtocolError(message, { cause }));
    this.#socket?.destroy();
  }

  #settle(id: number, result: Result<JsonValue, HopperError>): void {
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    if (pending.signal !== undefined && pending.onAbort !== undefined) {
      pending.signal.removeEventListener("abort", pending.onAbort);
    }
    pending.resolve(result);
  }

  #abandon(id: number, result: Result<JsonValue, HopperError>): void {
    if (!this.#pending.has(id)) return;
    this.#settle(id, result);
  }

  #failAll(error: HopperError): void {
    for (const id of this.#pending.keys()) this.#settle(id, err(error));
  }
}

const waitForDelay = (
  milliseconds: number,
  signal?: AbortSignal,
): Promise<boolean> => {
  if (signal?.aborted === true) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
};

const connectOnce = async (
  socketPath: string,
): Promise<Result<Socket, HopperStartError>> =>
  new Promise((resolve) => {
    const socket = createConnection(socketPath);
    socket.once("connect", () => {
      resolve(ok(socket));
    });
    socket.once("error", (cause: Error) => {
      socket.destroy();
      resolve(err(new HopperStartError({ cause })));
    });
  });

const isShutdownAcknowledgement = (
  value: JsonValue,
  ownsProcessLifetime: boolean,
): boolean => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  if (value.shutdown !== true) return false;
  if (value.analysis_stopped === true && value.document_closed === true)
    return true;
  return ownsProcessLifetime && value.cleanup_required === true;
};

const parseServerInfo = (
  value: JsonValue,
  expectedRunId: string,
): Result<HopperServerInfo, HopperProtocolError> => {
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    value.name === "REA Hopper bridge" &&
    typeof value.version === "string" &&
    value.run_id === expectedRunId
  ) {
    return ok({ name: value.name, version: value.version });
  }
  return err(new HopperProtocolError("Hopper bridge health result is invalid"));
};
