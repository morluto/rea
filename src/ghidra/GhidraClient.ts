import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import type { Socket } from "node:net";
import type { ProgressReporter } from "../application/ProgressReporter.js";

import { AnalysisError } from "../domain/analysisErrorBase.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import {
  providerRetryAction,
  type ProviderOperationHealth,
} from "../domain/providerOperationHealth.js";
import { err, ok, type Result } from "../domain/result.js";
import { silentLogger } from "../logger.js";
import type { Logger } from "pino";
import { PendingOperations } from "../process/PendingOperations.js";
import { PrivateRuntimeRoot } from "../process/PrivateRuntimeRoot.js";
import { ProviderStartupDeadline } from "../process/ProviderDeadline.js";
import { ProviderRunLineage } from "../process/ProviderRunLineage.js";
import {
  type ProviderProcessDiagnostic,
  type ProviderProcessSnapshot,
  ProviderProcessSupervisor,
} from "../process/ProviderProcess.js";
import { DEFAULT_GHIDRA_STARTUP_TIMEOUT_MS } from "../config/providerStartupTimeout.js";
import type {
  GhidraClientOptions,
  GhidraRequestOptions,
  GhidraStartResult,
} from "./GhidraClientTypes.js";
import type { GhidraInventoryOperation } from "./GhidraInventoryValues.js";
import type { GhidraFunctionOperation } from "./GhidraFunctionValues.js";
import {
  createGhidraDiagnostics,
  GHIDRA_PROCESS_DIAGNOSTIC_BYTES,
} from "./GhidraDiagnostics.js";
import { GhidraLaunchError, type GhidraLaunch } from "./GhidraLauncher.js";
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
import { readFileHandleChunks } from "../filesystem/readFileHandleChunks.js";
import { readBoundedFileBytes } from "../process/BoundedFileBytes.js";
import {
  openRegularFile,
  RegularFileChangedError,
  RegularFileAdmissionFailure,
  sameRegularFileState,
} from "../filesystem/RegularFile.js";
import { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";

export type GhidraTargetSnapshot =
  | { readonly kind: "captured"; readonly bytes: Buffer }
  | {
      readonly kind: "over-capacity";
      readonly sourceBytesAtLeast: number;
      readonly maximumBytes: number;
    };
import { connectGhidraSocket } from "./GhidraSocketConnection.js";
import {
  createGhidraEndpoint,
  type GhidraEndpoint,
} from "./GhidraTransport.js";
import { GhidraWire } from "./GhidraClientWire.js";
import { completeGhidraStartupHandshake } from "./GhidraClientStartup.js";
import { ghidraSessionRoot } from "./GhidraSessionRoot.js";

const SHUTDOWN_TIMEOUT_MS = 10_000;
const SESSION_ROOT = ghidraSessionRoot();

/** Closed Java-bridge operation union callable after the exact handshake. */
export type GhidraOperation =
  | GhidraInventoryOperation
  | GhidraFunctionOperation;

/** Owns an authenticated private Ghidra session with transport-bound mutation authority. */
export class GhidraClient {
  readonly #options: Required<
    Pick<GhidraClientOptions, "startupTimeoutMs" | "transport" | "platform">
  > &
    GhidraClientOptions;
  readonly #logger: Logger;
  readonly #pending = new PendingOperations<
    number,
    Result<JsonValue, GhidraSessionError>
  >();
  #socket: Socket | undefined;
  #detachSocket: (() => void) | undefined;
  #launch: GhidraLaunch | undefined;
  #process: ProviderProcessSupervisor | undefined;
  #runtimeRoot: PrivateRuntimeRoot | undefined;
  #socketRoot: PrivateRuntimeRoot | undefined;
  #endpointPath: string | undefined;
  #snapshotPath: string | undefined;
  readonly #snapshotOwners = new Set<OwnedFileHandle>();
  #targetAdmission: JsonValue | undefined;
  #token: string | undefined;
  // Retain authentication identities for diagnostics from late request settlement.
  readonly #authenticationTokens = new Set<string>();
  #runId: string | undefined;
  readonly #lineage = new ProviderRunLineage();
  #nextId = 1;
  #closing = false;
  #processSnapshot: ProviderProcessSnapshot | undefined;
  #lastDiagnostics: Readonly<Record<string, JsonValue>> = {};
  #startupController: AbortController | undefined;
  #startPromise: Promise<GhidraStartResult> | undefined;
  #ready = false;
  #closePromise: Promise<void> | undefined;
  readonly #failure = bindGhidraSessionFailure(
    () => this.#diagnostics(),
    (value) => this.#redactAuthentication(value),
  );
  readonly #wire: GhidraWire;
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
    onLine: (line) => this.#responseRouter.route(line),
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
    this.#options = {
      ...options,
      startupTimeoutMs:
        options.startupTimeoutMs ?? DEFAULT_GHIDRA_STARTUP_TIMEOUT_MS,
      platform: options.platform ?? process.platform,
      transport: options.transport ?? "unix-socket",
    };
    this.#logger = options.logger ?? silentLogger;
    this.#wire = new GhidraWire({
      getSocket: () => this.#socket,
      getToken: () => this.#token,
      nextId: () => this.#nextId++,
      pending: this.#pending,
      logger: this.#logger,
      failure: this.#failure,
    });
    this.#requestQueue = new GhidraRequestQueue(
      (method, parameters, requestOptions) =>
        this.#wire.request(method, parameters, requestOptions),
      (kind, message, cause) => this.#failure(kind, message, cause),
      () => this.#stopAfterActiveCancellation(),
    );
  }

  /** Launch Ghidra once and require its exact post-analysis handshake. */
  start(
    signal?: AbortSignal,
    progress?: ProgressReporter,
  ): Promise<GhidraStartResult> {
    if (progress !== undefined)
      return this.#reportStartupWait(this.start(signal), signal, progress);
    if (this.#closePromise !== undefined)
      return this.#closePromise.then(
        () => this.start(signal),
        (cause: unknown) =>
          err(
            new GhidraSessionError(
              "process",
              "Ghidra cleanup remains incomplete",
              this.#diagnostics(),
              { cause, cleanupFailure: this.#cleanupError(cause) },
            ),
          ),
      );
    if (this.#startPromise !== undefined) {
      if (this.#startupController?.signal.aborted && !signal?.aborted)
        return this.#startPromise.then((result) =>
          result.ok || result.error.cleanupFailure !== undefined
            ? result
            : this.start(signal),
        );
      return this.#startPromise;
    }
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
    void started.then(
      (result) => {
        signal?.removeEventListener("abort", onAbort);
        if (result.ok) this.#ready = true;
        else reset();
      },
      (cause: unknown) => {
        this.#logger.debug(
          { error: cause instanceof Error ? cause.message : String(cause) },
          "Ghidra startup promise rejected during bookkeeping",
        );
        reset();
      },
    );
    return started;
  }

  async #reportStartupWait(
    started: Promise<GhidraStartResult>,
    signal: AbortSignal | undefined,
    progress: ProgressReporter,
  ): Promise<GhidraStartResult> {
    const startedAt = performance.now();
    let active = true;
    let reporting = false;
    const timer = setInterval(() => {
      if (!active || reporting || signal?.aborted) return;
      reporting = true;
      void Promise.resolve()
        .then(() => {
          if (!active || signal?.aborted) return;
          return progress.report({
            phase: "ghidra_startup",
            completed: 0,
            total: null,
            message: `Waiting for Ghidra startup (${String(Math.floor((performance.now() - startedAt) / 1000))}s elapsed); import, auto-analysis and bridge readiness may still be pending`,
          });
        })
        // Notification failure does not release the owned startup process.
        .catch(() => {})
        .finally(() => {
          reporting = false;
        });
    }, 10_000);
    try {
      return await started;
    } finally {
      active = false;
      clearInterval(timer);
    }
  }

  /** Revalidate live bridge, provider, run, and profile metadata. */
  async ping(
    options: GhidraRequestOptions = {},
  ): Promise<Result<GhidraSessionInfo, GhidraSessionError>> {
    const started = await this.start(options.signal);
    if (!started.ok) return started;
    const result = await this.#wire.request("ping", {}, options);
    if (!result.ok) return result;
    return this.#parseSessionInfo(result.value);
  }

  /** Execute one admitted operation through the serial per-Program queue. */
  async callTool(
    operation: GhidraOperation,
    parameters: Readonly<Record<string, JsonValue>>,
    options: {
      readonly signal?: AbortSignal;
      readonly progress?: ProgressReporter;
    } = {},
  ): Promise<Result<JsonValue, GhidraSessionError>> {
    const started = await this.start(options.signal, options.progress);
    if (!started.ok) return started;
    return this.#requestQueue.run(
      operation,
      parameters,
      options.signal === undefined ? {} : { signal: options.signal },
    );
  }

  /** Dispatch against the connected bridge without invoking startup or retry. */
  callToolIfReady(
    operation: GhidraOperation,
    parameters: Readonly<Record<string, JsonValue>>,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<Result<JsonValue, GhidraSessionError> | undefined> {
    if (!this.isReady()) return Promise.resolve(undefined);
    return this.#requestQueue.run(
      operation,
      parameters,
      options.signal === undefined ? {} : { signal: options.signal },
    );
  }

  /** Read the private immutable source for format parsers that require captured bytes. */
  readTargetSnapshot(
    maximumBytes?: number,
    signal?: AbortSignal,
  ): Promise<Result<GhidraTargetSnapshot, GhidraSessionError>> {
    return this.#withTargetSnapshot(async (handle, initial, path) => {
      if (
        maximumBytes !== undefined &&
        (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0)
      )
        throw new RangeError("Snapshot byte limit must be a safe integer");
      if (maximumBytes !== undefined && initial.size > maximumBytes)
        return {
          kind: "over-capacity",
          sourceBytesAtLeast: initial.size,
          maximumBytes,
        };
      const bytes = await readBoundedFileBytes(
        handle,
        maximumBytes ?? initial.size,
        signal,
        initial.size,
      );
      if (bytes === undefined || bytes.length !== initial.size)
        throw new RegularFileChangedError(path);
      return { kind: "captured", bytes };
    }, signal);
  }

  /** Measure the complete snapshot identity without retaining its bytes in memory. */
  hashTargetSnapshot(
    signal?: AbortSignal,
  ): Promise<
    Result<
      { readonly sha256: string; readonly bytes: number },
      GhidraSessionError
    >
  > {
    return this.#withTargetSnapshot(async (handle, initial, path) => {
      const hash = createHash("sha256");
      let bytes = 0;
      for await (const chunk of readFileHandleChunks(handle, {
        end: initial.size,
        signal,
      })) {
        bytes += chunk.length;
        if (bytes > initial.size) throw new RegularFileChangedError(path);
        hash.update(chunk);
      }
      if (bytes !== initial.size) throw new RegularFileChangedError(path);
      return { sha256: hash.digest("hex"), bytes };
    }, signal);
  }

  async #withTargetSnapshot<T>(
    read: (handle: FileHandle, initial: Stats, path: string) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<Result<T, GhidraSessionError>> {
    const path = this.#snapshotPath;
    if (path === undefined)
      return err(
        this.#failure(
          "protocol",
          "Ghidra target snapshot is unavailable before startup or after close",
        ),
      );
    try {
      const handle = await openRegularFile(path, {
        symlinks: "reject",
        signal,
      });
      const owner = new OwnedFileHandle(handle);
      this.#snapshotOwners.add(owner);
      let result: Result<T, unknown>;
      try {
        const initial = await handle.stat();
        signal?.throwIfAborted();
        if (!Number.isSafeInteger(initial.size) || initial.size < 0)
          throw new RangeError("Snapshot size must be a safe integer");
        const value = await read(handle, initial, path);
        signal?.throwIfAborted();
        const after = await handle.stat();
        signal?.throwIfAborted();
        if (!sameRegularFileState(initial, after))
          throw new RegularFileChangedError(path);
        result = ok(value);
      } catch (cause: unknown) {
        result = err(cause);
      }
      try {
        await owner.close();
        this.#snapshotOwners.delete(owner);
      } catch (closeFailure: unknown) {
        throw new AggregateError(
          result.ok ? [closeFailure] : [result.error, closeFailure],
          "Ghidra target snapshot read or descriptor cleanup failed",
        );
      }
      if (!result.ok) throw result.error;
      return result;
    } catch (cause: unknown) {
      if (cause instanceof RegularFileAdmissionFailure)
        this.#snapshotOwners.add(cause.owner);
      return err(
        this.#failure(
          signal?.aborted === true ? "cancelled" : "protocol",
          "Ghidra target snapshot could not be read for load-image verification",
          cause,
        ),
      );
    }
  }

  /** Stop the owned process group and remove all project/runtime artifacts. */
  async close(): Promise<Result<null, AnalysisError>> {
    try {
      await this.#requestClose(false);
      return ok(null);
    } catch (cause: unknown) {
      return err(this.#cleanupError(cause));
    }
  }

  /** True only after the authenticated startup handshake has completed. */
  isReady(): boolean {
    return (
      this.#ready &&
      this.#socket !== undefined &&
      !this.#socket.destroyed &&
      this.#closePromise === undefined
    );
  }

  #cleanupError(cause: unknown): AnalysisError {
    if (cause instanceof AnalysisError && cause.cleanupIncomplete) return cause;
    return new ProviderCleanupError(
      "ghidra",
      [
        ...(this.#process === undefined ? [] : ["ghidra-process"]),
        ...[this.#runtimeRoot, this.#socketRoot].flatMap((root) =>
          root === undefined ? [] : [root.path],
        ),
      ],
      {
        reason: cause instanceof Error ? cause.message : String(cause),
        diagnostics: this.#diagnostics(),
      },
      { cause },
    );
  }

  async #startupFailure(
    primary: GhidraSessionError,
  ): Promise<GhidraStartResult> {
    try {
      await this.#cleanup();
      return err(primary);
    } catch (cause: unknown) {
      return err(
        new GhidraSessionError(
          primary.kind,
          primary.message,
          primary.diagnostics,
          {
            ...(primary.cause === undefined ? {} : { cause: primary.cause }),
            ...(primary.timeoutMs === undefined
              ? {}
              : { timeoutMs: primary.timeoutMs }),
            ...(primary.remoteCode === undefined
              ? {}
              : { remoteCode: primary.remoteCode }),
            cleanupFailure: this.#cleanupError(cause),
          },
        ),
      );
    }
  }

  #requestClose(forceStop: boolean): Promise<void> {
    this.#ready = false;
    const starting = this.#startPromise;
    const controller = this.#startupController;
    controller?.abort();
    this.#closePromise ??= Promise.resolve().then(() =>
      this.#close(starting, controller, forceStop),
    );
    return this.#closePromise;
  }

  #stopAfterActiveCancellation(): Promise<void> {
    return this.#requestClose(true).catch((cause: unknown) => {
      this.#logger.error(
        { error: cause instanceof Error ? cause.message : String(cause) },
        "Ghidra cleanup after active request cancellation failed",
      );
      throw cause;
    });
  }

  /** Observed failures that prevent a retained session from being reused. */
  operationHealthSnapshot(): ProviderOperationHealth | undefined {
    const exit = this.#process?.observedExit();
    const state =
      exit !== undefined
        ? "exited"
        : this.#socket?.destroyed === true
          ? "unreachable"
          : this.#startPromise === undefined &&
              (this.#process !== undefined ||
                this.#socket !== undefined ||
                this.#runtimeRoot !== undefined ||
                this.#socketRoot !== undefined ||
                this.#snapshotOwners.size > 0)
            ? "unknown"
            : undefined;
    if (state === undefined) return undefined;
    return {
      state,
      stage: null,
      retryAction: providerRetryAction(state),
      exitCode: exit?.code ?? null,
      requests: [],
    };
  }

  /** Latest bounded local diagnostics, with bearer material redacted. */
  diagnostics(): Readonly<Record<string, JsonValue>> {
    return structuredClone(this.#diagnostics());
  }

  /** Latest token-verified launcher lineage for the active run. */
  runtimeLineage() {
    return this.#lineage.snapshot();
  }

  async #start(signal: AbortSignal): Promise<GhidraStartResult> {
    if (signal.aborted)
      return err(this.#failure("cancelled", "Ghidra startup was cancelled"));
    if (this.#socket !== undefined || this.#runtimeRoot !== undefined)
      return err(this.#failure("protocol", "Ghidra client is already started"));
    this.#processSnapshot = undefined;
    const deadline = new ProviderStartupDeadline(
      this.#options.startupTimeoutMs,
      signal,
    );
    try {
      return await this.#startWithin(deadline);
    } catch (cause: unknown) {
      if (cause instanceof GhidraSessionError) return err(cause);
      throw cause;
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
        platform: this.#options.platform,
      });
    } catch (cause: unknown) {
      return err(
        this.#failure("start", "Ghidra runtime root creation failed", cause),
      );
    }
    if (deadline.signal.aborted) return this.#startupInterrupted(deadline);
    let endpoint: GhidraEndpoint;
    try {
      const allocated = await createGhidraEndpoint(
        this.#runtimeRoot.path,
        this.#options.transport,
        this.#options.platform,
      );
      endpoint = allocated.endpoint;
      this.#socketRoot = allocated.socketRoot;
      this.#endpointPath = endpoint.path;
    } catch (cause: unknown) {
      const failure = this.#failure(
        "start",
        "Ghidra private endpoint allocation failed",
        cause,
      );
      return this.#startupFailure(failure);
    }
    try {
      const snapshot = await createGhidraTargetSnapshot(
        this.#options.targetPath,
        this.#runtimeRoot.path,
        this.#options.targetSha256,
        { signal: deadline.signal, platform: this.#options.platform },
      );
      this.#snapshotPath = snapshot.path;
      this.#targetAdmission = snapshot.admission;
    } catch (cause: unknown) {
      if (deadline.signal.aborted) return this.#startupInterrupted(deadline);
      const failure = this.#failure(
        "start",
        "Ghidra target snapshot failed admission",
        cause,
      );
      return this.#startupFailure(failure);
    }
    if (deadline.signal.aborted) return this.#startupInterrupted(deadline);
    this.#token = randomBytes(32).toString("hex");
    this.#authenticationTokens.add(this.#token);
    this.#lineage.reset();
    this.#runId = this.#options.runId ?? randomUUID();
    const launched = await this.#options.launcher
      .launch(
        {
          runtimeRoot: this.#runtimeRoot.path,
          transport: endpoint.transport,
          endpointPath: endpoint.path,
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
      const partialLaunch =
        launched.error instanceof GhidraLaunchError
          ? launched.error.partialLaunch
          : undefined;
      if (partialLaunch !== undefined) {
        this.#launch = partialLaunch;
        this.#process = new ProviderProcessSupervisor(partialLaunch, {
          maxDiagnosticBytes: GHIDRA_PROCESS_DIAGNOSTIC_BYTES,
          onDiagnostic: (event) => this.#onProcessDiagnostic(event),
        });
      }
      const failure = deadline.signal.aborted
        ? this.#interruptionFailure(deadline, launched.error)
        : launched.error instanceof GhidraSessionError
          ? launched.error
          : this.#failure("start", launched.error.message, launched.error);
      return this.#startupFailure(failure);
    }
    this.#launch = launched.value;
    this.#process = new ProviderProcessSupervisor(launched.value, {
      maxDiagnosticBytes: GHIDRA_PROCESS_DIAGNOSTIC_BYTES,
      onDiagnostic: (event) => this.#onProcessDiagnostic(event),
    });
    const connected = await this.#connect(endpoint, deadline);
    if (!connected.ok) {
      const failure = connected.error;
      return this.#startupFailure(failure);
    }
    const completed = await completeGhidraStartupHandshake({
      deadline,
      request: (method, params, requestOptions) =>
        this.#wire.request(method, params, requestOptions),
      parseSessionInfo: (value) => this.#parseSessionInfo(value),
      failure: this.#failure,
      startupTimeoutMs: this.#options.startupTimeoutMs,
    });
    if (!completed.ok) return this.#startupFailure(completed.error);
    await this.#lineage.observe(this.#launch);
    this.#requestQueue.reopen();
    return completed;
  }

  async #connect(
    endpoint: GhidraEndpoint,
    deadline: ProviderStartupDeadline,
  ): Promise<Result<undefined, GhidraSessionError>> {
    const connected = await connectGhidraSocket({
      endpoint,
      deadline,
      failure: this.#failure,
      isClosed: () => this.#closing,
      processExited: () => this.#process?.observedExit() !== undefined,
      startupTimeoutMs: this.#options.startupTimeoutMs,
      handlers: {
        data: this.#onSocketData,
        error: this.#onSocketError,
        close: this.#onSocketClose,
      },
    });
    if (!connected.ok) return connected;
    this.#socket = connected.value.socket;
    this.#detachSocket = connected.value.detach;
    return ok(undefined);
  }

  #parseSessionInfo(value: JsonValue) {
    const runId = this.#runId;
    if (runId === undefined)
      return err(this.#failure("protocol", "Ghidra run identity is missing"));
    const parsed = parseGhidraSessionInfo(value, {
      runId,
      expectedReadOnly:
        this.#options.transport === "authenticated-loopback-tcp",
      providerVersion: this.#options.providerVersion,
      profileDigest: this.#options.profileDigest,
      targetSha256: this.#options.targetSha256,
      ...(this.#targetAdmission === undefined
        ? {}
        : { targetAdmission: this.#targetAdmission }),
      ...(this.#options.expectedLanguageId === undefined
        ? {}
        : { expectedLanguageId: this.#options.expectedLanguageId }),
      ...(this.#options.expectedCompilerSpecId === undefined
        ? {}
        : { expectedCompilerSpecId: this.#options.expectedCompilerSpecId }),
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
    forceStop: boolean,
  ): Promise<void> {
    try {
      // best-effort cleanup: a rejected startup must not mask close/cleanup.
      await starting?.catch(() => undefined);
      await this.#cleanup(forceStop);
    } finally {
      if (this.#startPromise === starting) this.#startPromise = undefined;
      if (this.#startupController === controller)
        this.#startupController = undefined;
      this.#closePromise = undefined;
    }
  }

  async #cleanup(forceStop = false): Promise<void> {
    this.#closing = true;
    let forcedStopFailure: GhidraSessionError | undefined;
    try {
      this.#requestQueue.failQueued(
        this.#failure("process", "Ghidra session closed"),
      );
      const socket = this.#socket;
      if (!forceStop && socket !== undefined && !socket.destroyed) {
        const shutdown = await this.#wire
          .request("shutdown", {}, { timeoutMs: SHUTDOWN_TIMEOUT_MS })
          .catch((cause: unknown) =>
            err(
              this.#failure("process", "Ghidra shutdown request failed", cause),
            ),
          );
        if (!shutdown.ok || !isGhidraShutdownAcknowledgement(shutdown.value))
          this.#logger.warn(
            {
              status: shutdown.ok ? "invalid-acknowledgement" : "failed",
              ...(shutdown.ok
                ? {}
                : {
                    kind: shutdown.error.kind,
                    message: shutdown.error.message,
                    diagnostics: shutdown.error.diagnostics,
                  }),
            },
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
          // Keep the supervisor and private files available for a later close.
          // A still-live JVM can recreate files if its runtime is removed here.
          throw this.#failure(
            "process",
            `Ghidra process cleanup was incomplete: ${stopped.reason}`,
          );
        }
      }
      this.#lastDiagnostics = this.#diagnostics();
      this.#process = undefined;
      this.#launch = undefined;
      for (const owner of this.#snapshotOwners) {
        await owner.close();
        this.#snapshotOwners.delete(owner);
      }
      try {
        await this.#removeRuntimeRoots();
      } catch (cause: unknown) {
        if (forceStop)
          forcedStopFailure ??= this.#failure(
            "process",
            "Ghidra runtime cleanup after cancellation failed",
            cause,
          );
        else throw cause;
      }
      this.#snapshotPath = undefined;
      this.#endpointPath = undefined;
      this.#token = undefined;
      this.#runId = undefined;
      this.#responseBuffer.reset();
      if (forcedStopFailure !== undefined) throw forcedStopFailure;
    } finally {
      this.#closing = false;
    }
  }

  /**
   * Remove the runtime and socket roots, keeping each one that could not be
   * removed so a later close retries it rather than reporting success.
   */
  async #removeRuntimeRoots(): Promise<void> {
    const roots = [
      {
        root: this.#runtimeRoot,
        release: () => (this.#runtimeRoot = undefined),
      },
      { root: this.#socketRoot, release: () => (this.#socketRoot = undefined) },
    ];
    const leftovers: { readonly path: string; readonly reason: string }[] = [];
    let firstCause: unknown;
    for (const { root, release } of roots) {
      if (root === undefined) continue;
      try {
        await root.close();
        release();
      } catch (cause: unknown) {
        firstCause ??= cause;
        leftovers.push({
          path: root.path,
          reason: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }
    if (leftovers.length > 0)
      throw new ProviderCleanupError(
        "ghidra",
        leftovers.map(({ path }) => path),
        {
          reason:
            "Ghidra's private runtime directory could not be removed; it is retained for a later close.",
          leftover_paths: leftovers.map(({ path }) => path),
          failures: leftovers.map(({ path, reason }) => `${path}: ${reason}`),
        },
        { cause: firstCause },
      );
  }

  #redactAuthentication(value: string): string {
    for (const token of this.#authenticationTokens)
      value = value.replaceAll(token, "[REDACTED]");
    return value;
  }

  #onProcessDiagnostic(event: ProviderProcessDiagnostic): void {
    if (event.type === "output") {
      this.#options.onDiagnostic?.({
        type: "launcher-output",
        stream: event.stream,
        bytes: event.bytes,
        totalBytes: event.totalBytes,
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
    return this.#startupFailure(failure);
  }

  #interruptionFailure(
    deadline: ProviderStartupDeadline,
    cause?: unknown,
  ): GhidraSessionError {
    return deadline.interruption === "cancelled"
      ? this.#failure("cancelled", "Ghidra startup was cancelled", cause)
      : this.#failure("timeout", "Ghidra startup deadline elapsed", cause, {
          timeoutMs: deadline.timeoutMs,
        });
  }

  #diagnostics(): Readonly<Record<string, JsonValue>> {
    const snapshot = this.#process?.snapshot() ?? this.#processSnapshot;
    return createGhidraDiagnostics({
      targetPath: this.#options.targetPath,
      targetSha256: this.#options.targetSha256,
      ...(this.#targetAdmission === undefined
        ? {}
        : { targetAdmission: this.#targetAdmission }),
      transport: this.#options.transport,
      providerVersion: this.#options.providerVersion,
      profileDigest: this.#options.profileDigest,
      ...(this.#runId === undefined ? {} : { runId: this.#runId }),
      ...(this.#runtimeRoot === undefined
        ? {}
        : { runtimeRoot: this.#runtimeRoot.path }),
      ...(this.#socketRoot === undefined
        ? {}
        : { socketRoot: this.#socketRoot.path }),
      ...(this.#endpointPath === undefined
        ? {}
        : { endpointPath: this.#endpointPath }),
      ...(this.#launch === undefined ? {} : { launch: this.#launch }),
      ...(snapshot === undefined ? {} : { snapshot }),
      ...(this.#token === undefined ? {} : { token: this.#token }),
      previous: this.#lastDiagnostics,
    });
  }
}
