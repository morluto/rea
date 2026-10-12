import { randomBytes, randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import writeFileAtomic from "write-file-atomic";

import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { AnalysisCapabilityUnavailableError } from "../domain/analysisErrorCore.js";
import {
  HopperCancelledError,
  type HopperError,
  type HopperLauncherOutcome,
  HopperProcessError,
  HopperProtocolError,
  HopperRemoteError,
  HopperStartError,
  HopperTimeoutError,
} from "../domain/hopperErrors.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  hopperStartupFailure,
  type HopperStartupFailureDiagnostic,
} from "../domain/hopperStartupFailure.js";
import {
  providerRetryAction,
  sharedProviderFailureStage,
  type ProviderOperationHealth,
  type ProviderOperationRequest,
} from "../domain/providerOperationHealth.js";
import { err, ok, type Result } from "../domain/result.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { ProgressReporter } from "../application/ProgressReporter.js";
import { silentLogger } from "../logger.js";
import type { Logger } from "pino";
import { PrivateRuntimeRoot } from "../process/PrivateRuntimeRoot.js";
import {
  ProviderStartupDeadline,
  waitForAbortableDelay,
} from "../process/ProviderDeadline.js";
import { redactCapturedTransportCredential } from "../process/ProviderDiagnosticRedaction.js";
import { ProviderRunLineage } from "../process/ProviderRunLineage.js";
import {
  type ProviderProcessDiagnostic,
  ProviderProcessSupervisor,
} from "../process/ProviderProcess.js";
import type { BridgeLaunch, BridgeLauncher } from "./BridgeLauncher.js";
import { hopperOperationStage } from "./HopperOperationStage.js";
import type { HopperDiagnostic } from "./HopperDiagnostics.js";
import {
  cleanupHopperSession,
  type HopperOwnedResources,
} from "./HopperCleanup.js";
import {
  parseHopperServerInfo,
  HOPPER_SHUTDOWN_TIMEOUT_MS,
  type HopperServerInfo,
} from "./HopperSessionValues.js";
import { connectHopperSocketOnce } from "./HopperSocketConnection.js";
import {
  hopperLauncherFailureDiagnostic,
  nativeHopperLaunchWasDenied,
} from "./HopperProcessDiagnostic.js";
import { DEFAULT_HOPPER_STARTUP_TIMEOUT_MS } from "../config/providerStartupTimeout.js";
import {
  HopperRequestQueue,
  type HopperRequestActivity,
} from "./HopperRequestQueue.js";
import { HopperResponseStream } from "./HopperResponseStream.js";
import {
  type HopperBridgeEvent,
  type HopperBridgeMessage,
  responseResult,
} from "./protocol.js";

/** Aggregate in-memory retention budget for this provider's launcher output. */
export const HOPPER_PROCESS_DIAGNOSTIC_BYTES = 8 * 1024 * 1024;

const SESSION_ROOT = process.platform === "darwin" ? "/tmp" : tmpdir();

/** Dependencies, deadlines, and redacted diagnostics for one bridge client. */
export interface HopperClientOptions {
  readonly launcher: BridgeLauncher;
  readonly runId?: string;
  readonly startupTimeoutMs?: number;
  readonly onDiagnostic?: (event: HopperDiagnostic) => void;
  readonly logger?: Logger;
}

type HopperClientCloseOptions = {
  readonly progress?: ProgressReporter;
  readonly retainDocument?: boolean;
};

/**
 * Owns one authenticated NDJSON-over-Unix-socket bridge session.
 *
 * Each instance creates a private directory and random bearer token, correlates
 * concurrent requests by numeric id, and removes its artifacts on close. It
 * only terminates launch processes explicitly marked as owned; the normal
 * Hopper launcher does not confer ownership of the GUI application.
 */
export class HopperClient {
  readonly #options: Required<Pick<HopperClientOptions, "startupTimeoutMs">> &
    HopperClientOptions;
  readonly #requests: HopperRequestQueue;
  readonly #responses: HopperResponseStream;
  readonly #logger: Logger;
  #socket: Socket | undefined;
  readonly #resources: HopperOwnedResources = {
    launch: undefined,
    processSupervisor: undefined,
    runtimeRoot: undefined,
    shutdownConfirmed: false,
  };
  #token: string | undefined;
  readonly #lineage = new ProviderRunLineage();
  #nextId = 1;
  #closing = false;
  #launcherExitCode: number | null | undefined;
  #launcherFailureDiagnostic: HopperStartupFailureDiagnostic | undefined;
  #operationFailure: OperationFailureRecord | undefined;
  #startupController: AbortController | undefined;
  #ready = false;
  #startupFailureResult: AnalysisError | undefined;
  #runId: string | undefined;
  #startPromise: Promise<Result<HopperServerInfo, AnalysisError>> | undefined;
  #closePromise: Promise<Result<null, AnalysisError>> | undefined;
  readonly #onSocketData = (chunk: string): void => {
    this.#responses.push(chunk);
  };
  readonly #onSocketError = (): void => {
    const error = new HopperProcessError(null, {
      providerState: "unreachable",
    });
    this.#failAll(error);
    this.#rememberProcessFailure(error, []);
  };
  readonly #onSocketClose = (): void => {
    if (this.#closing) return;
    const launch = this.#resources.launch;
    if (
      launch?.providerLifetime === "launcher-process" &&
      this.#launcherExitCode !== undefined
    )
      return;
    if (launch?.providerLifetime === "launcher-process") {
      setImmediate(() => {
        if (this.#closing || this.#launcherExitCode !== undefined) return;
        const exitCode = launch.process.exitCode ?? null;
        const error = new HopperProcessError(exitCode, {
          diagnostic: this.#launcherFailureDiagnostic,
          providerState: exitCode !== null ? "exited" : "unreachable",
        });
        this.#failAll(error);
        this.#rememberProcessFailure(error, []);
      });
      return;
    }
    const error = new HopperProcessError(null, {
      providerState: "unreachable",
    });
    this.#failAll(error);
    this.#rememberProcessFailure(error, []);
  };

  constructor(options: HopperClientOptions) {
    this.#logger = options.logger ?? silentLogger;
    this.#options = {
      ...options,
      startupTimeoutMs:
        options.startupTimeoutMs ?? DEFAULT_HOPPER_STARTUP_TIMEOUT_MS,
    };
    this.#requests = new HopperRequestQueue(
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
      accept: (message) => this.#acceptBridgeMessage(message),
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

  /**
   * Latest operational health for this owned bridge.
   * A recorded exit remains visible after request activity returns to idle.
   */
  operationHealth(): ProviderOperationHealth {
    const failure = this.#operationFailure;
    if (failure !== undefined) {
      const requests: readonly ProviderOperationRequest[] =
        failure.requests.map((request) => ({
          ...request,
          stage: failure.startupFailure
            ? "launch"
            : hopperOperationStage(request.operation),
        }));
      return {
        state: failure.state,
        stage:
          requests.length === 0
            ? failure.startupFailure
              ? "launch"
              : "connection"
            : sharedProviderFailureStage(requests),
        retryAction: providerRetryAction(failure.state, failure.startupFailure),
        exitCode: failure.exitCode,
        requests,
      };
    }
    const activity = this.requestActivity();
    if (activity !== null) {
      const stage = hopperOperationStage(activity.operation);
      return {
        state: "busy",
        stage,
        retryAction: "wait",
        exitCode: null,
        requests: [
          {
            requestId: activity.requestId,
            operation: activity.operation,
            stage,
          },
        ],
      };
    }
    return {
      state: "idle",
      stage: null,
      retryAction: null,
      exitCode: null,
      requests: [],
    };
  }

  /** True only after the authenticated health handshake has completed. */
  isReady(): boolean {
    return (
      this.#ready &&
      this.#socket !== undefined &&
      !this.#socket.destroyed &&
      this.#closePromise === undefined
    );
  }

  /** Launch the bridge once and complete its authenticated health handshake. */
  start(
    signal?: AbortSignal,
  ): Promise<Result<HopperServerInfo, AnalysisError>> {
    if (this.#closePromise !== undefined) {
      return this.#closePromise.then((closed) =>
        closed.ok ? this.start(signal) : closed,
      );
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
        if (!result.ok) {
          this.#rememberStartupFailure(result.error);
          reset();
        } else this.#ready = true;
      },
      (cause: unknown) => {
        this.#logger.debug(
          { error: cause instanceof Error ? cause.message : String(cause) },
          "Hopper startup promise rejected during bookkeeping",
        );
        release();
        reset();
      },
    );
    return started;
  }

  async #start(
    signal?: AbortSignal,
  ): Promise<Result<HopperServerInfo, AnalysisError>> {
    if (isAborted(signal)) return err(new HopperCancelledError());
    if (
      this.#socket !== undefined ||
      this.#resources.launch !== undefined ||
      this.#resources.runtimeRoot !== undefined
    ) {
      return err(
        this.#startupFailureResult ??
          new HopperProtocolError("Hopper client is already started"),
      );
    }
    this.#operationFailure = undefined;
    this.#startupFailureResult = undefined;
    this.#resources.shutdownConfirmed = false;
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
  ): Promise<Result<HopperServerInfo, AnalysisError>> {
    try {
      this.#resources.runtimeRoot = await PrivateRuntimeRoot.create({
        parent: SESSION_ROOT,
        prefix: "rea-",
      });
    } catch (cause: unknown) {
      return err(new HopperStartError({ cause }));
    }
    if (deadline.signal.aborted) {
      return this.#startupFailure(await this.#startupInterruption(deadline));
    }
    const socketPath = join(this.#resources.runtimeRoot.path, "bridge.sock");
    this.#token = randomBytes(32).toString("hex");
    this.#lineage.reset();
    this.#launcherExitCode = undefined;
    this.#launcherFailureDiagnostic = undefined;
    const runId = this.#options.runId ?? randomUUID();
    this.#runId = runId;
    const launched: Result<
      BridgeLaunch,
      HopperStartError | HopperCancelledError | HopperProcessError
    > = await this.#options.launcher
      .launch(
        {
          directory: this.#resources.runtimeRoot.path,
          socketPath,
          token: this.#token,
          runId,
        },
        { signal: deadline.signal },
      )
      .catch((cause: unknown) => err(new HopperStartError({ cause })));
    if (!launched.ok) {
      return this.#startupFailure(
        deadline.signal.aborted
          ? await this.#startupInterruption(deadline)
          : launched.error,
      );
    }
    this.#resources.launch = launched.value;
    this.#attachLauncher(launched.value);
    const ownership = launched.value.ownership;
    if (ownership !== undefined) {
      try {
        await writeFileAtomic(
          join(this.#resources.runtimeRoot.path, "ownership.json"),
          `${JSON.stringify({
            run_id: runId,
            pid: ownership.leaderPid,
            process_group_id: ownership.processGroupId,
            parent_pid: process.pid,
            launcher: launched.value.launcherCommand ?? null,
            created_at: new Date().toISOString(),
          })}\n`,
          { encoding: "utf8", mode: 0o600 },
        );
      } catch (cause: unknown) {
        return this.#startupFailure(new HopperStartError({ cause }));
      }
    }
    const connected = await this.#connect(socketPath, deadline);
    if (!connected.ok) {
      return this.#startupFailure(connected.error);
    }
    const remainingMs = deadline.remainingMs();
    if (remainingMs <= 0) {
      return this.#startupFailure(await this.#startupInterruption(deadline));
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
      return this.#startupFailure(
        deadline.signal.aborted || health.error instanceof HopperTimeoutError
          ? await this.#startupInterruption(deadline)
          : health.error,
      );
    }
    const parsed = parseHopperServerInfo(health.value, runId);
    if (!parsed.ok) return this.#startupFailure(parsed.error);
    await this.#lineage.observe(this.#resources.launch);
    return parsed;
  }

  async #startupFailure(
    primary: AnalysisError,
  ): Promise<Result<never, AnalysisError>> {
    this.#rememberStartupFailure(primary);
    // Failed readiness never authorized this connection to mutate a document.
    this.#releaseTransport();
    const closed = await this.#cleanup();
    const failure = closed.ok
      ? primary
      : analysisErrorWithCleanupFailure(primary, closed.error, "open_binary");
    this.#startupFailureResult = failure;
    return err(failure);
  }

  #rememberStartupFailure(failure: AnalysisError): void {
    if (failure instanceof HopperProcessError)
      this.#rememberProcessFailure(failure, []);
    else if (this.#operationFailure === undefined)
      this.#operationFailure = {
        state:
          failure instanceof HopperTimeoutError ? "not_started" : "unknown",
        exitCode: null,
        startupFailure: true,
        requests: [],
      };
  }

  /** Invoke one declared operation, returning timeout and cancellation as values. */
  async callTool(
    name: string,
    arguments_: Readonly<Record<string, JsonValue>> = {},
    options: {
      readonly signal?: AbortSignal;
      /** Deadline after startup, including waiting for Hopper's serial bridge. */
      readonly timeoutMs?: number;
      readonly progress?: ProgressReporter;
    } = {},
  ): Promise<Result<JsonValue, AnalysisError>> {
    const started = await this.start(options.signal);
    if (!started.ok) return started;
    return this.#normalizeToolResult(
      name,
      await this.#request(name, arguments_, options),
    );
  }

  /** Dispatch against the connected bridge without invoking startup or retry. */
  callToolIfReady(
    name: string,
    arguments_: Readonly<Record<string, JsonValue>> = {},
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<Result<JsonValue, AnalysisError> | undefined> {
    if (!this.isReady()) return Promise.resolve(undefined);
    return this.#request(name, arguments_, options).then((result) =>
      this.#normalizeToolResult(name, result),
    );
  }

  #normalizeToolResult(
    name: string,
    result: Result<JsonValue, AnalysisError>,
  ): Result<JsonValue, AnalysisError> {
    return !result.ok &&
      result.error instanceof HopperRemoteError &&
      result.error.diagnosticType === "capability_unavailable"
      ? err(
          new AnalysisCapabilityUnavailableError(
            "hopper",
            name,
            result.error.safeMessage,
          ),
        )
      : result;
  }

  /** Stop the bridge and report whether every owned resource was verified clean. */
  close(
    options: HopperClientCloseOptions = {},
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
    starting: Promise<Result<HopperServerInfo, AnalysisError>> | undefined,
    controller: AbortController | undefined,
    options: HopperClientCloseOptions,
  ): Promise<Result<null, AnalysisError>> {
    try {
      // best-effort cleanup: a rejected startup must not mask close/cleanup;
      // #cleanup reports the authoritative close result.
      await starting?.catch(() => undefined);
      await this.#reconnectForCleanup();
      return await this.#cleanup(options);
    } finally {
      if (this.#startPromise === starting) this.#startPromise = undefined;
      if (this.#startupController === controller) {
        this.#startupController = undefined;
      }
      this.#closePromise = undefined;
    }
  }

  /** Reauthenticate this run after late readiness or a lost transport. */
  async #reconnectForCleanup(): Promise<void> {
    if (this.#socket?.destroyed === true) this.#releaseTransport();
    const root = this.#resources.runtimeRoot;
    const runId = this.#runId;
    if (
      this.#socket !== undefined ||
      root === undefined ||
      runId === undefined ||
      this.#token === undefined ||
      this.#resources.shutdownConfirmed ||
      this.#resources.launch?.providerLifetime !== "external-application"
    )
      return;
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      HOPPER_SHUTDOWN_TIMEOUT_MS,
    );
    this.#closing = true;
    try {
      const socketPath = join(root.path, "bridge.sock");
      let connected = await connectHopperSocketOnce(
        socketPath,
        controller.signal,
      );
      while (!connected.ok) {
        const cause = connected.error.cause;
        if (
          !(
            cause instanceof Error &&
            "code" in cause &&
            (cause.code === "ENOENT" || cause.code === "ECONNREFUSED")
          )
        )
          return;
        if ((await waitForAbortableDelay(50, controller.signal)) === "aborted")
          return;
        connected = await connectHopperSocketOnce(
          socketPath,
          controller.signal,
        );
      }
      const socket = connected.value;
      this.#socket = socket;
      this.#attachSocket(socket);
      const health = await this.#request(
        "health",
        {},
        {
          signal: controller.signal,
          timeoutMs: HOPPER_SHUTDOWN_TIMEOUT_MS,
        },
      );
      if (health.ok && parseHopperServerInfo(health.value, runId).ok) return;
      this.#releaseTransport();
    } finally {
      this.#closing = false;
      clearTimeout(timer);
    }
  }

  async #cleanup(
    options: HopperClientCloseOptions = {},
  ): Promise<Result<null, AnalysisError>> {
    this.#closing = true;
    this.#ready = false;
    try {
      return await cleanupHopperSession({
        socket: this.#socket,
        resources: this.#resources,
        activeRequest: this.#requests.activity(),
        progress: options.progress,
        logger: this.#logger,
        onDiagnostic: this.#options.onDiagnostic,
        request: (method) =>
          this.#request(method, {}, { timeoutMs: HOPPER_SHUTDOWN_TIMEOUT_MS }),
        retainDocument: options.retainDocument === true,
        releaseTransport: () => this.#releaseTransport(),
      });
    } finally {
      if (this.#socket?.destroyed === true) this.#socket = undefined;

      // Retained external launches may publish their authenticated socket later.
      if (this.#resources.runtimeRoot === undefined) {
        this.#token = undefined;
        this.#runId = undefined;
      }
      if (this.#socket === undefined) this.#responses.reset();
      if (this.#resources.processSupervisor === undefined) {
        this.#launcherExitCode = undefined;
        this.#launcherFailureDiagnostic = undefined;
      }
      this.#closing = false;
    }
  }

  async #connect(
    socketPath: string,
    deadline: ProviderStartupDeadline,
  ): Promise<Result<undefined, HopperError>> {
    while (deadline.remainingMs() > 0) {
      if (deadline.signal.aborted)
        return err(await this.#startupInterruption(deadline));
      if (this.#closing) return err(new HopperProcessError(null));
      if (
        this.#launcherExitCode !== undefined &&
        this.#resources.launch !== undefined &&
        (this.#resources.launch.providerLifetime === "launcher-process" ||
          this.#launcherExitCode !== 0)
      ) {
        const failure = await this.#launcherStartupFailure(
          this.#resources.launch.providerLifetime === "launcher-process",
          this.#launcherExitCode,
          deadline,
        );
        return deadline.interruption === "cancelled"
          ? err(await this.#startupInterruption(deadline))
          : err(failure);
      }
      try {
        await access(socketPath);
      } catch (cause: unknown) {
        // best-effort cleanup: socket polling; absence means keep waiting.
        void cause;
        if ((await deadline.wait(50)) === "aborted")
          return err(await this.#startupInterruption(deadline));
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
        return err(await this.#startupInterruption(deadline));
    }
    return err(await this.#startupInterruption(deadline));
  }

  async #startupInterruption(
    deadline: ProviderStartupDeadline,
  ): Promise<HopperCancelledError | HopperTimeoutError> {
    if (deadline.interruption === "cancelled")
      return new HopperCancelledError();
    return new HopperTimeoutError(
      deadline.timeoutMs,
      undefined,
      undefined,
      "not_started",
      "launch",
      this.#launcherOutcome(
        (await this.#resources.processSupervisor?.waitForOutputClose(0)) ??
          false,
      ),
    );
  }

  #launcherOutcome(outputClosed: boolean): HopperLauncherOutcome | undefined {
    const snapshot = this.#resources.processSupervisor?.snapshot();
    const token = this.#token;
    if (snapshot === undefined) return undefined;
    return {
      exit_code: snapshot.exitCode ?? null,
      signal: snapshot.signal ?? null,
      stdout: {
        text: redactCapturedTransportCredential(
          snapshot.stdout,
          token,
          "[redacted transport credential]",
        ),
        bytes: snapshot.stdout.observedBytes,
        retained_bytes: snapshot.stdout.bytes,
      },
      stderr: {
        text: redactCapturedTransportCredential(
          snapshot.stderr,
          token,
          "[redacted transport credential]",
        ),
        bytes: snapshot.stderr.observedBytes,
        retained_bytes: snapshot.stderr.bytes,
      },
      output_closed: outputClosed,
      diagnostic_truncated: snapshot.diagnosticTruncated === true,
    };
  }

  async #launcherStartupFailure(
    ownsProviderLifetime: boolean,
    exitCode: number | null,
    deadline: ProviderStartupDeadline,
  ): Promise<HopperError> {
    const process = this.#resources.processSupervisor;
    // Descendants may inherit the helper's pipes. Bound drainage independently
    // from readiness, and report whether producer output actually closed.
    const outputClosed =
      (await process?.waitForOutputClose(
        Math.min(1_000, deadline.remainingMs()),
      )) ?? false;
    const launcherFailure = this.#launcherOutcome(outputClosed);
    if (ownsProviderLifetime)
      return new HopperProcessError(exitCode, {
        diagnostic: this.#launcherFailureDiagnostic,
        providerState: "exited",
        stage: "launch",
        launcherFailure,
      });
    if (
      this.#resources.launch?.authorizationDenialBeforeHandoff === true &&
      nativeHopperLaunchWasDenied(launcherFailure)
    ) {
      this.#resources.shutdownConfirmed = true;
      return new HopperStartError({
        userMessage:
          "macOS denied permission to send Apple Events to Hopper. Allow the application that starts REA under System Settings > Privacy & Security > Automation, then retry opening the target.",
        launcherFailure,
      });
    }
    return new HopperStartError({
      userMessage:
        "Hopper's launcher helper failed before bridge readiness. Review details.launcher and complete Hopper setup before retrying.",
      ...(launcherFailure === undefined ? {} : { launcherFailure }),
    });
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
    const id = this.#nextId++;
    if (
      this.#resources.launch?.providerLifetime === "launcher-process" &&
      this.#launcherExitCode !== undefined
    ) {
      return this.#unavailableRequest(
        new HopperProcessError(this.#launcherExitCode, {
          diagnostic: this.#launcherFailureDiagnostic,
          operation: method,
          requestId: id,
          providerState: "exited",
          stage: hopperOperationStage(method),
          launcherFailure: this.#launcherOutcome(
            (await this.#resources.processSupervisor?.waitForOutputClose(0)) ??
              false,
          ),
        }),
      );
    }
    const socket = this.#socket;
    const token = this.#token;
    if (socket === undefined || socket.destroyed || token === undefined) {
      return this.#unavailableRequest(
        new HopperProcessError(null, {
          operation: method,
          requestId: id,
          providerState: "unreachable",
          stage: hopperOperationStage(method),
        }),
      );
    }
    if (options.signal?.aborted === true)
      return err(new HopperCancelledError());
    const startedAt = performance.now();
    const result = await this.#requests.run(id, method, params, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs }),
      ...(options.progress !== undefined ? { progress: options.progress } : {}),
    });
    this.#retainRequestHealth(result, id, method);
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

  #acceptBridgeMessage(message: HopperBridgeMessage): boolean {
    if (!("event" in message))
      return this.#requests.accept(message.id, responseResult(message));
    if (!this.#requests.acceptEvent(message)) return false;
    this.#emitBridgeDiagnostic(message);
    return true;
  }

  #emitBridgeDiagnostic(message: HopperBridgeEvent): void {
    if (message.event.type !== "diagnostic") return;
    try {
      this.#options.onDiagnostic?.({
        type: "bridge-diagnostic",
        request_id: message.id,
        code: message.event.error.code,
        category: message.event.error.type,
        message: message.event.error.message,
      });
    } catch (cause: unknown) {
      // best-effort cleanup: diagnostic consumers must not break the client.
      void cause;
      this.#logger.warn(
        { requestId: message.id },
        "Hopper bridge diagnostic consumer rejected an event",
      );
    }
  }

  #detachSocket(socket: Socket): void {
    socket.off("data", this.#onSocketData);
    socket.off("error", this.#onSocketError);
    socket.off("close", this.#onSocketClose);
  }

  #releaseTransport(): void {
    const socket = this.#socket;
    this.#socket = undefined;
    this.#failAll(new HopperProcessError(null));
    if (socket !== undefined) this.#detachSocket(socket);
    socket?.destroy();
    this.#responses.reset();
  }

  #attachLauncher(launch: BridgeLaunch): void {
    this.#resources.processSupervisor = new ProviderProcessSupervisor(launch, {
      maxDiagnosticBytes: HOPPER_PROCESS_DIAGNOSTIC_BYTES,
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
    if (launch.providerLifetime === "launcher-process" && !this.#closing) {
      this.#rememberExit(event.code);
      this.#failAll(
        new HopperProcessError(event.code, {
          diagnostic: this.#launcherFailureDiagnostic,
          providerState: "exited",
          launcherFailure: this.#launcherOutcome(false),
        }),
      );
    }
  }

  #abortProtocol(message: string, cause?: Error): void {
    this.#failAll(new HopperProtocolError(message, { cause }));
    this.#socket?.destroy();
  }

  #failAll(error: HopperError): void {
    this.#requests.failAll(error);
  }

  #unavailableRequest(
    error: HopperProcessError,
  ): Result<JsonValue, HopperProcessError> {
    this.#rememberProcessFailure(
      error,
      error.requestId === undefined || error.operation === undefined
        ? []
        : [{ requestId: error.requestId, operation: error.operation }],
    );
    return err(error);
  }

  #retainRequestHealth(
    result: Result<JsonValue, HopperError>,
    requestId: number,
    operation: string,
  ): void {
    if (this.#closing) return;
    if (result.ok) return;
    if (!(result.error instanceof HopperProcessError)) return;
    this.#rememberProcessFailure(result.error, [
      {
        requestId: result.error.requestId ?? requestId,
        operation: result.error.operation ?? operation,
      },
    ]);
  }

  #rememberExit(code: number | null): void {
    if (this.#closing) return;
    const previous = this.#operationFailure;
    this.#operationFailure = {
      state: "exited",
      exitCode: code ?? previous?.exitCode ?? null,
      startupFailure:
        hopperStartupFailure(code) !== undefined ||
        previous?.startupFailure === true,
      requests: previous?.requests ?? [],
    };
  }

  #rememberProcessFailure(
    error: HopperProcessError,
    requests: readonly FailedProviderRequest[],
  ): void {
    if (this.#closing) return;
    const previous = this.#operationFailure;
    const state = processFailureState(error);
    const startupFailure =
      error.stage === "launch" ||
      error.failureCode !== undefined ||
      previous?.startupFailure === true;
    const merged = mergeFailedRequests(previous?.requests ?? [], requests);
    if (
      previous !== undefined &&
      PROCESS_FAILURE_RANK[previous.state] > PROCESS_FAILURE_RANK[state]
    ) {
      this.#operationFailure = {
        ...previous,
        startupFailure,
        requests: merged,
      };
      return;
    }
    this.#operationFailure = {
      state,
      exitCode:
        state === "exited"
          ? (error.exitCode ?? previous?.exitCode ?? null)
          : null,
      startupFailure,
      requests: merged,
    };
  }
}

interface FailedProviderRequest {
  readonly requestId: number;
  readonly operation: string;
}

interface OperationFailureRecord {
  readonly state: "exited" | "unreachable" | "unknown" | "not_started";
  readonly exitCode: number | null;
  readonly startupFailure: boolean;
  readonly requests: readonly FailedProviderRequest[];
}

const PROCESS_FAILURE_RANK = {
  not_started: 0,
  unknown: 0,
  unreachable: 1,
  exited: 2,
} as const;

const processFailureState = (
  error: HopperProcessError,
): OperationFailureRecord["state"] =>
  error.providerState === "exited" || error.exitCode !== null
    ? "exited"
    : error.providerState;

const mergeFailedRequests = (
  current: readonly FailedProviderRequest[],
  added: readonly FailedProviderRequest[],
): readonly FailedProviderRequest[] => {
  const byId = new Map<number, FailedProviderRequest>();
  for (const request of [...current, ...added])
    byId.set(request.requestId, request);
  return [...byId.values()].sort(
    (left, right) => left.requestId - right.requestId,
  );
};

const isAborted = (signal?: AbortSignal): boolean => signal?.aborted === true;
