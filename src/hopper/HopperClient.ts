import { randomBytes, randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HopperCancelledError,
  type AnalysisError,
  type HopperError,
  HopperProcessError,
  HopperProtocolError,
  HopperStartError,
  hopperStartupFailure,
  HopperTimeoutError,
  type HopperStartupDiagnostic,
} from "../domain/errors.js";
import { err, ok, type Result } from "../domain/result.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { ProgressReporter } from "../application/ProgressReporter.js";
import { silentLogger, type Logger } from "../logger.js";
import { PrivateRuntimeRoot } from "../process/PrivateRuntimeRoot.js";
import { ProviderStartupDeadline } from "../process/ProviderDeadline.js";
import { ProviderRunLineage } from "../process/ProviderRunLineage.js";
import {
  type ProviderProcessDiagnostic,
  ProviderProcessSupervisor,
} from "../process/ProviderProcess.js";
import type { BridgeLaunch, BridgeLauncher } from "./BridgeLauncher.js";
import type { HopperDiagnostic } from "./HopperDiagnostics.js";
import { cleanupHopperSession } from "./HopperCleanup.js";
import {
  parseHopperServerInfo,
  type HopperServerInfo,
} from "./HopperSessionValues.js";
import { connectHopperSocketOnce } from "./HopperSocketConnection.js";
import { hopperLauncherFailureDiagnostic } from "./HopperProcessDiagnostic.js";
import {
  HopperRequestQueue,
  type HopperRequestActivity,
} from "./HopperRequestQueue.js";
import { HopperResponseStream } from "./HopperResponseStream.js";
import { responseResult } from "./protocol.js";

export type { HopperServerInfo } from "./HopperSessionValues.js";

const SHUTDOWN_TIMEOUT_MS = 30_000;
const MAX_QUEUED_REQUESTS = 64;
const SESSION_ROOT = process.platform === "darwin" ? "/tmp" : tmpdir();

/** Dependencies, deadlines, and redacted diagnostics for one bridge client. */
export interface HopperClientOptions {
  readonly launcher: BridgeLauncher;
  readonly runId?: string;
  readonly requestTimeoutMs?: number;
  readonly startupTimeoutMs?: number;
  readonly onDiagnostic?: (event: HopperDiagnostic) => void;
  readonly logger?: Logger;
}

/** Safe launcher telemetry; stderr content is intentionally never exposed. */
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
  readonly #requests: HopperRequestQueue;
  readonly #responses: HopperResponseStream;
  readonly #logger: Logger;
  #socket: Socket | undefined;
  #launch: BridgeLaunch | undefined;
  #process: ProviderProcessSupervisor | undefined;
  #runtimeRoot: PrivateRuntimeRoot | undefined;
  #token: string | undefined;
  readonly #lineage = new ProviderRunLineage();
  #nextId = 1;
  #closing = false;
  #launcherExitCode: number | null | undefined;
  #launcherFailureDiagnostic: HopperStartupDiagnostic | undefined;
  #startupController: AbortController | undefined;
  #startPromise: Promise<Result<HopperServerInfo, HopperError>> | undefined;
  #closePromise: Promise<Result<null, AnalysisError>> | undefined;
  readonly #onSocketData = (chunk: string): void => {
    this.#responses.push(chunk);
  };
  readonly #onSocketError = (): void => {
    this.#failAll(new HopperProcessError(null));
  };
  readonly #onSocketClose = (): void => {
    if (!this.#closing) this.#failAll(new HopperProcessError(null));
  };

  constructor(options: HopperClientOptions) {
    this.#logger = options.logger ?? silentLogger;
    this.#options = {
      ...options,
      requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
      startupTimeoutMs: options.startupTimeoutMs ?? 120_000,
    };
    this.#requests = new HopperRequestQueue(
      MAX_QUEUED_REQUESTS,
      ({ id, method, params }, failed) => {
        const socket = this.#socket;
        const token = this.#token;
        if (socket === undefined || socket.destroyed || token === undefined) {
          failed();
          return;
        }
        socket.write(
          `${JSON.stringify({ id, token, method, params })}\n`,
          (cause) => {
            if (cause !== undefined && cause !== null) failed();
          },
        );
      },
    );
    this.#responses = new HopperResponseStream({
      accept: (response) =>
        this.#requests.accept(response.id, responseResult(response)),
      hasQueued: (id) => this.#requests.hasQueued(id),
      nextRequestId: () => this.#nextId,
      abort: (message, cause) => this.#abortProtocol(message, cause),
    });
  }

  /** Latest token-verified launcher lineage for the active run. */
  runtimeLineage() {
    return this.#lineage.snapshot();
  }

  /** Observe a request that still occupies Hopper after caller timeout/cancel. */
  requestActivity(): HopperRequestActivity | null {
    return this.#requests.activity();
  }

  /** Launch the bridge once and complete its authenticated health handshake. */
  start(signal?: AbortSignal): Promise<Result<HopperServerInfo, HopperError>> {
    if (this.#closePromise !== undefined) {
      return this.#closePromise.then(() => this.start(signal));
    }
    if (this.#startPromise !== undefined) return this.#startPromise;

    const controller = new AbortController();
    const onAbort = (): void => controller.abort(signal?.reason);
    if (signal?.aborted === true) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    const started = this.#start(controller.signal);
    this.#startupController = controller;
    this.#startPromise = started;
    const release = (): void => {
      signal?.removeEventListener("abort", onAbort);
    };
    const reset = (): void => {
      if (this.#startPromise === started) {
        this.#startPromise = undefined;
        if (this.#startupController === controller) {
          this.#startupController = undefined;
        }
      }
    };
    void started.then(
      (result) => {
        release();
        if (!result.ok) reset();
      },
      () => {
        release();
        reset();
      },
    );
    return started;
  }

  async #start(
    signal?: AbortSignal,
  ): Promise<Result<HopperServerInfo, HopperError>> {
    if (isAborted(signal)) return err(new HopperCancelledError());
    if (this.#socket !== undefined || this.#runtimeRoot !== undefined) {
      return err(new HopperProtocolError("Hopper client is already started"));
    }
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
  ): Promise<Result<HopperServerInfo, HopperError>> {
    try {
      this.#runtimeRoot = await PrivateRuntimeRoot.create({
        parent: SESSION_ROOT,
        prefix: "rea-",
      });
    } catch (cause: unknown) {
      return err(new HopperStartError({ cause }));
    }
    if (deadline.signal.aborted) {
      await this.#cleanup();
      return err(startupInterruption(deadline));
    }
    const socketPath = join(this.#runtimeRoot.path, "bridge.sock");
    this.#token = randomBytes(32).toString("hex");
    this.#lineage.reset();
    this.#launcherExitCode = undefined;
    this.#launcherFailureDiagnostic = undefined;
    const runId = this.#options.runId ?? randomUUID();
    const launched: Result<
      BridgeLaunch,
      HopperStartError | HopperCancelledError | HopperProcessError
    > = await this.#options.launcher
      .launch(
        {
          directory: this.#runtimeRoot.path,
          socketPath,
          token: this.#token,
          runId,
        },
        { signal: deadline.signal },
      )
      .catch((cause: unknown) => err(new HopperStartError({ cause })));
    if (!launched.ok) {
      await this.#cleanup();
      return deadline.signal.aborted
        ? err(startupInterruption(deadline))
        : launched;
    }
    this.#launch = launched.value;
    this.#attachLauncher(launched.value);
    const connected = await this.#connect(socketPath, deadline);
    if (!connected.ok) {
      await this.#cleanup();
      return connected;
    }
    const remainingMs = deadline.remainingMs();
    if (remainingMs <= 0) {
      await this.#cleanup();
      return err(new HopperTimeoutError(this.#options.startupTimeoutMs));
    }
    const health = await this.#request(
      "health",
      {},
      {
        timeoutMs: remainingMs,
        signal: deadline.signal,
      },
    );
    if (!health.ok) {
      await this.#cleanup();
      return deadline.signal.aborted
        ? err(startupInterruption(deadline))
        : health;
    }
    const parsed = parseHopperServerInfo(health.value, runId);
    if (parsed.ok) await this.#lineage.observe(this.#launch);
    else await this.#cleanup();
    return parsed;
  }

  /** Invoke one declared operation, returning timeout and cancellation as values. */
  async callTool(
    name: string,
    arguments_: Readonly<Record<string, JsonValue>> = {},
    options: {
      readonly signal?: AbortSignal;
      readonly timeoutMs?: number;
      readonly progress?: ProgressReporter;
    } = {},
  ): Promise<Result<JsonValue, HopperError>> {
    const started = await this.start(options.signal);
    if (!started.ok) return started;
    return this.#request(name, arguments_, options);
  }

  /** Stop the bridge, settle outstanding requests, and remove session artifacts. */
  close(): Promise<void> {
    return this.closeWithOutcome().then(() => undefined);
  }

  /** Stop the bridge and report whether every owned resource was verified clean. */
  closeWithOutcome(
    options: { readonly progress?: ProgressReporter } = {},
  ): Promise<Result<null, AnalysisError>> {
    const starting = this.#startPromise;
    const controller = this.#startupController;
    controller?.abort();
    this.#closePromise ??= Promise.resolve().then(() =>
      this.#close(starting, controller, options),
    );
    return this.#closePromise;
  }

  async #close(
    starting: Promise<Result<HopperServerInfo, HopperError>> | undefined,
    controller: AbortController | undefined,
    options: { readonly progress?: ProgressReporter },
  ): Promise<Result<null, AnalysisError>> {
    try {
      await starting?.catch(() => undefined);
      return await this.#cleanup(options);
    } finally {
      if (this.#startPromise === starting) this.#startPromise = undefined;
      if (this.#startupController === controller) {
        this.#startupController = undefined;
      }
      this.#closePromise = undefined;
    }
  }

  async #cleanup(
    options: { readonly progress?: ProgressReporter } = {},
  ): Promise<Result<null, AnalysisError>> {
    this.#closing = true;
    try {
      return await cleanupHopperSession({
        socket: this.#socket,
        launch: this.#launch,
        processSupervisor: this.#process,
        runtimeRoot: this.#runtimeRoot,
        activeRequest: this.#requests.activity(),
        progress: options.progress,
        logger: this.#logger,
        onDiagnostic: this.#options.onDiagnostic,
        request: (method) =>
          this.#request(method, {}, { timeoutMs: SHUTDOWN_TIMEOUT_MS }),
        releaseTransport: (socket) => {
          this.#failAll(new HopperProcessError(null));
          if (socket !== undefined) this.#detachSocket(socket);
          socket?.destroy();
        },
      });
    } finally {
      this.#socket = undefined;
      this.#process = undefined;
      this.#launch = undefined;
      this.#runtimeRoot = undefined;
      this.#token = undefined;
      this.#responses.reset();
      this.#launcherExitCode = undefined;
      this.#launcherFailureDiagnostic = undefined;
      this.#closing = false;
    }
  }

  async #connect(
    socketPath: string,
    deadline: ProviderStartupDeadline,
  ): Promise<Result<undefined, HopperError>> {
    while (deadline.remainingMs() > 0) {
      if (deadline.signal.aborted) return err(startupInterruption(deadline));
      if (this.#closing) return err(new HopperProcessError(null));
      if (
        this.#launcherExitCode !== undefined &&
        hopperStartupFailure(this.#launcherExitCode) !== undefined
      )
        return err(
          new HopperProcessError(
            this.#launcherExitCode,
            this.#launcherFailureDiagnostic,
          ),
        );
      try {
        await access(socketPath);
      } catch {
        if ((await deadline.wait(50)) === "aborted")
          return err(startupInterruption(deadline));
        continue;
      }
      const attempt = await connectHopperSocketOnce(
        socketPath,
        deadline.signal,
      );
      if (attempt.ok) {
        this.#socket = attempt.value;
        this.#attachSocket(attempt.value);
        return ok(undefined);
      }
      if ((await deadline.wait(50)) === "aborted")
        return err(startupInterruption(deadline));
    }
    return err(new HopperTimeoutError(this.#options.startupTimeoutMs));
  }

  async #request(
    method: string,
    params: JsonValue,
    options: {
      readonly signal?: AbortSignal;
      readonly timeoutMs?: number;
      readonly progress?: ProgressReporter;
    },
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
    const result = await this.#requests.run(id, method, params, {
      timeoutMs,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.progress !== undefined ? { progress: options.progress } : {}),
    });
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
    socket.on("data", this.#onSocketData);
    socket.on("error", this.#onSocketError);
    socket.on("close", this.#onSocketClose);
  }

  #detachSocket(socket: Socket): void {
    socket.off("data", this.#onSocketData);
    socket.off("error", this.#onSocketError);
    socket.off("close", this.#onSocketClose);
  }

  #attachLauncher(launch: BridgeLaunch): void {
    this.#process = new ProviderProcessSupervisor(launch, {
      onDiagnostic: (event) => this.#onLauncherDiagnostic(launch, event),
    });
  }

  #onLauncherDiagnostic(
    launch: BridgeLaunch,
    event: ProviderProcessDiagnostic,
  ): void {
    if (event.type === "output" && event.stream === "stderr") {
      this.#options.onDiagnostic?.({
        type: "launcher-stderr",
        bytes: event.bytes,
      });
      return;
    }
    if (event.type === "error") {
      this.#logger.warn(
        { message: event.message },
        "Hopper launcher process emitted an error",
      );
      return;
    }
    if (event.type !== "exit") return;
    this.#launcherExitCode = event.code;
    this.#launcherFailureDiagnostic = hopperLauncherFailureDiagnostic(event);
    this.#options.onDiagnostic?.({
      type: "launcher-exit",
      code: event.code,
    });
    if (launch.ownsProcessLifetime && !this.#closing)
      this.#failAll(
        new HopperProcessError(event.code, this.#launcherFailureDiagnostic),
      );
  }

  #abortProtocol(message: string, cause?: Error): void {
    this.#failAll(new HopperProtocolError(message, { cause }));
    this.#socket?.destroy();
  }

  #failAll(error: HopperError): void {
    this.#requests.failAll(error);
  }
}

const isAborted = (signal?: AbortSignal): boolean => signal?.aborted === true;

const startupInterruption = (
  deadline: ProviderStartupDeadline,
): HopperCancelledError | HopperTimeoutError =>
  deadline.cancelled
    ? new HopperCancelledError()
    : new HopperTimeoutError(deadline.timeoutMs);
