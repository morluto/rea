import { constants } from "node:fs";
import { copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { AnalysisCleanupLease } from "../resources/index.js";
import { PrivateRuntimeRoot } from "../process/PrivateRuntimeRoot.js";
import type { HarmonyAbcAnalysisPort } from "../ports/harmony/HarmonyAbcAnalysisPort.js";
import {
  createAnalysisExecution,
  type ExecutionOptions,
} from "../ports/AnalysisProvider.js";
import { err, ok, type Result } from "../domain/result.js";
import type {
  HarmonyAbcPartialObservation,
  HarmonyAbcRequest,
} from "../domain/harmony/harmonyAbcAnalysis.js";
import { ownedJsonValueSchema } from "../domain/jsonValue.js";
import {
  harmonyAbcResultSchemas,
  DEFAULT_HARMONY_ABC_ANALYSIS_TIMEOUT_MS,
} from "../domain/harmony/harmonyAbcAnalysis.js";
import {
  AnalysisError,
  type AnalysisCapturedOutput,
} from "../domain/analysisErrorBase.js";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisOutputError,
  OwnerCancellation,
  carriedReason,
  cancelledBy,
} from "../domain/analysisErrorCore.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import {
  analysisErrorWithCleanupDependencies,
  analysisErrorWithCleanupFailure,
} from "../domain/analysisErrorCleanup.js";
import { HOST_PLATFORM } from "../platform/HostPlatform.js";
import { hashStableFile } from "../filesystem/StableFileHash.js";
import type { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import { regularFileCancellation } from "../filesystem/OwnedRegularFile.js";
import { RegularFileChangedError } from "../filesystem/RegularFile.js";
import type { OwnedMcpLauncher } from "../process/OwnedMcpStdioTransport.js";
import { XpandaBridge } from "./XpandaBridge.js";
import {
  resolveXpandaConfiguration,
  type XpandaConfigurationFailure,
} from "./XpandaConfiguration.js";
import {
  hashXpandaEngine,
  XpandaEngineScanError,
} from "./XpandaEngineIdentity.js";
import {
  parseXpandaDecompile,
  parseXpandaDisassembly,
  xpandaCallGraphSchema,
  xpandaClassListSchema,
  xpandaClassMetadataSchema,
  xpandaCodeSearchSchema,
  xpandaExportSchema,
  xpandaHapAbcSchema,
  xpandaHapResourcesSchema,
  isHapLoad,
  xpandaSessionSchema,
  xpandaStringMatchesSchema,
  xpandaSymbolSearchSchema,
  xpandaXrefsSchema,
  type XpandaSession,
} from "./XpandaProtocol.js";
import { captureXpandaFailure, xpandaTimeoutError } from "./XpandaFailures.js";
import {
  XPANDA_BYTECODE_VERSION_SUPPORT,
  XPANDA_CHECKOUT_REMEDIATION,
  XPANDA_LIMITATIONS,
  XPANDA_LIMITS,
  XPANDA_PROVIDER_ID,
  XPANDA_UNSUPPORTED_HOST_REMEDIATION,
  XPANDA_VERIFIED_VERSION,
} from "./XpandaRelease.js";
import { errorMessage } from "../kernel/errorMessage.js";

type Outcome = Awaited<ReturnType<HarmonyAbcAnalysisPort["execute"]>>;

const IDLE_RETIRE_MS = 60_000;

/** Test and composition seam for publication file operations. */
export interface XpandaPublicationHooks {
  readonly copyFile?: (source: string, target: string) => Promise<void>;
  readonly remove?: (path: string) => Promise<void>;
}

/** The typed reason the combined operation signal aborted. */
const interruptionError = (context: {
  readonly operation: string;
  readonly signal: AbortSignal;
  readonly timeout: AbortSignal;
  readonly timeoutMs: number;
  readonly callerSignal: AbortSignal | undefined;
  readonly shutdown: AbortSignal;
  /** Producer diagnostics observed when the interruption stopped the work. */
  readonly capturedOutput?: () => AnalysisCapturedOutput | undefined;
}): AnalysisError => {
  const reason = context.signal.reason;
  const output = context.capturedOutput?.();
  const options = output === undefined ? {} : { capturedOutput: output };
  // Match the combined signal's first abort reason instead of current flags:
  // a later deadline must not replace the caller's earlier cancellation.
  if (context.timeout.aborted && reason === context.timeout.reason)
    return xpandaTimeoutError(context.operation, context.timeoutMs, options);
  if (context.shutdown.aborted && reason === context.shutdown.reason)
    return cancelledBy(context.operation, context.shutdown, options);
  if (
    context.callerSignal?.aborted === true &&
    reason === context.callerSignal.reason
  )
    return cancelledBy(context.operation, context.callerSignal, options);
  return cancelledBy(
    context.operation,
    carriedReason(context.signal.reason),
    options,
  );
};

/** How long a caller waits behind the provider's serialized request tail. */
const waitForTurn = (
  predecessor: Promise<void>,
  operation: string,
  signal?: AbortSignal,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const abort = () =>
      reject(cancelledBy(operation, carriedReason(signal?.reason)));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted === true) abort();
    void predecessor.then(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    });
  });

interface RetainedBridge {
  readonly key: string;
  readonly engineSha256: string;
  readonly version: string;
  readonly bridge: XpandaBridge;
}

interface StagedInput {
  readonly lease: AnalysisCleanupLease;
  /** Private runtime root that owns the staged input and producer exports. */
  readonly rootPath: string;
  readonly stagedPath: string;
  readonly sha256: string;
  readonly size: number;
  /** Hash descriptors that could not close; joined before the root lease. */
  readonly failedHandles: Map<OwnedFileHandle, string>;
}

interface EngineFacts {
  readonly root: string;
  readonly sha256: string;
  readonly version: string;
}

/** Project a tagged configuration failure onto the operation boundary. */
const configurationUnavailable = (
  operation: string,
  failure: XpandaConfigurationFailure,
): AnalysisCapabilityUnavailableError =>
  new AnalysisCapabilityUnavailableError(
    XPANDA_PROVIDER_ID,
    operation,
    failure.reason,
    {
      userMessage: failure.reason,
      remediationAction: failure.remediation,
    },
  );

/**
 * Publish a producer export from the private runtime root. The producer never
 * writes into the caller's directory: REA creates it exclusively, copies only
 * regular files whose resolved paths stay under it, and removes the partial
 * tree when publication fails.
 */
const publishStagedExport = async (options: {
  readonly source: string;
  readonly destination: string;
  readonly operation: string;
  /** Files the producer claims it wrote; a mismatch publishes nothing. */
  readonly expectedWritten: number;
  /** Cancels publication; output is removed before the reason is rethrown. */
  readonly signal: AbortSignal;
  /** Typed cancellation or deadline failure for the stopped operation. */
  readonly interruption: () => AnalysisError;
  readonly copyFile?: (source: string, target: string) => Promise<void>;
  readonly remove?: (path: string) => Promise<void>;
}): Promise<readonly string[]> => {
  const {
    source,
    destination,
    operation,
    expectedWritten,
    signal,
    interruption,
  } = options;
  const copy =
    options.copyFile ??
    ((from: string, to: string) => copyFile(from, to, constants.COPYFILE_EXCL));
  const remove =
    options.remove ??
    ((path: string) => rm(path, { recursive: true, force: true }));
  const stop = (): void => {
    if (signal.aborted) throw signal.reason ?? new Error("aborted");
  };
  stop();
  try {
    // The producer created parents recursively; keep that behavior while
    // claiming the destination itself exclusively.
    await mkdir(dirname(destination), { recursive: true });
    await mkdir(destination);
  } catch (cause: unknown) {
    const code =
      cause instanceof Error && "code" in cause ? String(cause.code) : "";
    throw new AnalysisInputError(operation, { cause }, [
      {
        path: ["output_directory"],
        reason: "invalid_value",
        message:
          code === "EEXIST"
            ? `The output directory already exists: ${destination}. Select an absent directory.`
            : `The output directory path is not usable: ${destination}: ${errorMessage(cause)}`,
      },
    ]);
  }
  const published: string[] = [];
  const directories = [""];
  try {
    while (directories.length > 0) {
      const directory = directories.pop() ?? "";
      const entries = await readdir(join(source, directory), {
        withFileTypes: true,
      });
      for (const entry of entries) {
        stop();
        const relativePath =
          directory.length === 0 ? entry.name : `${directory}/${entry.name}`;
        if (entry.isSymbolicLink())
          throw new AnalysisOutputError(
            operation,
            `The producer's export contains a symbolic link at ${relativePath}.`,
          );
        const target = resolve(destination, relativePath);
        if (!target.startsWith(`${destination}${sep}`))
          throw new AnalysisOutputError(
            operation,
            `The producer's export names a path outside the selected output directory: ${relativePath}.`,
          );
        if (entry.isDirectory()) {
          await mkdir(target);
          directories.push(relativePath);
          continue;
        }
        if (!entry.isFile())
          throw new AnalysisOutputError(
            operation,
            `The producer's export contains a non-regular entry at ${relativePath}.`,
          );
        await copy(join(source, relativePath), target);
        published.push(relativePath);
      }
    }
    stop();
    if (published.length !== expectedWritten)
      throw new AnalysisOutputError(
        operation,
        `The producer reported ${String(expectedWritten)} written classes but emitted ${String(published.length)} files; no overwrite was published.`,
      );
    return published;
  } catch (cause: unknown) {
    // Cancellation or the deadline wins over a publication failure observed
    // in the same window; either way the partial tree is removed first.
    const primary: AnalysisError | AnalysisOutputError = signal.aborted
      ? interruption()
      : cause instanceof AnalysisError
        ? cause
        : new AnalysisOutputError(
            operation,
            `The producer's exported files could not be published: ${errorMessage(cause)}`,
            { cause },
          );
    try {
      await remove(destination);
    } catch (cleanupCause: unknown) {
      const cleanup = new ProviderCleanupError(
        XPANDA_PROVIDER_ID,
        [destination],
        { reason: errorMessage(cleanupCause) },
        { operation, cause: new AggregateError([primary, cleanupCause]) },
      );
      throw analysisErrorWithCleanupDependencies(primary, cleanup, operation);
    }
    throw primary;
  }
};

/** Keep a completed observation with the cleanup failure that followed it. */
const completedHarmonyAbcObservation = (
  execution: Awaited<ReturnType<typeof createAnalysisExecution>>,
): HarmonyAbcPartialObservation => ({
  kind: "harmony-abc",
  result: execution.result,
  provenance: ownedJsonValueSchema.parse({
    provider: execution.provider,
    raw_result: execution.rawResult,
    limitations: execution.limitations,
    subject: execution.subject ?? null,
    locations: execution.locations,
  }),
});

/** Bind a staging cleanup failure onto a finished outcome without losing facts. */
const finishStagedInput = async (
  staged: StagedInput | undefined,
  outcome: Outcome,
  operation: string,
): Promise<Outcome> => {
  if (staged === undefined) return outcome;
  const closeCauses: unknown[] = [];
  for (const [owner, path] of staged.failedHandles) {
    try {
      await owner.close();
      staged.failedHandles.delete(owner);
    } catch (cause: unknown) {
      closeCauses.push(cause);
    }
  }
  try {
    await staged.lease.release();
    if (closeCauses.length === 0) return outcome;
  } catch (cause: unknown) {
    closeCauses.push(cause);
  }
  const cleanup = new ProviderCleanupError(
    XPANDA_PROVIDER_ID,
    [staged.stagedPath],
    {
      reason: closeCauses.map((failure) => errorMessage(failure)).join("; "),
    },
    {
      operation,
      cause: new AggregateError(closeCauses),
      ...(outcome.ok
        ? { partialObservation: completedHarmonyAbcObservation(outcome.value) }
        : outcome.error.partialObservation === undefined
          ? {}
          : { partialObservation: outcome.error.partialObservation }),
    },
  );
  staged.lease.bindCleanupError(cleanup);
  return err(
    outcome.ok
      ? cleanup
      : analysisErrorWithCleanupDependencies(outcome.error, cleanup, operation),
  );
};

/** One serialized, retained xpanda bridge per REA instance, retired on idle or shutdown. */
export class XpandaProvider implements HarmonyAbcAnalysisPort {
  #tail: Promise<void> = Promise.resolve();
  #closed = false;
  #closing: Promise<void> | undefined;
  #retained: RetainedBridge | undefined;
  /** Bridge whose owned stop could not be proven; retried before the next run. */
  #pendingBridge: XpandaBridge | undefined;
  #pendingBridgeResources: readonly string[] = [];
  #idle: NodeJS.Timeout | undefined;
  #idleGeneration = 0;
  readonly #shutdown = new AbortController();
  readonly #idleRetireMs: number;
  readonly #platform: NodeJS.Platform;
  readonly #publication: XpandaPublicationHooks;
  constructor(
    readonly environment: Readonly<
      Record<string, string | undefined>
    > = process.env,
    readonly launcher?: OwnedMcpLauncher,
    options: {
      readonly idleRetireMs?: number;
      readonly platform?: NodeJS.Platform;
      readonly publication?: XpandaPublicationHooks;
    } = {},
  ) {
    this.#idleRetireMs = options.idleRetireMs ?? IDLE_RETIRE_MS;
    this.#platform = options.platform ?? HOST_PLATFORM.platform;
    this.#publication = options.publication ?? {};
  }

  /** Execute one explicit HarmonyOS Ark bytecode operation. */
  async execute(
    request: HarmonyAbcRequest,
    options?: ExecutionOptions,
  ): Promise<Outcome> {
    if (this.#closed)
      return err(cancelledBy(request.operation, OwnerCancellation.ownerClosed));
    this.#idleGeneration += 1;
    clearTimeout(this.#idle);
    this.#idle = undefined;
    const predecessor = this.#tail;
    let release = () => {};
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Cancel the caller promptly without letting a later request bypass its predecessor.
    try {
      await waitForTurn(predecessor, request.operation, options?.signal);
    } catch (cause: unknown) {
      void predecessor.then(release);
      return err(
        cause instanceof AnalysisError
          ? cause
          : cancelledBy(request.operation, carriedReason(cause)),
      );
    }
    try {
      if (this.#closed)
        return err(
          cancelledBy(request.operation, OwnerCancellation.ownerClosed),
        );
      const blocked = await this.#retryPendingBridge();
      if (blocked !== undefined) return err(blocked);
      return await this.#execute(request, options);
    } finally {
      release();
    }
  }

  /** Cancel queued work, retire the bridge and join its owned cleanup. */
  close(): Promise<void> {
    this.#closed = true;
    this.#shutdown.abort(OwnerCancellation.ownerClosed);
    clearTimeout(this.#idle);
    return (this.#closing ??= this.#tail
      .then(async () => {
        const pending = await this.#retryPendingBridge();
        const retired = await this.#retire();
        if (pending !== undefined && !retired.ok)
          throw analysisErrorWithCleanupDependencies(
            pending,
            retired.error,
            "close_xpanda",
          );
        if (pending !== undefined) throw pending;
        if (!retired.ok) throw retired.error;
      })
      .catch((cause: unknown) => {
        this.#closing = undefined;
        throw cause;
      }));
  }

  /** Retry a bridge whose previous stop was unproven; execution stays blocked. */
  async #retryPendingBridge(): Promise<AnalysisError | undefined> {
    if (this.#pendingBridge === undefined) return undefined;
    const bridge = this.#pendingBridge;
    try {
      await bridge.close();
      this.#pendingBridge = undefined;
      this.#pendingBridgeResources = [];
      return undefined;
    } catch (cause: unknown) {
      return new ProviderCleanupError(
        XPANDA_PROVIDER_ID,
        this.#pendingBridgeResources,
        { reason: errorMessage(cause) },
        { operation: "close_xpanda", cause },
      );
    }
  }

  /** Stop and prove the retained bridge; retain it when its stop is unproven. */
  async #retire(): Promise<Result<void, AnalysisError>> {
    clearTimeout(this.#idle);
    this.#idle = undefined;
    const bridge = this.#retained?.bridge;
    this.#retained = undefined;
    if (bridge === undefined) return ok(undefined);
    try {
      await bridge.close();
      return ok(undefined);
    } catch (cause: unknown) {
      this.#pendingBridge = bridge;
      this.#pendingBridgeResources = [bridge.transport.runId];
      return err(
        new ProviderCleanupError(
          XPANDA_PROVIDER_ID,
          this.#pendingBridgeResources,
          { reason: errorMessage(cause) },
          { operation: "close_xpanda", cause },
        ),
      );
    }
  }

  #scheduleIdle(): void {
    clearTimeout(this.#idle);
    const generation = ++this.#idleGeneration;
    this.#idle = setTimeout(() => {
      this.#tail = this.#tail.then(async () => {
        // A request that started after this timer was scheduled owns the
        // bridge again; its own completion schedules the next idle window.
        if (generation !== this.#idleGeneration) return;
        await this.#retryPendingBridge();
        await this.#retire();
      });
    }, this.#idleRetireMs);
    this.#idle.unref();
  }

  async #execute(
    request: HarmonyAbcRequest,
    options?: ExecutionOptions,
  ): Promise<Outcome> {
    if (this.#shutdown.signal.aborted)
      return err(cancelledBy(request.operation, this.#shutdown.signal));
    const timeoutMs =
      request.input.analysis_timeout_ms ??
      DEFAULT_HARMONY_ABC_ANALYSIS_TIMEOUT_MS;
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([
      timeout,
      this.#shutdown.signal,
      ...(options?.signal === undefined ? [] : [options.signal]),
    ]);
    let staged: StagedInput | undefined;
    let loadCompleted: XpandaSession | undefined;
    let lastResult: unknown;
    let engineFacts:
      | {
          readonly root: string;
          readonly sha256: string;
          readonly version: string;
        }
      | undefined;
    // Producer coherence errors keep the bridge; transport and deadline
    // failures poison a serialized single-threaded producer and retire it.
    let bridgeFatal = true;
    let outcome: Outcome;
    try {
      if (signal.aborted) throw cancelledBy(request.operation, signal);
      if (this.#platform !== "linux" && this.#platform !== "darwin")
        throw new AnalysisCapabilityUnavailableError(
          XPANDA_PROVIDER_ID,
          request.operation,
          `The xpanda provider requires Linux or macOS; ${this.#platform} is unsupported.`,
          { remediationAction: XPANDA_UNSUPPORTED_HOST_REMEDIATION },
        );
      const configuration = await resolveXpandaConfiguration(this.environment, {
        signal,
        platform: this.#platform,
      });
      if (!configuration.ok)
        throw configurationUnavailable(request.operation, configuration.error);
      const engine = await hashXpandaEngine(configuration.value.root).catch(
        (cause: unknown) => {
          if (cause instanceof XpandaEngineScanError)
            throw new AnalysisCapabilityUnavailableError(
              XPANDA_PROVIDER_ID,
              request.operation,
              cause.message,
              { remediationAction: XPANDA_CHECKOUT_REMEDIATION },
            );
          throw cause;
        },
      );
      const key = JSON.stringify({
        root: configuration.value.root,
        serverEntry: configuration.value.serverEntry,
        engine: engine.sha256,
        node: process.version,
      });
      if (this.#retained !== undefined && this.#retained.key !== key) {
        const retired = await this.#retire();
        if (!retired.ok) return err(retired.error);
      }
      // Stage before any engine acquisition so invalid inputs never start one.
      staged = await this.#stage(request, signal);
      await this.#admitOperation(request);
      if (this.#retained === undefined) {
        const bridge = new XpandaBridge(
          {
            command: process.execPath,
            arguments: ["--import", "tsx", configuration.value.serverEntry],
            expectedCommand: null,
            cwd: configuration.value.root,
            hostEnvironment: this.environment,
            signal: this.#shutdown.signal,
          },
          this.launcher,
        );
        this.#retained = {
          key,
          engineSha256: engine.sha256,
          version: configuration.value.version,
          bridge,
        };
      }
      const retained = this.#retained;
      const bridge = retained.bridge;
      const callContext = { signal, timeoutMs };
      bridge.beginRequest();
      await bridge.ensureConnected({
        operation: request.operation,
        signal,
        timeoutMs,
      });
      const load = await bridge.callJson(
        request.operation,
        "abc_load",
        xpandaSessionSchema,
        { path: staged.stagedPath },
        callContext,
      );
      loadCompleted = load;
      engineFacts = {
        root: configuration.value.root,
        sha256: retained.engineSha256,
        version: retained.version,
      };
      const result = await this.#dispatch(
        request,
        bridge,
        load,
        {
          root: configuration.value.root,
          sha256: retained.engineSha256,
          version: retained.version,
        },
        callContext,
        request.operation === "decompile_harmony_abc"
          ? join(staged.rootPath, "export")
          : undefined,
      );
      lastResult = result;
      let normalized = result;
      if (request.operation === "decompile_harmony_abc") {
        const exported =
          harmonyAbcResultSchemas.decompile_harmony_abc.parse(result);
        const published = await publishStagedExport({
          source: join(staged.rootPath, "export"),
          destination: request.input.output_directory,
          operation: request.operation,
          expectedWritten: exported.written,
          signal,
          ...this.#publication,
          interruption: () =>
            interruptionError({
              operation: request.operation,
              signal,
              timeout,
              timeoutMs,
              callerSignal: options?.signal,
              shutdown: this.#shutdown.signal,
              capturedOutput: () => bridge.transport.diagnostics(),
            }),
        });
        normalized = {
          ...exported,
          output_directory: request.input.output_directory,
          written: published.length,
        };
      }
      const parsed =
        harmonyAbcResultSchemas[request.operation].parse(normalized);
      // Best-effort producer session release; the producer's LRU bounds any
      // leak, and a failed close stays visible in the retained raw facts.
      let sessionCloseFailed = false;
      let closeCleanup: AnalysisError | undefined;
      try {
        await bridge.call(
          request.operation,
          "abc_close",
          { fileId: load.fileId },
          callContext,
        );
      } catch {
        sessionCloseFailed = true;
        // A producer that answered with an error keeps the session. A transport
        // that already failed must not be reused for the next request.
        if (bridge.transport.observedFailure() !== undefined) {
          const retired = await this.#retire();
          if (!retired.ok) closeCleanup = retired.error;
        }
      }
      const execution = createAnalysisExecution(
        parsed,
        { id: XPANDA_PROVIDER_ID, name: "xpanda", version: retained.version },
        {
          rawResult: {
            server: bridge.serverIdentity(),
            engine_sha256: retained.engineSha256,
            engine_files: engine.files,
            engine_bytes: engine.bytes,
            staged_input: { bytes: staged.size, sha256: staged.sha256 },
            load,
            calls: bridge.observedCalls(),
            session_close_failed: sessionCloseFailed,
          },
          subject: {
            path: request.input.path,
            sha256: staged.sha256,
            format: request.operation.startsWith("inspect_harmony_hap_")
              ? ("hap" as const)
              : ("abc" as const),
          },
          limitations: [
            ...XPANDA_LIMITATIONS,
            ...(retained.version === XPANDA_VERIFIED_VERSION
              ? []
              : [
                  `The configured xpanda checkout reports ${retained.version}; REA verified ${XPANDA_VERIFIED_VERSION}, so this release's producer surface is unverified.`,
                ]),
          ],
          locations:
            request.operation === "decompile_harmony_abc"
              ? [
                  {
                    kind: "artifact-path",
                    path: request.input.output_directory,
                  },
                ]
              : [],
        },
      );
      bridgeFatal = false;
      outcome =
        closeCleanup === undefined
          ? ok(execution)
          : err(
              closeCleanup.retainPartialObservation(
                completedHarmonyAbcObservation(execution),
              ),
            );
    } catch (cause: unknown) {
      if (cause instanceof AnalysisInputError) bridgeFatal = false;
      const bridge = this.#retained?.bridge;
      // Completed producer stages stay with the failure: load facts, the last
      // tool reply, the staged identity and the calls observed so far.
      const partial: HarmonyAbcPartialObservation | undefined =
        loadCompleted === undefined
          ? undefined
          : {
              kind: "harmony-abc",
              result: ownedJsonValueSchema.parse(
                lastResult === undefined ? loadCompleted : lastResult,
              ),
              provenance: ownedJsonValueSchema.parse({
                ...(staged === undefined
                  ? {}
                  : {
                      staged_input: {
                        bytes: staged.size,
                        sha256: staged.sha256,
                      },
                    }),
                load: loadCompleted,
                ...(engineFacts === undefined ? {} : { engine: engineFacts }),
                calls: bridge?.observedCalls() ?? [],
              }),
            };
      const failure = captureXpandaFailure({
        cause,
        request,
        timeout,
        timeoutMs,
        signal: options?.signal,
        shutdown: this.#shutdown.signal,
        ...(partial === undefined ? {} : { partial }),
        bridge,
      });
      if (bridgeFatal) {
        const retired = await this.#retire();
        if (!retired.ok) {
          outcome = err(
            analysisErrorWithCleanupDependencies(
              failure(),
              retired.error,
              request.operation,
            ),
          );
        } else outcome = err(failure());
      } else outcome = err(failure());
    }
    if (this.#retained !== undefined) this.#scheduleIdle();
    return finishStagedInput(staged, outcome, request.operation);
  }

  /** Operation-specific admission that must precede any producer call. */
  async #admitOperation(request: HarmonyAbcRequest): Promise<void> {
    if (request.operation !== "decompile_harmony_abc") return;
    // The documented contract is an absent directory: the producer creates it
    // recursively and overwrites per-class files inside it.
    try {
      await stat(request.input.output_directory);
      throw new AnalysisInputError(request.operation, undefined, [
        {
          path: ["output_directory"],
          reason: "invalid_value",
          message: `The output directory already exists: ${request.input.output_directory}. Select an absent directory; the producer creates it and may overwrite its files.`,
        },
      ]);
    } catch (cause: unknown) {
      if (cause instanceof AnalysisInputError) throw cause;
      if (
        !(cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      )
        throw new AnalysisInputError(request.operation, { cause }, [
          {
            path: ["output_directory"],
            reason: "invalid_value",
            message: `The output directory path is not usable: ${request.input.output_directory}: ${errorMessage(cause)}`,
          },
        ]);
    }
  }

  /** Copy the selected bytes once into a private root and bind their identity. */
  async #stage(
    request: HarmonyAbcRequest,
    signal: AbortSignal,
  ): Promise<StagedInput> {
    const root = await PrivateRuntimeRoot.create({ prefix: "rea-xpanda-" });
    const lease = new AnalysisCleanupLease(() => root.close());
    const failedHandles = new Map<OwnedFileHandle, string>();
    const retainFailedClose = (path: string) => (owner: OwnedFileHandle) => {
      // A hash descriptor that cannot close joins this input's staged cleanup.
      failedHandles.set(owner, path);
    };
    try {
      const stagedPath = join(root.path, "input.abc");
      let size: number;
      try {
        const source = await stat(request.input.path);
        size = source.size;
        if (!source.isFile()) size = Number.NaN;
      } catch (cause: unknown) {
        if (
          cause instanceof Error &&
          "code" in cause &&
          cause.code === "ENOENT"
        )
          throw new AnalysisInputError(request.operation, undefined, [
            {
              path: ["path"],
              reason: "invalid_value",
              message: `The selected path does not exist: ${request.input.path}`,
            },
          ]);
        throw cause;
      }
      if (!Number.isSafeInteger(size) || size < 0)
        throw new AnalysisInputError(request.operation, undefined, [
          {
            path: ["path"],
            reason: "invalid_value",
            message: `The selected path is not a regular file: ${request.input.path}`,
          },
        ]);
      if (size > XPANDA_LIMITS.inputBytes)
        throw new AnalysisInputError(
          request.operation,
          {
            userMessage: `The selected HarmonyOS Ark bytecode file is ${String(size)} bytes; this integration admits at most ${String(XPANDA_LIMITS.inputBytes)} bytes.`,
          },
          [
            {
              path: ["path"],
              reason: "invalid_value",
              message: `Input exceeds the ${String(XPANDA_LIMITS.inputBytes)}-byte admission bound`,
            },
          ],
        );
      const copyFailed = (cause: unknown) =>
        new AnalysisInputError(
          request.operation,
          {
            cause,
            userMessage: `REA could not copy the selected file ${request.input.path}: ${errorMessage(cause)}`,
          },
          [
            {
              path: ["path"],
              reason: "invalid_value",
              message: "The selected file could not be copied",
            },
          ],
        );
      try {
        await copyFile(request.input.path, stagedPath);
      } catch (cause: unknown) {
        if (signal.aborted) throw signal.reason;
        throw copyFailed(cause);
      }
      if (signal.aborted) throw signal.reason;
      const staged = await stat(stagedPath).catch((cause: unknown) => {
        throw copyFailed(cause);
      });
      // A file that grew after the size check must not exceed the admitted
      // bound, and its copied length must still be the selected length.
      if (!staged.isFile() || staged.size !== size)
        throw new AnalysisInputError(
          request.operation,
          {
            userMessage: `The selected file changed while REA staged it at ${request.input.path}; retry against a stable file.`,
          },
          [
            {
              path: ["path"],
              reason: "invalid_value",
              message: "Input changed during staging",
            },
          ],
        );
      if (staged.size > XPANDA_LIMITS.inputBytes)
        throw new AnalysisInputError(
          request.operation,
          {
            userMessage: `The copied input is ${String(staged.size)} bytes; this integration admits at most ${String(XPANDA_LIMITS.inputBytes)} bytes.`,
          },
          [
            {
              path: ["path"],
              reason: "invalid_value",
              message: `Input exceeds the ${String(XPANDA_LIMITS.inputBytes)}-byte admission bound`,
            },
          ],
        );
      const inputChanged = (path: string) =>
        new AnalysisInputError(
          request.operation,
          {
            userMessage: `The selected file changed while REA staged it at ${path}; retry against a stable file.`,
          },
          [
            {
              path: ["path"],
              reason: "invalid_value",
              message: "Input changed during staging",
            },
          ],
        );
      let sourceSha256: string;
      try {
        sourceSha256 = (
          await hashStableFile(request.input.path, {
            signal,
            retainFailedClose: retainFailedClose(request.input.path),
          })
        ).sha256;
      } catch (cause: unknown) {
        if (cause instanceof RegularFileChangedError)
          throw inputChanged(request.input.path);
        // The reader owns cancellation facts; let failure selection map the
        // caller abort or timeout instead of claiming the input was bad.
        if (regularFileCancellation(cause) !== undefined) throw cause;
        throw copyFailed(cause);
      }
      let stagedSha256: string;
      try {
        stagedSha256 = (
          await hashStableFile(stagedPath, {
            signal,
            retainFailedClose: retainFailedClose(stagedPath),
          })
        ).sha256;
      } catch (cause: unknown) {
        if (cause instanceof RegularFileChangedError)
          throw inputChanged(stagedPath);
        if (regularFileCancellation(cause) !== undefined) throw cause;
        throw copyFailed(cause);
      }
      if (stagedSha256 !== sourceSha256) throw inputChanged(request.input.path);
      return {
        lease,
        rootPath: root.path,
        stagedPath,
        sha256: stagedSha256,
        size,
        failedHandles,
      };
    } catch (cause: unknown) {
      // Join failed hash descriptors, then release the root. A cleanup that
      // still fails keeps its owner on the lease and surfaces as the primary's
      // cleanup dependency instead of disappearing with the staging failure.
      const closeCauses: unknown[] = [];
      for (const [owner] of failedHandles) {
        try {
          await owner.close();
          failedHandles.delete(owner);
        } catch (closeCause: unknown) {
          closeCauses.push(closeCause);
        }
      }
      try {
        await lease.release();
      } catch (closeCause: unknown) {
        closeCauses.push(closeCause);
      }
      if (closeCauses.length === 0) throw cause;
      const cleanup = new ProviderCleanupError(
        XPANDA_PROVIDER_ID,
        [root.path],
        {
          reason: closeCauses
            .map((failure) => errorMessage(failure))
            .join("; "),
        },
        {
          operation: request.operation,
          cause: new AggregateError([cause, ...closeCauses]),
        },
      );
      if (!lease.released) lease.bindCleanupError(cleanup);
      throw cause instanceof AnalysisError
        ? analysisErrorWithCleanupDependencies(
            cause,
            cleanup,
            request.operation,
          )
        : cleanup;
    }
  }

  /** Producer call sequence for one admitted operation. */
  async #dispatch(
    request: HarmonyAbcRequest,
    bridge: XpandaBridge,
    load: XpandaSession,
    engine: EngineFacts,
    context: { readonly signal: AbortSignal; readonly timeoutMs: number },
    producerExportDirectory: string | undefined,
  ): Promise<unknown> {
    const engineFacts = {
      name: XPANDA_PROVIDER_ID,
      version: engine.version,
      root_path: engine.root,
      engine_sha256: engine.sha256,
      source_revision: null,
      bytecode_version_support: XPANDA_BYTECODE_VERSION_SUPPORT,
    };
    const budget =
      request.input.analysis_timeout_ms ??
      DEFAULT_HARMONY_ABC_ANALYSIS_TIMEOUT_MS;
    const hapOperation = request.operation.startsWith("inspect_harmony_hap_");
    if (hapOperation !== isHapLoad(load)) {
      throw new AnalysisInputError(request.operation, undefined, [
        {
          path: ["path"],
          reason: "invalid_value",
          message: hapOperation
            ? "The selected file is not a HarmonyOS application package (.hap)."
            : "The selected file is a HarmonyOS application package (.hap); select an .abc entry with inspect_harmony_hap_abc first.",
        },
      ]);
    }
    if (!hapOperation && isHapLoad(load)) throw new Error("unreachable");
    await bridge.requireTool(request.operation, context);
    switch (request.operation) {
      case "inspect_harmony_abc": {
        if (isHapLoad(load)) throw new Error("unreachable");
        return {
          analysis_timeout_ms: budget,
          engine: engineFacts,
          input_size: load.fileSizeBytes,
          bytecode_version: load.bytecodeVersion,
          checksum: load.checksum,
          class_count: load.classCount,
          foreign_class_count: load.foreignClassCount,
          lnp_count: load.lnpCount,
          class_name_preview: load.classesPreview,
          preview_truncated: load.previewTruncated,
          coverage: "header",
        };
      }
      case "list_harmony_abc_classes": {
        const listing = await bridge.callJson(
          request.operation,
          "abc_list_classes",
          xpandaClassListSchema,
          {
            fileId: load.fileId,
            ...(request.input.filter === undefined
              ? {}
              : { filter: request.input.filter }),
            offset: request.input.offset,
            limit: request.input.limit,
          },
          context,
        );
        return {
          analysis_timeout_ms: budget,
          engine: engineFacts,
          total_classes: listing.total,
          filtered_classes: listing.filtered,
          offset: listing.offset,
          returned: listing.returned,
          truncated: listing.truncated,
          classes: listing.classes,
          coverage: "class_inventory",
        };
      }
      case "decompile_harmony_abc_class": {
        const decompiled = parseXpandaDecompile(
          request.operation,
          await bridge.call(
            request.operation,
            "abc_decompile_class",
            {
              fileId: load.fileId,
              className: request.input.class_name,
              ...(request.input.simplify ? {} : { simplify: false }),
            },
            context,
          ),
        );
        return {
          analysis_timeout_ms: budget,
          engine: engineFacts,
          class_name:
            decompiled.className.length > 0
              ? decompiled.className
              : request.input.class_name,
          simplified: decompiled.simplified,
          degraded: decompiled.degraded,
          empty_result: decompiled.emptyResult,
          truncated: decompiled.truncated,
          characters: decompiled.characters,
          content: decompiled.content,
          coverage: "single_class",
        };
      }
      case "decompile_harmony_abc": {
        const exported = await bridge.callJson(
          request.operation,
          "abc_export",
          xpandaExportSchema,
          {
            fileId: load.fileId,
            outDir: producerExportDirectory ?? request.input.output_directory,
            ...(request.input.simplify ? {} : { simplify: false }),
          },
          context,
        );
        return {
          analysis_timeout_ms: budget,
          engine: engineFacts,
          output_directory: exported.outDir,
          written: exported.written,
          skipped: exported.skipped,
          failed: exported.failed,
          degraded_classes: exported.degradedClasses,
          files: exported.files,
          files_truncated: exported.filesTruncated,
          coverage:
            exported.failed > 0 || exported.skipped > 0
              ? "partial"
              : "complete",
        };
      }
      case "disassemble_harmony_abc_method": {
        const disassembled = parseXpandaDisassembly(
          request.operation,
          await bridge.call(
            request.operation,
            "abc_disassemble_method",
            {
              fileId: load.fileId,
              className: request.input.class_name,
              ...(request.input.method_name === undefined
                ? {}
                : { methodName: request.input.method_name }),
              maxInstructions: request.input.max_instructions,
            },
            context,
          ),
        );
        return {
          analysis_timeout_ms: budget,
          engine: engineFacts,
          class_name: request.input.class_name,
          method_name: disassembled.methodName,
          virtual_registers: disassembled.virtualRegisters,
          arguments: disassembled.arguments,
          blocks: disassembled.blocks,
          truncated: disassembled.truncated,
          text: disassembled.text,
          coverage: "single_method",
        };
      }
      case "search_harmony_abc_strings": {
        const matches = await bridge.callJson(
          request.operation,
          "abc_search_strings",
          xpandaStringMatchesSchema,
          {
            fileId: load.fileId,
            pattern: request.input.pattern,
            regex: request.input.regex,
            offset: request.input.offset,
            limit: request.input.limit,
          },
          context,
        );
        return {
          analysis_timeout_ms: budget,
          engine: engineFacts,
          pool_size: matches.poolSize,
          matched: matches.matched,
          offset: matches.offset,
          returned: matches.returned,
          truncated: matches.truncated,
          strings: matches.strings,
          coverage: "string_pool",
        };
      }
      case "inspect_harmony_abc_class": {
        const metadata = await bridge.callJson(
          request.operation,
          "abc_get_class",
          xpandaClassMetadataSchema,
          {
            fileId: load.fileId,
            className: request.input.class_name,
          },
          context,
        );
        return {
          analysis_timeout_ms: budget,
          engine: engineFacts,
          class_name: metadata.name,
          raw_name: metadata.rawName,
          super_class: metadata.superClass,
          external: metadata.external,
          access_flags: metadata.accessFlags,
          fields: metadata.fields.map(({ name, type, external }) => ({
            name,
            field_type: type,
            external,
          })),
          methods: metadata.methods.map(
            ({
              name,
              accessFlags,
              external,
              hasCode,
              hasTryCatch,
              shorty,
            }) => ({
              name,
              access_flags: accessFlags,
              external,
              has_code: hasCode,
              has_try_catch: hasTryCatch,
              shorty,
            }),
          ),
          imports: metadata.imports.map(
            ({ localName, importName, path, kind }) => ({
              local_name: localName,
              import_name: importName,
              path,
              kind,
            }),
          ),
          exports: metadata.exports.map(
            ({ localName, exportName, path, kind }) => ({
              local_name: localName,
              export_name: exportName,
              path,
              kind,
            }),
          ),
          coverage: "class_metadata",
        };
      }
      case "decompile_harmony_abc_method": {
        const decompiled = parseXpandaDecompile(
          request.operation,
          await bridge.call(
            request.operation,
            "abc_decompile_method",
            {
              fileId: load.fileId,
              className: request.input.class_name,
              methodName: request.input.method_name,
              ...(request.input.simplify ? {} : { simplify: false }),
            },
            context,
          ),
        );
        return {
          analysis_timeout_ms: budget,
          engine: engineFacts,
          class_name:
            decompiled.className.length > 0
              ? decompiled.className
              : request.input.class_name,
          method_name: decompiled.methodName ?? request.input.method_name,
          simplified: decompiled.simplified,
          degraded: decompiled.degraded,
          empty_result: decompiled.emptyResult,
          truncated: decompiled.truncated,
          characters: decompiled.characters,
          content: decompiled.content,
          coverage: "method_source",
        };
      }
      case "search_harmony_abc_symbols": {
        const found = await bridge.callJson(
          request.operation,
          "abc_search_symbols",
          xpandaSymbolSearchSchema,
          {
            fileId: load.fileId,
            query: request.input.query,
            kind: request.input.kind,
            regex: request.input.regex,
            caseSensitive: request.input.case_sensitive,
            ...(request.input.class_filter === undefined
              ? {}
              : { classFilter: request.input.class_filter }),
            includeExternal: request.input.include_external,
            offset: request.input.offset,
            limit: request.input.limit,
          },
          context,
        );
        return {
          analysis_timeout_ms: budget,
          engine: engineFacts,
          total: found.total,
          offset: found.offset,
          limit: found.limit,
          returned: found.returned,
          truncated: found.truncated,
          matches: found.matches.map((match) => ({
            kind: match.kind,
            raw_name: match.rawName,
            name: match.name,
            ...(match.ownerClass === undefined
              ? {}
              : { owner_class: match.ownerClass }),
            ...(match.ownerClassName === undefined
              ? {}
              : { owner_class_name: match.ownerClassName }),
            ...(match.type === undefined ? {} : { field_type: match.type }),
            ...(match.methodCount === undefined
              ? {}
              : { method_count: match.methodCount }),
            ...(match.fieldCount === undefined
              ? {}
              : { field_count: match.fieldCount }),
            ...(match.external === undefined
              ? {}
              : { external: match.external }),
            ...(match.hasCode === undefined ? {} : { has_code: match.hasCode }),
          })),
          coverage: "symbol_index",
        };
      }
      case "search_harmony_abc_code": {
        const found = await bridge.callJson(
          request.operation,
          "abc_search_code",
          xpandaCodeSearchSchema,
          {
            fileId: load.fileId,
            pattern: request.input.pattern,
            regex: request.input.regex,
            caseSensitive: request.input.case_sensitive,
            ...(request.input.class_filter === undefined
              ? {}
              : { classFilter: request.input.class_filter }),
            simplify: request.input.simplify,
            maxClasses: request.input.max_classes,
            contextLines: request.input.context_lines,
            offset: request.input.offset,
            limit: request.input.limit,
          },
          context,
        );
        return {
          analysis_timeout_ms: budget,
          engine: engineFacts,
          pattern: found.pattern,
          simplified: found.simplified,
          scanned_classes: found.scannedClasses,
          skipped_classes: found.skippedClasses,
          failed_classes: found.failedClasses,
          failed_class_count: found.failedClassCount,
          candidate_classes: found.candidateClasses,
          truncated_classes: found.truncatedClasses,
          total: found.total,
          offset: found.offset,
          limit: found.limit,
          returned: found.returned,
          truncated: found.truncated,
          matches: found.matches.map(
            ({ className, line, text, method, methodKind, context }) => ({
              class_name: className,
              line,
              text,
              ...(method === undefined ? {} : { method }),
              ...(methodKind === undefined ? {} : { method_kind: methodKind }),
              ...(context === undefined
                ? {}
                : { context: context.map((entry) => ({ ...entry })) }),
            }),
          ),
          coverage: "decompiled_source",
        };
      }
      case "trace_harmony_abc_references": {
        const found = await bridge.callJson(
          request.operation,
          "abc_xrefs",
          xpandaXrefsSchema,
          {
            fileId: load.fileId,
            targetType: request.input.target_type,
            target: request.input.target,
            ...(request.input.owner_class === undefined
              ? {}
              : { ownerClass: request.input.owner_class }),
            source: request.input.source,
            maxClasses: request.input.max_classes,
            offset: request.input.offset,
            limit: request.input.limit,
          },
          context,
        );
        return {
          analysis_timeout_ms: budget,
          engine: engineFacts,
          target_type: found.targetType,
          target: found.target,
          target_owner: found.targetOwner,
          total: found.total,
          offset: found.offset,
          limit: found.limit,
          returned: found.returned,
          truncated: found.truncated,
          source_scanned_classes: found.sourceScannedClasses,
          source_truncated_classes: found.sourceTruncatedClasses,
          xref_count: found.xrefCount,
          disassembly_failures: found.disassemblyFailures,
          matches: found.matches.map((match) => ({
            from_class: match.fromClass,
            from_class_raw: match.fromClassRaw,
            from_method: match.fromMethod,
            pc: match.pc,
            line: match.line ?? null,
            opcode: match.opcode,
            kind: match.kind,
            target_type: match.targetType,
            target_name: match.targetName,
            target_class: match.targetClass,
            target_class_raw: match.targetClassRaw,
            origin: match.origin,
          })),
          coverage: "bytecode_references",
        };
      }
      case "build_harmony_abc_call_graph": {
        const graph = await bridge.callJson(
          request.operation,
          "abc_call_graph",
          xpandaCallGraphSchema,
          {
            fileId: load.fileId,
            className: request.input.class_name,
            methodName: request.input.method_name,
            direction: request.input.direction,
            depth: request.input.depth,
            maxNodes: request.input.max_nodes,
            maxClasses: request.input.max_classes,
            simplify: request.input.simplify,
            format: request.input.format,
          },
          context,
        );
        return {
          analysis_timeout_ms: budget,
          engine: engineFacts,
          root_class: graph.root.class,
          root_method: graph.root.method,
          direction: graph.direction,
          depth: graph.depth,
          node_count: graph.nodeCount,
          edge_count: graph.edgeCount,
          truncated: graph.truncated,
          disassembly_failures: graph.disassemblyFailures,
          source_truncated_classes: graph.sourceTruncatedClasses,
          nodes: graph.nodes.map((node) => ({
            id: node.id,
            class_name: node.className,
            class_raw: node.classRaw,
            method: node.method,
            depth: node.depth,
            via: node.via,
          })),
          edges: graph.edges,
          ...(graph.mermaid === undefined ? {} : { mermaid: graph.mermaid }),
          coverage: "call_graph",
        };
      }
      case "inspect_harmony_hap_abc": {
        if (!isHapLoad(load)) throw new Error("unreachable");
        const extracted = await bridge.callJson(
          request.operation,
          "hap_read_abc",
          xpandaHapAbcSchema,
          {
            fileId: load.fileId,
            ...(request.input.entry === undefined
              ? {}
              : { entry: request.input.entry }),
          },
          context,
        );
        return {
          analysis_timeout_ms: budget,
          engine: engineFacts,
          entry: extracted.entry,
          cached: extracted.cached,
          runtime: extracted.runtime,
          bytecode_version: extracted.bytecodeVersion,
          class_count: extracted.classCount,
          class_name_preview: extracted.classesPreview,
          preview_truncated: extracted.previewTruncated,
          coverage: "hap_entry",
        };
      }
      case "inspect_harmony_hap_resources": {
        if (!isHapLoad(load)) throw new Error("unreachable");
        const resources = await bridge.callJson(
          request.operation,
          "hap_resources",
          xpandaHapResourcesSchema,
          {
            fileId: load.fileId,
            ...(request.input.name === undefined
              ? {}
              : { name: request.input.name }),
            ...(request.input.type === undefined
              ? {}
              : { type: request.input.type }),
            ...(request.input.limit_key === undefined
              ? {}
              : { limitKey: request.input.limit_key }),
            ...(request.input.id === undefined ? {} : { id: request.input.id }),
            offset: request.input.offset,
            limit: request.input.limit,
          },
          context,
        );
        return {
          analysis_timeout_ms: budget,
          engine: engineFacts,
          format: resources.format,
          version: resources.version,
          total: resources.total,
          matched: resources.matched,
          by_type: resources.byType,
          by_limit_key: resources.byLimitKey,
          offset: resources.offset,
          limit: resources.limit,
          returned: resources.items.length,
          truncated: resources.truncated,
          resources: resources.items.map(
            ({ id, name, type, limitKey, value }) => ({
              id,
              name,
              resource_type: type,
              limit_key: limitKey,
              value,
            }),
          ),
          coverage: "hap_resources",
        };
      }
    }
  }
}
