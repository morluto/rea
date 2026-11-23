import {
  runtimeExhaustionReport,
  type RuntimeExhaustion,
} from "../process/RuntimeExhaustion.js";
import { Budget } from "../domain/budget.js";
import { fixedAllowanceOptions } from "../domain/fixedAllowanceRemediation.js";
import { invariantViolation } from "../domain/internalInvariant.js";
import {
  DEFAULT_JAVASCRIPT_MEMBER_MUTATION_ALLOWANCE,
  javaScriptMemberMutationAllowanceField,
  javaScriptMemberMutationRefusal,
  reportsJavaScriptMemberMutationRefusal,
  type JavaScriptMemberMutationAllowance,
} from "../domain/javascript/javascriptSemanticWorkAllowance.js";
import {
  retainProcessInspectionCleanup,
  processInspectionCancellationError,
  processInspectionFailure,
} from "../providers/OwnedCommandCleanup.js";
import type { JavaScriptSemanticPrecisionInput } from "../domain/javascript/javascriptSemanticPrecision.js";
import { analysisErrorWithCancellation } from "../domain/analysisErrorCancellation.js";
import { WorkerFrameSignal } from "../process/WorkerFrameSignal.js";
import type { WebBundleEndpointLiteralAdmission } from "../domain/webBundleEndpointLiteralBudget.js";
import { Utf8NdjsonLineBuffer } from "../process/Utf8NdjsonLineBuffer.js";
import { createHash, randomUUID } from "node:crypto";
import { open, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getHeapStatistics } from "node:v8";
import {
  ArtifactReaderFailure,
  ArtifactResourceScope,
  AnalysisCleanupLease,
  AnalysisCleanupLeaseGroup,
  artifactFileCompletion,
  ArtifactFileCleanupFailure,
  artifactFileCancellationCause,
  artifactFilePrimaryFacts,
  assertArtifactReadActive,
  withArtifactFileHandle,
  completedStableArtifact,
  readStableArtifact,
  type StableArtifactSnapshot,
} from "../resources/index.js";
import {
  AnalysisError,
  type AnalysisErrorOptions,
} from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisTimeoutError,
  AnalysisOutputError,
  AnalysisResourceConstraintError,
  cancelledBy,
  carriedReason,
} from "../domain/analysisErrorCore.js";
import { analysisErrorWithCleanupDependencies } from "../domain/analysisErrorCleanup.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { jsonParts, bufferedJsonParts } from "../domain/jsonSerialization.js";
import { safeParseUtf8Json } from "../domain/safeJson.js";
import { javaScriptRuntime } from "../domain/runtimeVersion.js";
import { err, ok, type Result } from "../domain/result.js";
import type { IncludedScript } from "../domain/webBundleAnalyzerState.js";
import {
  unavailableWebScriptRecovery,
  webBundleScriptAnalysisSchema,
  type WebBundleScriptAnalysis,
} from "../domain/webBundleScriptAnalysis.js";
import {
  OwnedWorkerRuntime,
  WorkerCleanupRegistry,
  processWorkerCleanup,
} from "../process/OwnedWorkerRuntime.js";
import {
  RuntimeControlUnavailableError,
  runtimeControlCapabilityError,
} from "../domain/runtimeControlUnavailableError.js";
import { spawnOwnedProviderProcess } from "../process/ProviderProcess.js";
import { ProviderStartupDeadline } from "../process/ProviderDeadline.js";
import { prepareProcessOwnershipInspection } from "../process/ProcessOwnershipObservation.js";
import { javaScriptWorkerMemoryLimitBytes } from "../process/JavaScriptWorkerMemoryLimit.js";
import {
  DEFAULT_WEB_BUNDLE_HEAP_MB,
  MAX_WEB_BUNDLE_HEAP_MB,
  MIN_WEB_BUNDLE_HEAP_MB,
  webBundleFixedByteBudget,
  webBundleHeapExhaustedReason,
  webBundleHeapLimit,
  webBundleHeapExhaustedRemediation,
  webBundleMemoryExhaustion,
  webBundleResultAdmissionFailure,
  webBundleScriptTimeoutRecovery,
} from "../domain/webBundleAnalysis.js";
import {
  WEB_BUNDLE_WORKER_LIMITS,
  webBundleWorkerMessageSchema,
  webBundleWorkerRequestSchema,
  type WebBundleWorkerMessage,
} from "./WebBundleAnalysisWorkerProtocol.js";

const OPERATION = "analyze_web_bundle";

/**
 * A worker resource refusal. The member-mutation allowance is deterministic
 * for the same script and names its setting; any other refusal is measured
 * memory exhaustion.
 */
const webBundleResourceFailure = (
  frame: Extract<WebBundleWorkerMessage, { readonly kind: "failure" }>,
  job: WebBundleActiveJob,
  capturedOutput?: AnalysisErrorOptions["capturedOutput"],
): AnalysisResourceConstraintError => {
  const limits = {
    ...frame.limits,
    result_budget_bytes: job.resultBudgetBytes,
  };
  if (reportsJavaScriptMemberMutationRefusal(frame.limits))
    return javaScriptMemberMutationRefusal(
      OPERATION,
      job.memberMutationAllowance,
      limits,
      capturedOutput,
    );
  return new AnalysisResourceConstraintError(
    OPERATION,
    "memory",
    frame.message,
    limits,
    {
      ...(capturedOutput === undefined ? {} : { capturedOutput }),
      measuredExhaustion: true,
    },
  );
};
const PROVIDER = "web-bundle-static-analysis";

const scriptTimeout = (
  timeoutMs: number,
  cause?: unknown,
): AnalysisTimeoutError =>
  new AnalysisTimeoutError(OPERATION, timeoutMs, {
    ...(cause === undefined ? {} : { cause }),
    ...webBundleScriptTimeoutRecovery(timeoutMs),
  });
const MIB = 1024 * 1024;
/** Source/result buffers, decoded strings, parsed objects and validation copies. */
const RESULT_EXPANSION = 16;

type WebBundleResultDescriptor = Extract<
  WebBundleWorkerMessage,
  { readonly kind: "complete" }
>["result"];

type WebBundleObservedFailure =
  | { readonly kind: "input"; readonly cause: Error }
  | { readonly kind: "protocol"; readonly cause: unknown }
  | { readonly kind: "incomplete-output" }
  | {
      readonly kind: "frame";
      readonly frame: Extract<
        WebBundleWorkerMessage,
        { readonly kind: "failure" }
      >;
      readonly job: WebBundleActiveJob;
    }
  | {
      readonly kind: "exit";
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly memoryLimitReached: boolean;
      readonly heapExhaustion: boolean;
      /** The runtime's own report, kept once the supervisor observed it. */
      readonly exhaustion?: RuntimeExhaustion;
    };

type WebBundleActiveJob = {
  readonly id: string;
  readonly resultBudgetBytes: number;
  readonly memberMutationAllowance: JavaScriptMemberMutationAllowance;
};

export interface WebBundleScriptAnalysisFailure {
  readonly error: AnalysisError;
  readonly completed: WebBundleScriptAnalysis | null;
  readonly continuation?: "result_capacity_exhausted";
}

/** Sequential inert-source analysis; only bounded completed facts cross into the host. */
export class WebBundleAnalysisWorker {
  readonly #runtime: OwnedWorkerRuntime;
  readonly #files = new ArtifactResourceScope();
  readonly #cleanup: AnalysisCleanupLease;
  readonly #lines = new Utf8NdjsonLineBuffer(
    () => WEB_BUNDLE_WORKER_LIMITS.protocolBytes,
  );
  #frames: WebBundleWorkerMessage[] = [];
  #protocolFailure: unknown;
  #observedFailure: WebBundleObservedFailure | undefined;
  #activeDeadline: ProviderStartupDeadline | undefined;
  #activeJob: WebBundleActiveJob | undefined;
  #activeTerminalResponseObserved = false;
  readonly #frameSignal = new WorkerFrameSignal();
  readonly #retainedResult = new Budget(WEB_BUNDLE_WORKER_LIMITS.resultBytes);
  #ready = false;
  readonly #stdout = (chunk: Buffer | string): void => {
    if (this.#activeDeadline?.interruption !== undefined) return;
    if (this.#protocolFailure !== undefined) return;
    try {
      // Refuse the chunk before appending it to any retained control text.
      if (
        Buffer.byteLength(chunk) + this.#lines.pendingBytes >
        WEB_BUNDLE_WORKER_LIMITS.protocolBytes
      )
        throw new RangeError(
          webBundleFixedByteBudget(
            WEB_BUNDLE_WORKER_LIMITS.protocolBytes,
            "control-frame budget",
          ),
        );
      for (const line of this.#lines.pushRaw(
        typeof chunk === "string" ? Buffer.from(chunk) : chunk,
      )) {
        if (!line.ok) throw line.error;
        if (this.#frames.length >= 16)
          throw new RangeError("Web analyzer exceeded its control-frame queue");
        const frame = webBundleWorkerMessageSchema.parse(
          JSON.parse(line.value),
        );
        this.#frames.push(frame);
        this.#observeFrame(frame);
      }
      this.#frameSignal.wake("frame");
    } catch (cause) {
      this.#lines.reset();
      this.#protocolFailure = cause;
      this.#latchFailure({ kind: "protocol", cause });
      this.#frameSignal.wake("failure");
    }
  };

  constructor(
    readonly heapMb = DEFAULT_WEB_BUNDLE_HEAP_MB,
    launcher: typeof spawnOwnedProviderProcess = spawnOwnedProviderProcess,
    workerCleanup: WebBundleWorkerCleanup = processWebBundleCleanup,
  ) {
    if (
      !Number.isSafeInteger(heapMb) ||
      heapMb < MIN_WEB_BUNDLE_HEAP_MB ||
      heapMb > MAX_WEB_BUNDLE_HEAP_MB
    )
      throw new RangeError(
        `Web analyzer heap must be an integer from ${String(MIN_WEB_BUNDLE_HEAP_MB)} through ${String(MAX_WEB_BUNDLE_HEAP_MB)} MiB (max_heap_mb)`,
      );
    this.#runtime = new OwnedWorkerRuntime({
      rootPrefix: "rea-web-bundle-analysis-",
      launcher,
      cleanupRegistry: workerCleanup.runtimes,
      retryCleanup: () => this.close(),
      onInputFailure: (cause) => {
        if (this.#activeDeadline?.interruption !== undefined) return;
        this.#latchFailure({ kind: "input", cause });
        this.#frameSignal.wake("failure");
      },
      supervisorOptions: {
        captureStdout: false,
        maxDiagnosticBytes: 256 * 1024,
        // V8's heap report is observed as output streams, so a retention
        // budget or a stack trace that overflowed it cannot hide it.
        runtime: "v8",
        onDiagnostic: (event) => {
          if (this.#activeDeadline?.interruption !== undefined) return;
          if (event.type === "exit") {
            if (event.code !== 0 || event.signal !== null) {
              const memoryLimitReached =
                event.snapshot.memoryLimitReached === true;
              this.#latchFailure({
                kind: "exit",
                code: event.code,
                signal: event.signal,
                memoryLimitReached,
                heapExhaustion:
                  memoryLimitReached ||
                  event.snapshot.runtimeExhaustion !== undefined,
                ...(event.snapshot.runtimeExhaustion === undefined
                  ? {}
                  : { exhaustion: event.snapshot.runtimeExhaustion }),
              });
            }
            // Recheck the buffer and wait for any final frames on the open pipes.
            this.#frameSignal.wake("frame");
          } else if (event.type === "output-close") {
            if (
              this.#activeDeadline !== undefined &&
              (this.#activeJob === undefined ||
                !this.#activeTerminalResponseObserved)
            )
              this.#latchFailure({ kind: "incomplete-output" });
            this.#frameSignal.wake("failure");
          } else if (event.type === "output") {
            const failure = this.#observedFailure;
            if (failure?.kind !== "exit") return;
            const snapshot = this.#runtime.supervisor?.snapshot();
            const memoryLimitReached = snapshot?.memoryLimitReached === true;
            const reported = snapshot?.runtimeExhaustion;
            if (!memoryLimitReached && reported === undefined) return;
            this.#observedFailure = {
              ...failure,
              heapExhaustion: true,
              memoryLimitReached:
                failure.memoryLimitReached || memoryLimitReached,
              ...(reported === undefined ? {} : { exhaustion: reported }),
            };
          }
        },
      },
    });
    const owner = this;
    this.#cleanup = new AnalysisCleanupLease(() => this.#release(), {
      get cleanupResources() {
        return [
          ...owner.#files.cleanupResources,
          ...(owner.#runtime.cleanupResources ?? []),
        ];
      },
    });
  }

  static async retryPending(): Promise<void> {
    await processWebBundleCleanup.retry();
  }

  async analyze(
    script: IncludedScript,
    timeoutMs: number,
    signal?: AbortSignal,
    precision?: JavaScriptSemanticPrecisionInput,
    memberMutationAllowance: JavaScriptMemberMutationAllowance = DEFAULT_JAVASCRIPT_MEMBER_MUTATION_ALLOWANCE,
    endpointLiterals?: WebBundleEndpointLiteralAdmission,
  ): Promise<Result<WebBundleScriptAnalysis, WebBundleScriptAnalysisFailure>> {
    let deadline: ProviderStartupDeadline | undefined;
    const id = randomUUID();
    this.#observedFailure = undefined;
    this.#activeJob = undefined;
    this.#activeTerminalResponseObserved = false;
    let result: Result<WebBundleScriptAnalysis, AnalysisError>;
    let ownershipInspectionFailure: AnalysisError | undefined;
    let completed: WebBundleScriptAnalysis | null = null;
    let continuation: "result_capacity_exhausted" | undefined;
    let resultDescriptor: WebBundleResultDescriptor | undefined;
    let artifactFailure = false;
    const failed = (
      error: AnalysisError,
    ): Result<WebBundleScriptAnalysis, WebBundleScriptAnalysisFailure> =>
      err({
        error: signal?.aborted
          ? analysisErrorWithCancellation(error, cancelledBy(OPERATION, signal))
          : error,
        completed,
        ...(continuation === undefined ? {} : { continuation }),
      });
    try {
      if (signal?.aborted) throw cancelledBy(OPERATION, signal);
      const admitted = this.#admittedResultBudget();
      if (!admitted.ok) {
        continuation = "result_capacity_exhausted";
        throw admitted.error;
      }
      const resultBudget = admitted.bytes;
      try {
        await prepareProcessOwnershipInspection(signal);
      } catch (cause: unknown) {
        ownershipInspectionFailure = this.#inspectionFailure(cause);
        throw cause;
      }
      deadline = new ProviderStartupDeadline(timeoutMs, signal);
      this.#activeDeadline = deadline;
      try {
        await this.#start(deadline);
      } catch (cause: unknown) {
        if (
          processInspectionFailure(cause) !== undefined ||
          (this.#runtime.launchFailure !== undefined &&
            Object.is(this.#runtime.launchFailure.cause, cause))
        )
          ownershipInspectionFailure = this.#inspectionFailure(cause, deadline);
        throw cause;
      }
      if (this.#frames.length > 0 || this.#lines.pendingBytes !== 0)
        throw new AnalysisOutputError(
          OPERATION,
          "Web analyzer emitted unsolicited control data",
        );
      const root = this.#runtime.rootPath;
      const supervisor = this.#runtime.supervisor;
      if (root === undefined || supervisor === undefined)
        throw new TypeError("Web analyzer resources were not acquired");
      supervisor.resetOutput();
      const source = await this.#files
        .run(() =>
          this.#writeSource(
            join(root, `${id}.source`),
            script,
            deadline!.signal,
          ),
        )
        .catch((cause: unknown) => {
          artifactFailure = true;
          throw cause;
        });
      const request = webBundleWorkerRequestSchema.parse({
        kind: "analyze",
        ...(precision === undefined ? {} : { semantic_precision: precision }),
        member_mutation_allowance: javaScriptMemberMutationAllowanceField(
          memberMutationAllowance,
        ),
        ...(endpointLiterals === undefined
          ? {}
          : {
              endpoint_literal_candidates: {
                maximum_count: endpointLiterals.maximumCount,
                source: endpointLiterals.source,
              },
            }),
        id,
        source,
        result_budget_bytes: resultBudget,
      });
      const frame = `${JSON.stringify(request)}\n`;
      const stdin = supervisor.launch.process.stdin;
      if (stdin === null || stdin === undefined)
        throw new TypeError("Web analyzer request stream is unavailable");
      const job: WebBundleActiveJob = {
        id,
        resultBudgetBytes: resultBudget,
        memberMutationAllowance,
      };
      this.#activeJob = job;
      this.#activeTerminalResponseObserved = false;
      await new Promise<void>((resolve, reject) =>
        stdin.write(frame, (error) =>
          error == null ? resolve() : reject(error),
        ),
      );
      let response: WebBundleWorkerMessage;
      do {
        response = await this.#next(deadline);
        if (response.kind === "ready" || response.id !== id)
          throw new AnalysisOutputError(
            OPERATION,
            "Web analyzer response names another request",
          );
      } while (response.kind === "phase");
      if (response.kind === "failure") {
        if (response.reason === "resource")
          throw webBundleResourceFailure(response, job);
        throw new AnalysisOutputError(
          OPERATION,
          `Web script analysis failed (${response.reason}): ${response.message}`,
        );
      }
      if (response.kind !== "complete")
        throw new AnalysisOutputError(
          OPERATION,
          "Web analyzer did not complete a result",
        );
      const descriptor = response.result;
      resultDescriptor = descriptor;
      // Reserve expansion before reading bytes, decoding JSON or schema validation.
      if (
        descriptor.bytes > resultBudget ||
        descriptor.bytes * RESULT_EXPANSION + 64 * MIB >
          getHeapStatistics().heap_size_limit - process.memoryUsage().heapUsed
      )
        throw new AnalysisResourceConstraintError(
          OPERATION,
          "memory",
          "Completed script facts exceed the host's remaining reserved result capacity",
          { result_budget_bytes: resultBudget },
          { measuredExhaustion: true },
        );
      const stored = await this.#files
        .run(() =>
          readStableArtifact(
            join(root, `${id}.result`),
            descriptor.bytes,
            deadline!.signal,
            undefined,
            this.#files,
          ),
        )
        .catch((cause: unknown) => {
          artifactFailure = true;
          throw cause;
        });
      const facts = this.#validateCompletedResult(
        stored,
        descriptor,
        script,
        memberMutationAllowance,
      );
      // The descriptor was admitted against this remainder before the read.
      this.#retainedResult.charge(descriptor.bytes, () =>
        invariantViolation("Admitted web analysis result no longer fits"),
      );
      completed = facts;
      result = ok(facts);
    } catch (cause) {
      const completion = artifactFileCompletion(cause);
      const snapshot = completedStableArtifact(cause);
      if (snapshot !== undefined && resultDescriptor !== undefined) {
        try {
          const validated = this.#validateCompletedResult(
            snapshot,
            resultDescriptor,
            script,
            memberMutationAllowance,
          );
          // Retain the completed facts only when they fit what remains.
          if (this.#retainedResult.tryCharge(resultDescriptor.bytes))
            completed = validated;
        } catch {
          // The physical read completed, but only validated facts are retained.
        }
      }
      const artifactPrimary = artifactFailure
        ? artifactFilePrimaryFacts(cause)
        : undefined;
      const cancellationCause =
        completion?.cancellation ??
        (artifactPrimary?.origin === "owned-or-classified" &&
        artifactPrimary.cause instanceof ArtifactReaderFailure &&
        artifactPrimary.cause.reason === "cancelled"
          ? { reason: artifactFileCancellationCause(artifactPrimary.cause) }
          : undefined);
      // File outcomes own their cancellation facts. A later signal cannot
      // replace a rejected physical read/write that survived descriptor close.
      const interruptionApplies =
        !artifactFailure || cancellationCause !== undefined;
      const interrupted =
        interruptionApplies && deadline?.interruption === "timeout"
          ? scriptTimeout(timeoutMs, cause)
          : cancellationCause !== undefined
            ? cancelledBy(OPERATION, carriedReason(cancellationCause.reason))
            : interruptionApplies &&
                (deadline?.interruption === "cancelled" || signal?.aborted)
              ? cancelledBy(
                  OPERATION,
                  carriedReason(
                    signal?.aborted ? signal.reason : deadline?.signal.reason,
                  ),
                )
              : undefined;
      const observedFailure =
        this.#observedFailure === undefined
          ? ownershipInspectionFailure
          : this.#projectObservedFailure();
      if (observedFailure !== undefined && interrupted !== undefined) {
        if (interrupted instanceof AnalysisCancelledError)
          analysisErrorWithCancellation(observedFailure, interrupted);
        else observedFailure.retainSecondaryFailure(interrupted);
      }
      const primaryCause =
        artifactPrimary === undefined ? cause : artifactPrimary.cause;
      const primary =
        ownershipInspectionFailure !== undefined
          ? ownershipInspectionFailure
          : interrupted !== undefined && observedFailure !== undefined
            ? observedFailure
            : (interrupted ??
              (primaryCause instanceof RuntimeControlUnavailableError
                ? runtimeControlCapabilityError(
                    PROVIDER,
                    OPERATION,
                    primaryCause,
                  )
                : primaryCause instanceof AnalysisError
                  ? primaryCause
                  : new AnalysisOutputError(
                      OPERATION,
                      "Owned web-script analysis failed",
                      { cause: primaryCause },
                    )));
      const failure =
        cause instanceof ArtifactFileCleanupFailure
          ? this.#cleanupFailure(
              cause,
              completion === undefined ? primary : interrupted,
            )
          : primary;
      result = err(failure);
      try {
        const stopped = await this.#runtime.stop();
        if (stopped.status === "incomplete") throw new Error(stopped.reason);
        this.#reset();
      } catch (cleanupCause) {
        result = err(this.#cleanupFailure(cleanupCause, failure));
      }
    } finally {
      this.#activeDeadline = undefined;
      deadline?.dispose();
      this.#activeJob = undefined;
      this.#activeTerminalResponseObserved = false;
    }
    // Never remove job files while a failed descriptor or child remains owned.
    if (!result.ok && result.error.cleanupIncomplete)
      return failed(result.error);
    if (this.#files.hasPending)
      return failed(
        this.#cleanupFailure(
          new Error("Web analyzer artifact cleanup is incomplete"),
          result.ok ? undefined : result.error,
        ),
      );
    try {
      const root = this.#runtime.rootPath;
      if (root !== undefined) {
        await rm(join(root, `${id}.source`), { force: true });
        await rm(join(root, `${id}.result`), { force: true });
      }
    } catch (cause) {
      const previous = result.ok ? undefined : result.error;
      const primary = signal?.aborted
        ? analysisErrorWithCancellation(
            previous,
            cancelledBy(OPERATION, signal),
          )
        : previous;
      return failed(this.#cleanupFailure(cause, primary));
    }
    if (signal?.aborted)
      return failed(result.ok ? cancelledBy(OPERATION, signal) : result.error);
    return result.ok ? result : failed(result.error);
  }

  #admittedResultBudget():
    | { readonly ok: true; readonly bytes: number }
    | { readonly ok: false; readonly error: AnalysisResourceConstraintError } {
    const fixedRemaining = this.#retainedResult.remaining;
    const hostCapacity = Math.max(
      0,
      Math.floor(
        (getHeapStatistics().heap_size_limit -
          process.memoryUsage().heapUsed -
          64 * MIB) /
          RESULT_EXPANSION,
      ),
    );
    const bytes = Math.min(fixedRemaining, hostCapacity);
    if (bytes > 0) return { ok: true, bytes };
    const failure = webBundleResultAdmissionFailure({
      fixedBudgetBytes: WEB_BUNDLE_WORKER_LIMITS.resultBytes,
      fixedRemainingBytes: fixedRemaining,
      hostCapacityBytes: hostCapacity,
    });
    return {
      ok: false,
      error: new AnalysisResourceConstraintError(
        OPERATION,
        "memory",
        failure.reason,
        failure.reportedLimits,
        failure.kind === "host-capacity"
          ? { remediationAction: failure.remediationAction }
          : undefined,
      ),
    };
  }

  async #writeSource(
    path: string,
    script: IncludedScript,
    signal: AbortSignal,
  ): Promise<{ bytes: number; sha256: string }> {
    const digest = createHash("sha256");
    let bytes = 0;
    const file = await open(path, "wx", 0o600);
    await withArtifactFileHandle(
      path,
      file,
      this.#files,
      signal,
      async (handle) => {
        for (const part of bufferedJsonParts(jsonParts(script))) {
          assertArtifactReadActive(signal);
          const chunk = Buffer.from(part, "utf8");
          if (chunk.length > WEB_BUNDLE_WORKER_LIMITS.sourceBytes - bytes)
            throw new AnalysisResourceConstraintError(
              OPERATION,
              "transport",
              webBundleFixedByteBudget(
                WEB_BUNDLE_WORKER_LIMITS.sourceBytes,
                "worker transfer budget",
              ),
              { source_bytes: WEB_BUNDLE_WORKER_LIMITS.sourceBytes },
              fixedAllowanceOptions(
                "The web-bundle worker transfer allowance",
                "bytes",
                { limit: WEB_BUNDLE_WORKER_LIMITS.sourceBytes, unit: "bytes" },
              ),
            );
          await handle.writeFile(chunk);
          bytes += chunk.length;
          digest.update(chunk);
        }
      },
    );
    return { bytes, sha256: digest.digest("hex") };
  }

  #inspectionFailure(
    cause: unknown,
    deadline?: ProviderStartupDeadline,
  ): AnalysisError {
    const cancellation = processInspectionCancellationError(cause, OPERATION);
    const primary =
      cause instanceof AnalysisError
        ? cause
        : cancellation !== undefined
          ? deadline?.interruption === "timeout"
            ? scriptTimeout(deadline.timeoutMs, cause)
            : cancellation
          : cause instanceof RuntimeControlUnavailableError
            ? runtimeControlCapabilityError(PROVIDER, OPERATION, cause)
            : new AnalysisOutputError(
                OPERATION,
                "Process ownership inspection or worker startup failed",
                { cause },
              );
    return retainProcessInspectionCleanup(
      cause,
      primary,
      this.#files,
      OPERATION,
    );
  }

  async #start(deadline: ProviderStartupDeadline): Promise<void> {
    if (this.#ready && this.#runtime.supervisor !== undefined) return;
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      UV_THREADPOOL_SIZE: "1",
    };
    delete environment.NODE_OPTIONS;
    const memoryLimitBytes = javaScriptWorkerMemoryLimitBytes(this.heapMb);
    await this.#runtime.start(
      {
        command: process.execPath,
        arguments: [
          `--max-old-space-size=${String(this.heapMb)}`,
          "--max-semi-space-size=8",
          "--v8-pool-size=1",
          "--expose-gc",
          "--stack_size=2048",
          fileURLToPath(import.meta.resolve("#web-bundle-analysis-worker")),
        ],
        runId: `rea-web-bundle-analysis-${randomUUID()}`,
        hostEnvironment: environment,
        stdin: "pipe",
        signal: deadline.signal,
        ...(memoryLimitBytes === null ? {} : { memoryLimitBytes }),
      },
      async () => {
        this.#runtime.onStdout(this.#stdout);
        const ready = await this.#next(deadline);
        if (
          ready.kind !== "ready" ||
          (ready.heap_limit_bytes === null) ===
            (javaScriptRuntime(process.versions).id === "node")
        )
          throw new AnalysisOutputError(
            OPERATION,
            "Web analyzer ready frame has an incompatible runtime heap limit",
          );
        this.#ready = true;
      },
    );
  }

  async #next(
    deadline: ProviderStartupDeadline,
  ): Promise<WebBundleWorkerMessage> {
    for (;;) {
      if (deadline.interruption === "timeout")
        throw scriptTimeout(deadline.timeoutMs);
      if (deadline.interruption === "cancelled")
        throw cancelledBy(OPERATION, deadline.signal);
      const frame = this.#frames.shift();
      if (frame !== undefined) return frame;
      if (this.#runtime.inputFailure !== undefined)
        this.#latchFailure({
          kind: "input",
          cause: this.#runtime.inputFailure,
        });
      if (this.#protocolFailure !== undefined)
        this.#latchFailure({ kind: "protocol", cause: this.#protocolFailure });
      if (
        this.#observedFailure !== undefined &&
        this.#observedFailure.kind !== "exit"
      )
        throw this.#projectObservedFailure();
      const supervisor = this.#runtime.supervisor;
      const snapshot = supervisor?.snapshot();
      if (
        snapshot !== undefined &&
        (snapshot.exitCode !== undefined || snapshot.signal !== undefined)
      ) {
        if (supervisor === undefined) continue;
        const outcome = await this.#waitForFrameOrOutputClose(
          supervisor,
          deadline,
        );
        if (outcome === "interrupted") {
          const completedFrame = this.#frames.shift();
          if (completedFrame !== undefined) return completedFrame;
          throw deadline.interruption === "timeout"
            ? scriptTimeout(deadline.timeoutMs)
            : cancelledBy(OPERATION, deadline.signal);
        }
        const completedFrame = this.#frames.shift();
        if (completedFrame !== undefined) return completedFrame;
        if (outcome === "failure") throw this.#projectObservedFailure();
        if (outcome === "frame") continue;
        if (this.#observedFailure !== undefined)
          throw this.#projectObservedFailure();
        throw new AnalysisOutputError(
          OPERATION,
          "Owned web analyzer exited before completing this script",
          { capturedOutput: this.#capturedOutput() },
        );
      }
      await this.#frameSignal.wait(deadline.signal);
    }
  }

  #latchFailure(failure: WebBundleObservedFailure): void {
    if (
      this.#observedFailure === undefined &&
      this.#activeDeadline?.interruption === undefined
    )
      this.#observedFailure = failure;
  }

  #observeFrame(frame: WebBundleWorkerMessage): void {
    if (
      this.#activeDeadline?.interruption !== undefined ||
      this.#activeJob === undefined ||
      frame.kind === "ready" ||
      frame.id !== this.#activeJob.id
    )
      return;
    if (frame.kind === "complete" || frame.kind === "failure")
      this.#activeTerminalResponseObserved = true;
    if (frame.kind !== "failure") return;
    this.#latchFailure({
      kind: "frame",
      frame,
      job: this.#activeJob,
    });
  }

  #projectObservedFailure(): AnalysisError {
    const failure = this.#observedFailure;
    if (failure === undefined)
      return new AnalysisOutputError(
        OPERATION,
        "Owned web analyzer exited before completing this script",
        { capturedOutput: this.#capturedOutput() },
      );
    const capturedOutput = this.#capturedOutput();
    switch (failure.kind) {
      case "input":
        return new AnalysisOutputError(
          OPERATION,
          "Web analyzer request stream failed",
          { cause: failure.cause, capturedOutput },
        );
      case "protocol":
        return new AnalysisOutputError(
          OPERATION,
          "Invalid web analyzer control frame",
          { cause: failure.cause, capturedOutput },
        );
      case "incomplete-output":
        return new AnalysisOutputError(
          OPERATION,
          "Owned web analyzer output closed before completing this script",
          { capturedOutput },
        );
      case "frame":
        return failure.frame.reason === "resource"
          ? webBundleResourceFailure(failure.frame, failure.job, capturedOutput)
          : new AnalysisOutputError(
              OPERATION,
              `Web script analysis failed (${failure.frame.reason}): ${failure.frame.message}`,
              { capturedOutput },
            );
      case "exit":
        if (failure.heapExhaustion) {
          const exhaustion = webBundleMemoryExhaustion({
            runtime: javaScriptRuntime(process.versions).id,
            heapMb: this.heapMb,
            memoryLimitReached: failure.memoryLimitReached,
            processMemoryLimitBytes: javaScriptWorkerMemoryLimitBytes(
              this.heapMb,
            ),
          });
          return new AnalysisResourceConstraintError(
            OPERATION,
            "memory",
            webBundleHeapExhaustedReason(exhaustion),
            {
              worker_heap_limit_mb: this.heapMb,
              max_heap_mb: this.heapMb,
              worker_process_memory_limit_bytes:
                javaScriptWorkerMemoryLimitBytes(this.heapMb),
            },
            {
              capturedOutput,
              limit: webBundleHeapLimit(exhaustion),
              ...(failure.exhaustion === undefined
                ? {}
                : {
                    diagnostics: {
                      runtime_exhaustion_report: runtimeExhaustionReport(
                        failure.exhaustion,
                      ),
                    },
                  }),
              remediationAction: webBundleHeapExhaustedRemediation(exhaustion),
            },
          );
        }
        return new AnalysisOutputError(
          OPERATION,
          "Owned web analyzer exited before completing this script",
          { capturedOutput },
        );
    }
  }

  #capturedOutput() {
    const supervisor = this.#runtime.supervisor;
    const snapshot = supervisor?.snapshot();
    return {
      stdout: "",
      stderr: snapshot?.stderr.text ?? "",
      truncated:
        snapshot?.diagnosticTruncated === true ||
        snapshot?.outputIncomplete === true ||
        (supervisor !== undefined && !supervisor.observedOutputClose()),
      exit_code: snapshot?.exitCode ?? null,
      signal: snapshot?.signal ?? null,
    };
  }

  async #waitForFrameOrOutputClose(
    supervisor: NonNullable<OwnedWorkerRuntime["supervisor"]>,
    deadline: ProviderStartupDeadline,
  ): Promise<"frame" | "failure" | "closed" | "interrupted"> {
    if (this.#frames.length > 0) return "frame";
    return this.#frameSignal.waitForOutputClose(supervisor, deadline.signal);
  }

  #validateCompletedResult(
    stored: StableArtifactSnapshot,
    descriptor: WebBundleResultDescriptor,
    script: IncludedScript,
    memberMutationAllowance: JavaScriptMemberMutationAllowance,
  ): WebBundleScriptAnalysis {
    if (
      stored.bytes.length !== descriptor.bytes ||
      stored.sha256 !== descriptor.sha256
    )
      throw new AnalysisOutputError(
        OPERATION,
        "Web analyzer result differs from its descriptor",
      );
    const parsed = safeParseUtf8Json(stored.bytes);
    if (!parsed.ok) throw parsed.cause;
    const facts = webBundleScriptAnalysisSchema.parse(parsed.value);
    if (facts.script_key !== script.script_key)
      throw new AnalysisOutputError(
        OPERATION,
        "Web analyzer facts name another script",
      );
    if (facts.status === "analyzed") return facts;
    if (facts.partial === undefined)
      throw new AnalysisOutputError(
        OPERATION,
        "Web analyzer returned an unavailable result without partial facts",
      );
    // The refusal and its recovery come from the allowance this host sent.
    return {
      status: "unavailable",
      script_key: facts.script_key,
      reason: "resource_constraint",
      ...unavailableWebScriptRecovery(
        javaScriptMemberMutationRefusal(OPERATION, memberMutationAllowance),
      ),
      partial: facts.partial,
    };
  }

  #reset(): void {
    this.#ready = false;
    this.#frames = [];
    this.#lines.reset();
    this.#protocolFailure = undefined;
    this.#observedFailure = undefined;
    this.#activeDeadline = undefined;
    this.#activeJob = undefined;
    this.#activeTerminalResponseObserved = false;
    this.#frameSignal.wake("failure");
  }

  #cleanupFailure(cause: unknown, primary?: AnalysisError): AnalysisError {
    this.#runtime.retainForCleanup();
    const cleanup = new ProviderCleanupError(
      PROVIDER,
      this.#cleanup.cleanupResources ?? [],
      { reason: "Owned web analyzer cleanup remains incomplete" },
      { operation: OPERATION, cause },
    );
    new AnalysisCleanupLeaseGroup(cleanup, [this.#cleanup]);
    return primary === undefined
      ? cleanup
      : analysisErrorWithCleanupDependencies(primary, cleanup, OPERATION);
  }

  async close(): Promise<void> {
    try {
      await this.#cleanup.release();
    } catch (cause) {
      throw this.#cleanupFailure(cause);
    }
  }

  async #release(): Promise<void> {
    try {
      const stopped = await this.#runtime.stop();
      if (stopped.status === "incomplete") throw new Error(stopped.reason);
      await this.#files.close();
      await this.#runtime.close();
      this.#reset();
    } catch (cause) {
      this.#runtime.retainForCleanup();
      throw cause;
    }
  }
}

/** Web-analyzer workers and their runtimes retained by one host. */
export class WebBundleWorkerCleanup {
  readonly runtimes: WorkerCleanupRegistry;

  constructor(runtimes?: WorkerCleanupRegistry) {
    this.runtimes = runtimes ?? new WorkerCleanupRegistry();
  }

  async retry(): Promise<void> {
    await this.runtimes.retry();
  }
}

/** Workers constructed without a host. Their runtimes stay on the process registry. */
export const processWebBundleCleanup = new WebBundleWorkerCleanup(
  processWorkerCleanup,
);
