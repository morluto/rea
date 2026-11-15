import { HOST_PLATFORM } from "../platform/HostPlatform.js";
import {
  JsonLineBridgeReader,
  type JsonLineBridgeFailure,
} from "../process/JsonLineBridgeReader.js";
import { analysisSettingLimit } from "../domain/analysisSettingDefinitions.js";
import { randomBytes, randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import writeFileAtomic from "write-file-atomic";

import { AnalysisCleanupRelease } from "../domain/analysisCleanupRelease.js";
import {
  analysisErrorWithCloseRejection,
  analysisErrorWithCloseRejections,
} from "../domain/analysisErrorCleanup.js";
import { analysisClientFailureContext } from "../providers/AnalysisClientFailure.js";
import {
  AnalysisCapabilityUnavailableError,
  OwnerCancellation,
} from "../domain/analysisErrorCore.js";
import {
  hopperBridgeReplyContracts,
  parseHopperReply,
  type HopperBridgeReplyContracts,
  type ValueKeepingContracts,
  type HopperContractReply,
  type HopperReplyContracts,
  parseHopperServerInfo,
  type HopperServerInfo,
} from "./HopperReplyContracts.js";
import {
  hopperCancelledBySignal,
  type HopperCancelledError,
  type HopperError,
  type HopperLauncherOutcome,
  HopperProcessError,
  HopperProtocolError,
  HopperRemoteError,
  HopperStartError,
  HopperTimeoutError,
} from "../domain/hopperErrors.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { readRuntimeSetting } from "../config/runtimeAnalysisSettings.js";
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
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { jsonValueByteLength } from "../domain/jsonValueByteLength.js";
import type { ProgressReporter } from "../ports/ProgressReporter.js";
import { silentLogger } from "../logger.js";
import type { Logger } from "pino";
import { PrivateRuntimeRoot } from "../process/PrivateRuntimeRoot.js";
import {
  ProviderStartupDeadline,
  waitForAbortableDelay,
} from "../process/ProviderDeadline.js";
import { redactExplicitOutput } from "../domain/explicitSensitiveValues.js";
import { ProviderRunLineage } from "../process/ProviderRunLineage.js";
import { AbortedWait, waitForAbortable } from "../process/AbortablePromise.js";
import { SharedStartupAttempt } from "../process/SharedStartupAttempt.js";
import {
  type ProviderProcessDiagnostic,
  ProviderProcessSupervisor,
} from "../process/ProviderProcess.js";
import { observeProcessStartIdentity } from "../process/ProcessOwnershipObservation.js";
import type { BridgeLaunch, BridgeLauncher } from "./BridgeLauncher.js";
import { hopperOperationStage } from "./HopperOperationStage.js";
import type { HopperDiagnostic } from "./HopperDiagnostics.js";
import {
  cleanupHopperSession,
  confirmExternalApplicationExit,
  type HopperOwnedResources,
} from "./HopperCleanup.js";
import { HOPPER_SHUTDOWN_TIMEOUT_MS } from "./HopperSessionValues.js";
import { connectHopperSocketOnce } from "./HopperSocketConnection.js";
import {
  hopperLauncherFailureDiagnostic,
  hopperLauncherReportedApplicationNotFound,
  nativeHopperLaunchWasDenied,
} from "./HopperProcessDiagnostic.js";
import { DEFAULT_HOPPER_STARTUP_TIMEOUT_MS } from "../domain/analysisResourceLimits.js";
import {
  admitBridgeRequestLimit,
  bridgeRequestLimitMismatchError,
  bridgeRequestOversizeError,
  DEFAULT_BRIDGE_MAX_REQUEST,
  type BridgeMaxRequestBytes,
} from "../config/bridgeMaxRequestBytes.js";
import {
  admitBridgeReplyLimit,
  bridgeReplyOversizeError,
  DEFAULT_BRIDGE_MAX_REPLY,
  type BridgeMaxReplyBytes,
} from "../config/bridgeMaxReplyBytes.js";
import {
  HopperRequestQueue,
  type HopperRequestActivity,
} from "./HopperRequestQueue.js";
import {
  type HopperBridgeEvent,
  type HopperBridgeMessage,
  hopperReplyEnvelope,
  responseResult,
} from "./protocol.js";

/** Aggregate in-memory retention budget for this provider's launcher output. */
const HOPPER_PROCESS_DIAGNOSTIC_BYTES = 8 * 1024 * 1024;

const SESSION_ROOT = HOST_PLATFORM.platform === "darwin" ? "/tmp" : tmpdir();

/** Dependencies, deadlines, and redacted diagnostics for one bridge client. */
export interface HopperClientOptions<
  Contracts extends HopperReplyContracts = HopperBridgeReplyContracts,
> {
  readonly launcher: BridgeLauncher;
  /**
   * Reply contract for each callable method. Production uses the bridge's
   * `hopperReplySchemas`; transport tests supply their own methods.
   */
  readonly replyContracts?: Contracts & ValueKeepingContracts<Contracts>;
  readonly runId?: string;
  readonly startupTimeoutMs?: number;
  readonly readStartupTimeoutMs?: () => number;
  /** Selection owner for the startup deadline. Absent when the caller did not record it. */
  readonly readStartupTimeoutSource?: () =>
    | "default"
    | "setting"
    | "runtime"
    | undefined;
  /** Effective request ceiling. Omitted uses the 16 MiB default. */
  readonly bridgeMaxRequestBytes?: BridgeMaxRequestBytes;
  /** Effective reply line ceiling. Omitted uses the 256 MiB default. */
  readonly bridgeMaxReplyBytes?: BridgeMaxReplyBytes;
  readonly onDiagnostic?: (event: HopperDiagnostic) => void;
  readonly logger?: Logger;
}

/** Bridge ceilings admitted when a session started, kept for its cleanup. */
interface HopperSessionLimits {
  readonly requestLimit: BridgeMaxRequestBytes;
  readonly replyLimit: BridgeMaxReplyBytes;
}

type HopperStartupResult = Result<HopperServerInfo, AnalysisError>;
type HopperStartupAttempt = SharedStartupAttempt<HopperStartupResult>;
type HopperStartupOutcome =
  | { readonly kind: "interrupted" }
  | {
      readonly kind: "launcher-exit";
      readonly exitCode: number | null;
      readonly ownsProviderLifetime: boolean;
    };

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
export class HopperClient<
  Contracts extends HopperReplyContracts = HopperBridgeReplyContracts,
> {
  readonly #options: Required<
    Pick<HopperClientOptions, "startupTimeoutMs" | "bridgeMaxRequestBytes">
  > &
    HopperClientOptions<Contracts>;
  readonly #contracts: Contracts & ValueKeepingContracts<Contracts>;
  readonly #requests: HopperRequestQueue;
  readonly #responses: JsonLineBridgeReader<
    HopperBridgeMessage,
    HopperRemoteError
  >;
  readonly #logger: Logger;
  #socket: Socket | undefined;
  readonly #resources: HopperOwnedResources = {
    launch: undefined,
    processSupervisor: undefined,
    runtimeRoot: undefined,
    shutdownConfirmed: false,
    externalApplication: undefined,
  };
  #token: string | undefined;
  /** Reply ceiling admitted with the request on the wire; the default before any. */
  #replyLimit: BridgeMaxReplyBytes = DEFAULT_BRIDGE_MAX_REPLY;
  #sessionLimits: HopperSessionLimits | undefined;
  readonly #lineage = new ProviderRunLineage();
  #nextId = 1;
  #closing = false;
  #launcherExitCode: number | null | undefined;
  #launcherFailureDiagnostic: HopperStartupFailureDiagnostic | undefined;
  #startupOutcome: HopperStartupOutcome | undefined;
  #startupSignal: AbortSignal | undefined;
  #operationFailure: OperationFailureRecord | undefined;
  #startupFailureResult: AnalysisError | undefined;
  #runId: string | undefined;
  #startupAttempt: HopperStartupAttempt | undefined;
  #closePromise: Promise<Result<null, AnalysisError>> | undefined;
  /**
   * Confirm the failures a close of this client reported, one release per
   * part: the next close retries the same retained session and launcher, and
   * each part's success releases only the failures that part reported.
   */
  readonly #closeRetries: {
    session: AnalysisCleanupRelease | undefined;
    launcher: AnalysisCleanupRelease | undefined;
  } = { session: undefined, launcher: undefined };
  readonly #onSocketData = (chunk: Buffer): void => {
    this.#responses.push(chunk);
  };
  readonly #onSocketEnd = (): void => {
    this.#responses.finish();
  };
  readonly #onSocketError = (): void => {
    const error = new HopperProcessError(null, {
      providerState: "unreachable",
    });
    this.#failAll(error);
    this.#rememberProcessFailure(error, []);
  };
  readonly #onSocketClose = (): void => {
    if (this.#closing) {
      this.#failAll(
        new HopperProcessError(null, { providerState: "unreachable" }),
      );
      return;
    }
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

  constructor(options: HopperClientOptions<Contracts>) {
    this.#logger = options.logger ?? silentLogger;
    // The default type argument is the production table this default supplies.
    // Without a table the type argument is its default, the production table.
    // A caller that names another type argument but omits its table gets a
    // typed refusal per method (see #typedReply), never a throw.
    this.#contracts =
      options.replyContracts ??
      (hopperBridgeReplyContracts as unknown as Contracts &
        ValueKeepingContracts<Contracts>);
    this.#options = {
      ...options,
      startupTimeoutMs:
        options.startupTimeoutMs ?? DEFAULT_HOPPER_STARTUP_TIMEOUT_MS,
      bridgeMaxRequestBytes:
        options.bridgeMaxRequestBytes ?? DEFAULT_BRIDGE_MAX_REQUEST,
    };
    this.#requests = new HopperRequestQueue(
      ({ id, method, params, requestLimit, replyLimit }, failed) => {
        const socket = this.#socket;
        const token = this.#token;
        if (socket === undefined || socket.destroyed || token === undefined) {
          failed();
          return;
        }
        // The FIFO keeps the caller's params. The encoded frame exists only
        // for the request that has reached the wire.
        const payloadValue = { id, token, method, params };
        let payload: string;
        try {
          payload = JSON.stringify(payloadValue);
        } catch (cause: unknown) {
          this.#requests.accept(
            id,
            err(
              new HopperProtocolError("Hopper socket write failed", { cause }),
            ),
          );
          return;
        }
        const payloadBytes = Buffer.byteLength(payload);
        const admitted = requestLimit ?? DEFAULT_BRIDGE_MAX_REQUEST;
        if (payloadBytes > admitted.maximumBytes) {
          this.#requests.accept(
            id,
            err(
              bridgeRequestOversizeError(
                method,
                admitted,
                payloadBytes,
                "Hopper",
              ),
            ),
          );
          return;
        }
        // This request now owns the wire, so its admitted ceiling bounds the
        // next reply; a queued or refused request never changes it.
        this.#replyLimit = replyLimit ?? DEFAULT_BRIDGE_MAX_REPLY;
        socket.write(`${payload}\n`, (cause) => {
          if (cause !== undefined && cause !== null) failed();
        });
      },
    );
    this.#responses = new JsonLineBridgeReader({
      envelope: hopperReplyEnvelope,
      maxReplyBytes: () => this.#replyLimit.maximumBytes,
      deliver: (message) => this.#acceptBridgeMessage(message),
      wasSent: (id) => id < this.#nextId && !this.#requests.hasQueued(id),
      rejectInFlight: (cause) => this.#requests.failActive(cause),
      fail: (failure) => this.#abortReplyStream(failure),
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
    if (
      this.#closing ||
      this.#closePromise !== undefined ||
      (!this.#startupSucceeded() &&
        this.#startupAttempt !== undefined &&
        this.#operationFailure === undefined)
    ) {
      return {
        state: "busy",
        stage:
          this.#closing || this.#closePromise !== undefined
            ? "connection"
            : "launch",
        retryAction: "wait",
        exitCode: null,
        requests: [],
      };
    }
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

  /** Read completion from the current attempt; no independent readiness flag. */
  #startupSucceeded(): boolean {
    const startup = this.#startupAttempt?.settlement;
    return startup?.status === "completed" && startup.value.ok;
  }

  /** True only after the authenticated health handshake has completed. */
  isReady(): boolean {
    return (
      this.#startupSucceeded() &&
      this.#socket !== undefined &&
      !this.#socket.destroyed &&
      !this.#closing &&
      this.#closePromise === undefined
    );
  }

  /** Launch the bridge once while each caller retains its own cancellation. */
  start(signal?: AbortSignal): Promise<HopperStartupResult> {
    if (isAborted(signal))
      return Promise.resolve(err(hopperCancelledBySignal(signal)));
    if (this.#closePromise !== undefined)
      return waitForAbortable(this.#closePromise, signal).then((closed) =>
        closed instanceof AbortedWait
          ? err(hopperCancelledBySignal(signal))
          : closed.ok
            ? this.start(signal)
            : closed,
      );
    const current = this.#startupAttempt;
    if (current !== undefined)
      return current.signal.aborted
        ? this.#retryAfterAbortedStartup(current, signal)
        : this.#waitForStartup(current, signal);
    const attempt = new SharedStartupAttempt((signal) => this.#start(signal));
    this.#startupAttempt = attempt;
    void attempt.promise.then(
      (result) => {
        if (!result.ok) {
          this.#rememberStartupFailure(result.error);
          if (this.#startupAttempt === attempt)
            this.#startupAttempt = undefined;
        }
      },
      (cause: unknown) => {
        this.#logger.debug(
          { error: cause instanceof Error ? cause.message : String(cause) },
          "Hopper startup promise rejected during bookkeeping",
        );
        if (this.#startupAttempt === attempt) this.#startupAttempt = undefined;
      },
    );
    return this.#waitForStartup(attempt, signal);
  }

  async #waitForStartup(
    attempt: HopperStartupAttempt,
    signal?: AbortSignal,
  ): Promise<HopperStartupResult> {
    const waited = await attempt.wait(signal);
    if (waited.status === "completed") return waited.value;
    if (waited.status === "stopped" && !waited.value.ok) return waited.value;
    return err(hopperCancelledBySignal(signal));
  }

  /** Cleanup belongs to the abandoned attempt, never to a prospective retry. */
  async #retryAfterAbortedStartup(
    attempt: HopperStartupAttempt,
    signal?: AbortSignal,
  ): Promise<HopperStartupResult> {
    const waited = await waitForAbortable(attempt.promise, signal);
    if (waited instanceof AbortedWait || (waited.ok && isAborted(signal)))
      return err(hopperCancelledBySignal(signal));
    if (waited.ok || waited.error.cleanupIncomplete) return waited;
    return this.start(signal);
  }

  async #start(
    signal?: AbortSignal,
  ): Promise<Result<HopperServerInfo, AnalysisError>> {
    if (isAborted(signal)) return err(hopperCancelledBySignal(signal));
    if (
      this.#socket !== undefined ||
      this.#resources.launch !== undefined ||
      this.#resources.runtimeRoot !== undefined ||
      this.#startupFailureResult?.cleanupIncomplete === true
    ) {
      return err(
        this.#startupFailureResult ??
          new HopperProtocolError("Hopper client is already started"),
      );
    }
    const startupTimeout = readRuntimeSetting(
      () =>
        this.#options.readStartupTimeoutMs?.() ??
        this.#options.startupTimeoutMs,
    );
    if (!startupTimeout.ok) return startupTimeout;
    const startupTimeoutMs = startupTimeout.value;
    this.#operationFailure = undefined;
    this.#startupFailureResult = undefined;
    this.#resources.shutdownConfirmed = false;
    this.#resources.externalApplication = undefined;
    const deadline = new ProviderStartupDeadline(startupTimeoutMs, signal);
    this.#startupOutcome = undefined;
    this.#startupSignal = deadline.signal;
    const onStartupAbort = (): void => {
      if (this.#startupOutcome === undefined)
        this.#startupOutcome = { kind: "interrupted" };
    };
    deadline.signal.addEventListener("abort", onStartupAbort, { once: true });
    try {
      const result = await this.#startWithin(deadline);
      return result.ok && deadline.signal.aborted
        ? await this.#startupFailure(await this.#interruptionFailure(deadline))
        : result;
    } finally {
      deadline.signal.removeEventListener("abort", onStartupAbort);
      if (this.#startupSignal === deadline.signal)
        this.#startupSignal = undefined;
      deadline.dispose();
    }
  }

  async #startWithin(
    deadline: ProviderStartupDeadline,
  ): Promise<Result<HopperServerInfo, AnalysisError>> {
    // Admit both bridge ceilings before acquiring anything: an invalid launch
    // seed is a configuration refusal, not a failure after Hopper started.
    // Cleanup requests reuse these, so a setting reset after startup cannot
    // refuse the shutdown that releases Hopper's document and files.
    const requestLimit = admitBridgeRequestLimit(
      this.#options.bridgeMaxRequestBytes,
    );
    if (!requestLimit.ok) return requestLimit;
    const replyLimit = admitBridgeReplyLimit(
      this.#options.bridgeMaxReplyBytes ?? DEFAULT_BRIDGE_MAX_REPLY,
    );
    if (!replyLimit.ok) return replyLimit;
    this.#sessionLimits = {
      requestLimit: requestLimit.value,
      replyLimit: replyLimit.value,
    };
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
      return this.#startupFailure(await this.#interruptionFailure(deadline));
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
          ? await this.#interruptionFailure(deadline)
          : health.error,
      );
    }
    const parsed = await this.#authenticateServerInfo(health.value, runId);
    if (!parsed.ok) return this.#startupFailure(parsed.error);
    if (
      parsed.value.maxRequestBytes !==
      this.#options.bridgeMaxRequestBytes.maximumBytes
    )
      return this.#startupFailure(
        bridgeRequestLimitMismatchError(
          "hopper_bridge",
          this.#options.bridgeMaxRequestBytes,
          parsed.value.maxRequestBytes,
          "Hopper",
        ),
      );
    try {
      await this.#lineage.observe(this.#resources.launch);
    } catch (cause: unknown) {
      return this.#startupFailure(
        deadline.signal.aborted
          ? await this.#interruptionFailure(deadline)
          : new HopperStartError({ cause }),
      );
    }
    if (deadline.signal.aborted)
      return this.#startupFailure(await this.#interruptionFailure(deadline));
    return parsed;
  }

  /** Bind process identity for both initial and late cleanup handshakes. */
  async #authenticateServerInfo(
    value: JsonValue,
    runId: string,
  ): Promise<Result<HopperServerInfo, HopperProtocolError>> {
    const parsed = parseHopperServerInfo(value, runId);
    if (!parsed.ok) return parsed;
    if (this.#resources.launch?.providerLifetime === "external-application") {
      const application = this.#resources.externalApplication;
      if (
        application !== undefined &&
        application.pid !== parsed.value.processId
      )
        return err(
          new HopperProtocolError(
            "Hopper bridge process changed within the same run",
          ),
        );
      if (application?.identity.state === "readable") return parsed;
      let identity;
      try {
        identity = await observeProcessStartIdentity(parsed.value.processId);
      } catch (cause: unknown) {
        identity = {
          state: "unavailable" as const,
          reason:
            cause instanceof Error
              ? cause.message
              : "process identity observation failed",
        };
      }
      this.#resources.externalApplication = {
        pid: parsed.value.processId,
        identity: identity ?? {
          state: "unavailable",
          reason: "process identity was not returned while Hopper was running",
        },
      };
    }
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
      : analysisErrorWithCloseRejection(primary, closed.error, "open_binary");
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

  /**
   * Invoke one bridge method and validate its reply against that method's
   * contract. Timeout, cancellation and a reply outside the contract
   * (`HopperReplyContractError`, which keeps the raw reply) return as values.
   * `operation` attributes a failure to the analyst operation the method serves.
   */
  async callTool<M extends keyof Contracts & string>(
    method: M,
    arguments_: Readonly<Record<string, JsonValue>> = {},
    options: {
      readonly signal?: AbortSignal;
      /** Deadline after startup, including waiting for Hopper's serial bridge. */
      readonly timeoutMs?: number;
      readonly progress?: ProgressReporter;
      readonly operation?: string;
    } = {},
  ): Promise<Result<HopperContractReply<Contracts, M>, AnalysisError>> {
    const started = await this.start(options.signal);
    if (!started.ok) return started;
    return this.#typedReply(
      method,
      options.operation ?? method,
      await this.#request(method, arguments_, options),
    );
  }

  /** Dispatch against the connected bridge without invoking startup or retry. */
  callToolIfReady<M extends keyof Contracts & string>(
    method: M,
    arguments_: Readonly<Record<string, JsonValue>> = {},
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<
    Result<HopperContractReply<Contracts, M>, AnalysisError> | undefined
  > {
    if (!this.isReady()) return Promise.resolve(undefined);
    return this.#request(method, arguments_, options).then((result) =>
      this.#typedReply(method, method, result),
    );
  }

  #typedReply<M extends keyof Contracts & string>(
    method: M,
    operation: string,
    result: Result<JsonValue, AnalysisError>,
  ): Result<HopperContractReply<Contracts, M>, AnalysisError> {
    const normalized = this.#normalizeToolResult(method, result);
    if (!normalized.ok) return normalized;
    if (this.#contracts[method] === undefined)
      return err(
        new AnalysisCapabilityUnavailableError(
          "hopper",
          operation,
          `No reply contract is installed for the Hopper bridge method ${method}; its reply was not read.`,
        ),
      );
    return parseHopperReply<Contracts, M>(
      this.#contracts,
      method,
      normalized.value,
      operation,
    );
  }

  #normalizeToolResult(
    name: string,
    result: Result<JsonValue, AnalysisError>,
  ): Result<JsonValue, AnalysisError> {
    if (
      result.ok ||
      !(result.error instanceof HopperRemoteError) ||
      result.error.diagnosticType !== "capability_unavailable"
    )
      return result;
    const source = result.error;
    const failure = new AnalysisCapabilityUnavailableError(
      "hopper",
      name,
      source.safeMessage,
      analysisClientFailureContext(source, "hopper", name),
    );
    return err(
      source.cleanupIncomplete
        ? failure.bindCleanupDependencies([source])
        : failure,
    );
  }

  /** Stop the bridge and report whether every owned resource was verified clean. */
  close(
    options: HopperClientCloseOptions = {},
  ): Promise<Result<null, AnalysisError>> {
    const starting = this.#startupAttempt;
    starting?.close();
    this.#closePromise ??= Promise.resolve().then(() =>
      this.#close(starting, options),
    );
    return this.#closePromise;
  }

  async #close(
    starting: HopperStartupAttempt | undefined,
    options: HopperClientCloseOptions,
  ): Promise<Result<null, AnalysisError>> {
    try {
      // best-effort cleanup: a rejected startup must not mask close/cleanup;
      // #cleanup reports the authoritative close result.
      await starting?.promise.catch(() => undefined);
      await confirmExternalApplicationExit(this.#resources, this.#socket, () =>
        this.#releaseTransport(),
      );
      await this.#reconnectForCleanup();
      const closed = await this.#cleanup(options);
      if (closed.ok) this.#startupFailureResult = undefined;
      return closed;
    } finally {
      if (this.#startupAttempt === starting) this.#startupAttempt = undefined;
      this.#closePromise = undefined;
    }
  }

  /**
   * The ceilings this session admitted at start, for its cleanup requests
   * (reauthentication and shutdown): a setting refused after startup must not
   * block the cleanup that releases Hopper's document and files.
   */
  #cleanupLimits(): { readonly limits?: HopperSessionLimits } {
    return this.#sessionLimits === undefined
      ? {}
      : { limits: this.#sessionLimits };
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
      () => controller.abort(OwnerCancellation.deadlineElapsed),
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
          ...this.#cleanupLimits(),
        },
      );
      if (
        health.ok &&
        (await this.#authenticateServerInfo(health.value, runId)).ok
      )
        return;
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
    try {
      const closed = await cleanupHopperSession({
        socket: this.#socket,
        resources: this.#resources,
        activeRequest: this.#requests.activity(),
        progress: options.progress,
        logger: this.#logger,
        onDiagnostic: this.#options.onDiagnostic,
        request: (method) =>
          this.#request(
            method,
            {},
            {
              timeoutMs: HOPPER_SHUTDOWN_TIMEOUT_MS,
              ...this.#cleanupLimits(),
            },
          ),
        retainDocument: options.retainDocument === true,
        releaseTransport: () => this.#releaseTransport(),
      });
      const launcherClosed = await this.#options.launcher
        .cleanup?.()
        .catch((cause: unknown) =>
          err(
            new ProviderCleanupError(
              "hopper",
              ["hopper-launcher"],
              {
                reason: cause instanceof Error ? cause.message : String(cause),
              },
              { cause },
            ),
          ),
        );
      // Each part confirms its own earlier failures when it succeeds; an
      // ownerless failed part binds to its part's retry before composing, so
      // the composite reports only the parts still unreleased. A part that
      // already follows its own owner keeps reading that owner.
      const retries = this.#closeRetries;
      if (closed.ok) {
        retries.session?.confirm();
        retries.session = undefined;
      } else
        (retries.session ??= new AnalysisCleanupRelease()).bindUnowned(
          closed.error,
        );
      if (launcherClosed === undefined || launcherClosed.ok) {
        retries.launcher?.confirm();
        retries.launcher = undefined;
        return closed;
      }
      (retries.launcher ??= new AnalysisCleanupRelease()).bindUnowned(
        launcherClosed.error,
      );
      return closed.ok
        ? launcherClosed
        : err(
            analysisErrorWithCloseRejections(
              closed.error,
              launcherClosed.error,
            ),
          );
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
      const observedExit =
        this.#startupOutcome?.kind === "launcher-exit"
          ? this.#startupOutcome
          : this.#startupOutcome?.kind === "interrupted"
            ? undefined
            : this.#observedLauncherExit();
      // A launcher exit the owned process already holds is a physical startup
      // failure; a cancellation that arrives afterwards must not replace it.
      if (deadline.signal.aborted && observedExit === undefined)
        return err(
          this.#startupOutcome?.kind === "interrupted"
            ? await this.#startupInterruption(deadline)
            : await this.#interruptionFailure(deadline),
        );
      if (this.#closing) return err(new HopperProcessError(null));
      if (observedExit !== undefined)
        return err(
          await this.#launcherStartupFailure(
            observedExit.ownsProviderLifetime,
            observedExit.exitCode,
            deadline,
          ),
        );
      try {
        await access(socketPath);
      } catch (cause: unknown) {
        // best-effort cleanup: socket polling; absence means keep waiting.
        void cause;
        if ((await deadline.wait(50)) === "aborted")
          return err(await this.#interruptionFailure(deadline));
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
        return err(await this.#interruptionFailure(deadline));
    }
    return err(await this.#interruptionFailure(deadline));
  }

  /** A launcher exit the owned process already holds, when it is a failure. */
  #observedLauncherExit():
    | {
        readonly exitCode: number | null;
        readonly ownsProviderLifetime: boolean;
      }
    | undefined {
    const launch = this.#resources.launch;
    if (launch === undefined) return undefined;
    const exit = this.#resources.processSupervisor?.observedExit();
    if (exit === undefined) return undefined;
    const exitCode = exit.code;
    const ownsProviderLifetime = launch.providerLifetime === "launcher-process";
    return ownsProviderLifetime || exitCode === null || exitCode !== 0
      ? { exitCode, ownsProviderLifetime }
      : undefined;
  }

  /** Project an interruption, keeping an exit the owner already observed. */
  async #interruptionFailure(
    deadline: ProviderStartupDeadline,
  ): Promise<HopperError> {
    const observed =
      this.#startupOutcome?.kind === "launcher-exit"
        ? this.#startupOutcome
        : this.#startupOutcome?.kind === "interrupted"
          ? undefined
          : this.#observedLauncherExit();
    return observed === undefined
      ? this.#startupInterruption(deadline)
      : this.#launcherStartupFailure(
          observed.ownsProviderLifetime,
          observed.exitCode,
          deadline,
        );
  }

  async #startupInterruption(
    deadline: ProviderStartupDeadline,
  ): Promise<HopperCancelledError | HopperTimeoutError | HopperProtocolError> {
    if (deadline.signal.reason === OwnerCancellation.startupOwnerClosed)
      return new HopperProtocolError("Hopper session closed during startup");
    if (deadline.interruption === "cancelled")
      return hopperCancelledBySignal(deadline.signal);
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
      {
        limit: analysisSettingLimit(
          "hopper.startup_timeout_ms",
          deadline.timeoutMs,
          this.#options.readStartupTimeoutSource?.(),
        ),
      },
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
        text: redactExplicitOutput(
          snapshot.stdout,
          token === undefined ? [] : [token],
          "[redacted transport credential]",
        ),
        bytes: snapshot.stdout.observedBytes,
        retained_bytes: snapshot.stdout.bytes,
      },
      stderr: {
        text: redactExplicitOutput(
          snapshot.stderr,
          token === undefined ? [] : [token],
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
        launchRejection: {
          boundary: "apple_events_authorization",
          reason: "not_authorized",
        },
        launcherFailure,
      });
    }
    if (hopperLauncherReportedApplicationNotFound(launcherFailure)) {
      // Only the verified native helper's Spotlight exit precedes any target
      // handoff. Wrappers can forward the same message after opening a document.
      if (this.#resources.launch?.nativeHelperVerified === true)
        this.#resources.shutdownConfirmed = true;
      return new HopperStartError({
        userMessage:
          "Hopper's launcher could not find Hopper because it relies on Spotlight. Enable Spotlight indexing for the volume that contains Hopper (for example: sudo mdutil -i on /System/Volumes/Data), wait for indexing to finish, then retry opening the target.",
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
      /** Ceilings already admitted, such as the session's for cleanup. */
      readonly limits?: HopperSessionLimits;
    },
  ): Promise<Result<JsonValue, AnalysisError>> {
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
      return err(hopperCancelledBySignal(options.signal));
    const payloadValue = { id, token, method, params };
    // Count escaped JSON before the request can wait in the FIFO. A rejected
    // payload is not serialized, and an admitted one is serialized only when
    // it reaches the wire. Both ceilings are admitted here, in the caller's
    // context; a queued request is written later outside it.
    const requestLimit =
      options.limits === undefined
        ? admitBridgeRequestLimit(this.#options.bridgeMaxRequestBytes)
        : ok(options.limits.requestLimit);
    if (!requestLimit.ok) return requestLimit;
    const replyLimit =
      options.limits === undefined
        ? admitBridgeReplyLimit(
            this.#options.bridgeMaxReplyBytes ?? DEFAULT_BRIDGE_MAX_REPLY,
          )
        : ok(options.limits.replyLimit);
    if (!replyLimit.ok) return replyLimit;
    const measured = jsonValueByteLength(
      payloadValue,
      requestLimit.value.maximumBytes,
    );
    if (measured > requestLimit.value.maximumBytes)
      return err(
        bridgeRequestOversizeError(
          method,
          requestLimit.value,
          measured,
          "Hopper",
        ),
      );
    const startedAt = performance.now();
    const result = await this.#requests.run(id, method, params, {
      requestLimit: requestLimit.value,
      replyLimit: replyLimit.value,
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
    this.#responses.reset();
    socket.on("data", this.#onSocketData);
    socket.on("end", this.#onSocketEnd);
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
    socket.off("end", this.#onSocketEnd);
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
    if (
      this.#startupSignal !== undefined &&
      this.#startupOutcome === undefined
    ) {
      const ownsProviderLifetime =
        launch.providerLifetime === "launcher-process";
      if (ownsProviderLifetime || event.code === null || event.code !== 0)
        this.#startupOutcome = {
          kind: "launcher-exit",
          exitCode: event.code,
          ownsProviderLifetime,
        };
    }
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

  #abortReplyStream(failure: JsonLineBridgeFailure): void {
    switch (failure.kind) {
      case "reply_oversize":
        this.#failAll(
          bridgeReplyOversizeError(
            "Hopper",
            this.#replyLimit,
            failure.observedBytes,
          ),
        );
        this.#socket?.destroy();
        return;
      case "utf8":
        this.#abortProtocol(
          "Hopper bridge response is not valid UTF-8",
          failure.cause,
        );
        return;
      case "envelope":
        this.#abortProtocol(failure.cause.message, failure.cause);
        return;
      case "unknown_id":
        this.#abortProtocol("Hopper returned an unknown response id");
        return;
      case "connection_rejected":
        this.#abortProtocol(
          `Hopper rejected the connection: ${failure.cause.message}`,
          failure.cause,
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
