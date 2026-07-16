import { randomBytes, randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import type { Socket } from "node:net";
import { join } from "node:path";

import type { JsonValue } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";
import { silentLogger, type Logger } from "../logger.js";
import { PendingOperations } from "../process/PendingOperations.js";
import { PrivateRuntimeRoot } from "../process/PrivateRuntimeRoot.js";
import { ProviderStartupDeadline } from "../process/ProviderDeadline.js";
import {
  type ProviderProcessDiagnostic,
  type ProviderProcessSnapshot,
  ProviderProcessSupervisor,
} from "../process/ProviderProcess.js";
import {
  GHIDRA_MAX_LINE_BYTES,
  GHIDRA_MAX_QUEUED_REQUESTS,
  GHIDRA_REQUEST_TIMEOUT_MS,
  GHIDRA_STARTUP_TIMEOUT_MS,
} from "./GhidraDefaults.js";
import type {
  GhidraClientOptions,
  GhidraRequestOptions,
  GhidraStartResult,
} from "./GhidraClientTypes.js";
import type { GhidraInventoryOperation } from "./GhidraInventoryValues.js";
import type { GhidraFunctionOperation } from "./GhidraFunctionValues.js";
import { createGhidraDiagnostics } from "./GhidraDiagnostics.js";
import type { GhidraLaunch } from "./GhidraLauncher.js";
import { GhidraResponseBuffer } from "./GhidraResponseBuffer.js";
import { GhidraResponseRouter } from "./GhidraResponseRouter.js";
import { GhidraRequestQueue } from "./GhidraRequestQueue.js";
import {
  bindGhidraSessionFailure,
  GhidraSessionError,
} from "./GhidraSessionError.js";
import {
  isGhidraShutdownAcknowledgement,
  parseGhidraSessionInfo,
  type GhidraSessionInfo,
} from "./GhidraSessionValues.js";
import { createGhidraTargetSnapshot } from "./GhidraTargetSnapshot.js";
import {
  attachGhidraSocket,
  connectGhidraSocketOnce,
} from "./GhidraSocketConnection.js";

const SHUTDOWN_TIMEOUT_MS = 10_000;
const SESSION_ROOT = "/tmp";

export type {
  GhidraClientOptions,
  GhidraDiagnostic,
  GhidraRequestOptions,
  GhidraStartResult,
} from "./GhidraClientTypes.js";

/** Closed Java-bridge operation union callable after the exact handshake. */
export type GhidraOperation =
  | GhidraInventoryOperation
  | GhidraFunctionOperation;

/** Owns one authenticated, private, read-only Ghidra headless session. */
export class GhidraClient {
  readonly #options: Required<
    Pick<GhidraClientOptions, "requestTimeoutMs" | "startupTimeoutMs">
  > &
    GhidraClientOptions;
  readonly #pending = new PendingOperations<
    number,
    Result<JsonValue, GhidraSessionError>
  >();
  readonly #logger: Logger;
  #socket: Socket | undefined;
  #detachSocket: (() => void) | undefined;
  #launch: GhidraLaunch | undefined;
  #process: ProviderProcessSupervisor | undefined;
  #runtimeRoot: PrivateRuntimeRoot | undefined;
  #snapshotPath: string | undefined;
  #token: string | undefined;
  #runId: string | undefined;
  #nextId = 1;
  #closing = false;
  #processSnapshot: ProviderProcessSnapshot | undefined;
  #lastDiagnostics: Readonly<Record<string, JsonValue>> = {};
  #startupController: AbortController | undefined;
  #startPromise: Promise<GhidraStartResult> | undefined;
  #closePromise: Promise<void> | undefined;
  readonly #failure = bindGhidraSessionFailure(() => this.#diagnostics());
  readonly #requestQueue: GhidraRequestQueue;
  readonly #responseRouter = new GhidraResponseRouter({
    pending: this.#pending,
    nextId: () => this.#nextId,
    remoteFailure: (failure) =>
      this.#failure("remote", failure.message, failure, {
        remoteCode: failure.code,
      }),
    protocolFailure: (message, cause) => this.#abortProtocol(message, cause),
  });
  readonly #responseBuffer = new GhidraResponseBuffer({
    maxLineBytes: GHIDRA_MAX_LINE_BYTES,
    onLine: (line) => this.#responseRouter.route(line),
    onFailure: (message) => this.#abortProtocol(message),
  });
  readonly #onSocketData = (chunk: string): void =>
    this.#responseBuffer.push(chunk);
  readonly #onSocketError = (): void => {
    this.#failAll(this.#failure("process", "Ghidra bridge socket failed"));
  };
  readonly #onSocketClose = (): void => {
    if (!this.#closing)
      this.#failAll(this.#failure("process", "Ghidra bridge socket closed"));
  };

  constructor(options: GhidraClientOptions) {
    this.#logger = options.logger ?? silentLogger;
    this.#options = {
      ...options,
      requestTimeoutMs: options.requestTimeoutMs ?? GHIDRA_REQUEST_TIMEOUT_MS,
      startupTimeoutMs: options.startupTimeoutMs ?? GHIDRA_STARTUP_TIMEOUT_MS,
    };
    this.#requestQueue = new GhidraRequestQueue(
      GHIDRA_MAX_QUEUED_REQUESTS,
      (method, parameters, requestOptions) =>
        this.#request(method, parameters, requestOptions),
      (kind, message, timeoutMs) =>
        this.#failure(
          kind,
          message,
          undefined,
          timeoutMs === undefined ? {} : { timeoutMs },
        ),
    );
  }

  /** Launch Ghidra once and require its exact post-analysis handshake. */
  start(signal?: AbortSignal): Promise<GhidraStartResult> {
    if (this.#closePromise !== undefined)
      return this.#closePromise.then(() => this.start(signal));
    if (this.#startPromise !== undefined) return this.#startPromise;
    const controller = new AbortController();
    const onAbort = (): void => controller.abort(signal?.reason);
    if (signal?.aborted === true) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    const started = this.#start(controller.signal);
    this.#startupController = controller;
    this.#startPromise = started;
    const reset = (): void => {
      signal?.removeEventListener("abort", onAbort);
      if (this.#startPromise === started) {
        this.#startPromise = undefined;
        if (this.#startupController === controller)
          this.#startupController = undefined;
      }
    };
    void started.then((result) => {
      signal?.removeEventListener("abort", onAbort);
      if (!result.ok) reset();
    }, reset);
    return started;
  }

  /** Revalidate live bridge, provider, run, and profile metadata. */
  async ping(
    options: GhidraRequestOptions = {},
  ): Promise<Result<GhidraSessionInfo, GhidraSessionError>> {
    const started = await this.start(options.signal);
    if (!started.ok) return started;
    const result = await this.#request("ping", {}, options);
    if (!result.ok) return result;
    return this.#parseSessionInfo(result.value);
  }

  /** Execute one admitted operation through the bounded per-Program queue. */
  async callTool(
    operation: GhidraOperation,
    parameters: Readonly<Record<string, JsonValue>>,
    options: GhidraRequestOptions = {},
  ): Promise<Result<JsonValue, GhidraSessionError>> {
    const started = await this.start(options.signal);
    if (!started.ok) return started;
    return this.#requestQueue.run(operation, parameters, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      timeoutMs: options.timeoutMs ?? this.#options.requestTimeoutMs,
    });
  }

  /** Stop the owned process group and remove all project/runtime artifacts. */
  close(): Promise<void> {
    const starting = this.#startPromise;
    const controller = this.#startupController;
    controller?.abort();
    this.#closePromise ??= Promise.resolve().then(() =>
      this.#close(starting, controller),
    );
    return this.#closePromise;
  }

  /** Latest bounded local diagnostics, with bearer material redacted. */
  diagnostics(): Readonly<Record<string, JsonValue>> {
    return structuredClone(this.#diagnostics());
  }

  async #start(signal: AbortSignal): Promise<GhidraStartResult> {
    if (signal.aborted)
      return err(this.#failure("cancelled", "Ghidra startup was cancelled"));
    if (this.#socket !== undefined || this.#runtimeRoot !== undefined)
      return err(this.#failure("protocol", "Ghidra client is already started"));
    const deadline = new ProviderStartupDeadline(
      this.#options.startupTimeoutMs,
      signal,
    );
    try {
      return await this.#startWithin(deadline);
    } finally {
      deadline.dispose();
    }
  }

  async #startWithin(
    deadline: ProviderStartupDeadline,
  ): Promise<GhidraStartResult> {
    try {
      this.#runtimeRoot = await PrivateRuntimeRoot.create({
        parent: SESSION_ROOT,
        prefix: "rea-ghidra-",
      });
    } catch (cause: unknown) {
      return err(
        this.#failure("start", "Ghidra runtime root creation failed", cause),
      );
    }
    if (deadline.signal.aborted) return this.#startupInterrupted(deadline);
    const socketPath = join(this.#runtimeRoot.path, "bridge.sock");
    try {
      const snapshot = await createGhidraTargetSnapshot(
        this.#options.targetPath,
        this.#runtimeRoot.path,
        this.#options.targetSha256,
      );
      this.#snapshotPath = snapshot.path;
    } catch (cause: unknown) {
      const failure = this.#failure(
        "start",
        "Ghidra target snapshot failed admission",
        cause,
      );
      await this.#cleanup();
      return err(failure);
    }
    if (deadline.signal.aborted) return this.#startupInterrupted(deadline);
    this.#token = randomBytes(32).toString("hex");
    this.#runId = randomUUID();
    const launched = await this.#options.launcher
      .launch(
        {
          runtimeRoot: this.#runtimeRoot.path,
          socketPath,
          token: this.#token,
          runId: this.#runId,
          targetPath: this.#snapshotPath,
          targetSha256: this.#options.targetSha256,
          providerVersion: this.#options.providerVersion,
          profileDigest: this.#options.profileDigest,
        },
        { signal: deadline.signal },
      )
      .catch((cause: unknown) =>
        err(this.#failure("start", "Ghidra launcher failed", cause)),
      );
    if (!launched.ok) {
      const failure = deadline.signal.aborted
        ? this.#interruptionFailure(deadline)
        : launched.error instanceof GhidraSessionError
          ? launched.error
          : this.#failure("start", launched.error.message, launched.error);
      await this.#cleanup();
      return err(failure);
    }
    this.#launch = launched.value;
    this.#process = new ProviderProcessSupervisor(launched.value, {
      onDiagnostic: (event) => this.#onProcessDiagnostic(event),
    });
    const connected = await this.#connect(socketPath, deadline);
    if (!connected.ok) {
      const failure = connected.error;
      await this.#cleanup();
      return err(failure);
    }
    const ping = await this.#request(
      "ping",
      {},
      {
        signal: deadline.signal,
        timeoutMs: deadline.remainingMs(),
      },
    );
    if (!ping.ok) {
      const failure = deadline.signal.aborted
        ? this.#interruptionFailure(deadline)
        : ping.error;
      await this.#cleanup();
      return err(failure);
    }
    const parsed = this.#parseSessionInfo(ping.value);
    if (!parsed.ok || parsed.value.analysis_timed_out) {
      const failure = parsed.ok
        ? this.#failure(
            "analysis_timeout",
            "Ghidra auto-analysis reached its per-file deadline",
          )
        : parsed.error;
      await this.#cleanup();
      return err(failure);
    }
    return parsed;
  }

  async #connect(
    socketPath: string,
    deadline: ProviderStartupDeadline,
  ): Promise<Result<undefined, GhidraSessionError>> {
    while (deadline.remainingMs() > 0) {
      if (deadline.signal.aborted)
        return err(this.#interruptionFailure(deadline));
      if (this.#closing)
        return err(this.#failure("cancelled", "Ghidra startup was closed"));
      if (this.#processSnapshot?.exitCode !== undefined)
        return err(
          this.#failure("process", "Ghidra exited before bridge startup"),
        );
      try {
        await access(socketPath);
      } catch {
        if ((await deadline.wait(50)) === "aborted")
          return err(this.#interruptionFailure(deadline));
        continue;
      }
      const connected = await connectGhidraSocketOnce(
        socketPath,
        deadline.signal,
      );
      if (connected.ok) {
        this.#socket = connected.value;
        this.#detachSocket = attachGhidraSocket(connected.value, {
          data: this.#onSocketData,
          error: this.#onSocketError,
          close: this.#onSocketClose,
        });
        return ok(undefined);
      }
      if ((await deadline.wait(50)) === "aborted")
        return err(this.#interruptionFailure(deadline));
    }
    return err(
      this.#failure("timeout", "Ghidra startup deadline elapsed", undefined, {
        timeoutMs: this.#options.startupTimeoutMs,
      }),
    );
  }

  async #request(
    method: string,
    params: JsonValue,
    options: GhidraRequestOptions,
  ): Promise<Result<JsonValue, GhidraSessionError>> {
    const socket = this.#socket;
    const token = this.#token;
    if (socket === undefined || socket.destroyed || token === undefined)
      return err(this.#failure("process", "Ghidra bridge is unavailable"));
    if (options.signal?.aborted === true)
      return err(this.#failure("cancelled", "Ghidra request was cancelled"));
    const id = this.#nextId++;
    const timeoutMs = options.timeoutMs ?? this.#options.requestTimeoutMs;
    if (timeoutMs <= 0)
      return err(
        this.#failure("timeout", "Ghidra request deadline elapsed", undefined, {
          timeoutMs,
        }),
      );
    const response = this.#pending.wait(id, {
      timeoutMs,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      timeoutValue: () =>
        err(
          this.#failure(
            "timeout",
            "Ghidra bridge request timed out",
            undefined,
            { timeoutMs },
          ),
        ),
      cancelledValue: () =>
        err(this.#failure("cancelled", "Ghidra request was cancelled")),
    });
    socket.write(
      `${JSON.stringify({ id, token, method, params })}\n`,
      (cause) => {
        if (cause !== undefined && cause !== null)
          this.#pending.settle(
            id,
            err(this.#failure("process", "Ghidra bridge write failed", cause)),
          );
      },
    );
    const result = await response;
    this.#logger[result.ok ? "debug" : "warn"](
      { method, status: result.ok ? "ok" : "error" },
      "Ghidra bridge request completed",
    );
    return result;
  }

  #parseSessionInfo(value: JsonValue) {
    const runId = this.#runId;
    if (runId === undefined)
      return err(this.#failure("protocol", "Ghidra run identity is missing"));
    const parsed = parseGhidraSessionInfo(value, {
      runId,
      providerVersion: this.#options.providerVersion,
      profileDigest: this.#options.profileDigest,
      targetSha256: this.#options.targetSha256,
    });
    if (parsed.ok) return parsed;
    return err(
      this.#failure(
        "protocol",
        "Ghidra bridge handshake is invalid",
        parsed.error,
      ),
    );
  }

  async #close(
    starting: Promise<GhidraStartResult> | undefined,
    controller: AbortController | undefined,
  ): Promise<void> {
    try {
      await starting?.catch(() => undefined);
      await this.#cleanup();
    } finally {
      if (this.#startPromise === starting) this.#startPromise = undefined;
      if (this.#startupController === controller)
        this.#startupController = undefined;
      this.#closePromise = undefined;
    }
  }

  async #cleanup(): Promise<void> {
    this.#closing = true;
    try {
      this.#requestQueue.failQueued(
        this.#failure("process", "Ghidra session closed"),
      );
      const socket = this.#socket;
      if (socket !== undefined && !socket.destroyed) {
        const shutdown = await this.#request(
          "shutdown",
          {},
          {
            timeoutMs: SHUTDOWN_TIMEOUT_MS,
          },
        ).catch(() =>
          err(this.#failure("process", "Ghidra shutdown request failed")),
        );
        if (!shutdown.ok || !isGhidraShutdownAcknowledgement(shutdown.value))
          this.#logger.warn(
            { status: shutdown.ok ? "invalid-acknowledgement" : "failed" },
            "Ghidra bridge shutdown was not confirmed",
          );
      }
      this.#failAll(this.#failure("process", "Ghidra session closed"));
      this.#detachSocket?.();
      this.#detachSocket = undefined;
      socket?.destroy();
      this.#socket = undefined;
      if (this.#process !== undefined) {
        await this.#process.waitForExit(500);
        this.#processSnapshot = this.#process.snapshot();
        const stopped = await this.#process.stop();
        this.#processSnapshot = this.#process.snapshot();
        if (stopped.status === "incomplete") {
          this.#options.onDiagnostic?.({
            type: "cleanup-incomplete",
            reason: stopped.reason,
          });
          this.#logger.warn(
            { reason: stopped.reason },
            "Ghidra process cleanup failed closed",
          );
        }
      }
      this.#lastDiagnostics = this.#diagnostics();
      this.#process = undefined;
      this.#launch = undefined;
      const runtimeRoot = this.#runtimeRoot;
      this.#runtimeRoot = undefined;
      await runtimeRoot?.close();
      this.#snapshotPath = undefined;
      this.#token = undefined;
      this.#runId = undefined;
      this.#responseBuffer.reset();
    } finally {
      this.#closing = false;
    }
  }

  #onProcessDiagnostic(event: ProviderProcessDiagnostic): void {
    if (event.type === "output") {
      this.#options.onDiagnostic?.({
        type: "launcher-output",
        stream: event.stream,
        bytes: event.bytes,
        totalBytes: event.totalBytes,
        truncated: event.truncated,
      });
      return;
    }
    if (event.type === "error") {
      this.#logger.warn(
        { message: event.message },
        "Ghidra process emitted an error",
      );
      return;
    }
    this.#processSnapshot = event.snapshot;
    this.#options.onDiagnostic?.({
      type: "launcher-exit",
      code: event.code,
      signal: event.signal,
    });
    if (!this.#closing)
      this.#failAll(this.#failure("process", "Ghidra process exited"));
  }

  #abortProtocol(message: string, cause?: Error): void {
    this.#failAll(this.#failure("protocol", message, cause));
    this.#socket?.destroy();
  }

  #failAll(error: GhidraSessionError): void {
    this.#pending.failAll(() => err(error));
  }

  async #startupInterrupted(
    deadline: ProviderStartupDeadline,
  ): Promise<GhidraStartResult> {
    const failure = this.#interruptionFailure(deadline);
    await this.#cleanup();
    return err(failure);
  }

  #interruptionFailure(deadline: ProviderStartupDeadline): GhidraSessionError {
    return deadline.cancelled
      ? this.#failure("cancelled", "Ghidra startup was cancelled")
      : this.#failure("timeout", "Ghidra startup deadline elapsed", undefined, {
          timeoutMs: deadline.timeoutMs,
        });
  }

  #diagnostics(): Readonly<Record<string, JsonValue>> {
    const snapshot = this.#process?.snapshot() ?? this.#processSnapshot;
    return createGhidraDiagnostics({
      targetPath: this.#options.targetPath,
      targetSha256: this.#options.targetSha256,
      providerVersion: this.#options.providerVersion,
      profileDigest: this.#options.profileDigest,
      ...(this.#runtimeRoot === undefined
        ? {}
        : { runtimeRoot: this.#runtimeRoot.path }),
      ...(this.#launch === undefined ? {} : { launch: this.#launch }),
      ...(snapshot === undefined ? {} : { snapshot }),
      ...(this.#token === undefined ? {} : { token: this.#token }),
      previous: this.#lastDiagnostics,
    });
  }
}
