import { createHash, randomUUID } from "node:crypto";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { getHeapStatistics } from "node:v8";
import { z } from "zod";
import type { JavaScriptArtifactFile } from "../../domain/javascript/javascriptArtifactFiles.js";
import type { JavaScriptStaticAnalysis } from "../../domain/javascript/javascriptStaticAnalysisTypes.js";
import { estimateJavaScriptStaticApplicationProjection } from "../../domain/javascript/javascriptApplicationProjectionResources.js";
import type { JavaScriptModuleSemanticIr } from "../../domain/javascript/javascriptModuleSemanticIr.js";
import type { JavaScriptSemanticFileProjection } from "../../domain/javascript/javascriptSemanticFileProjection.js";
import type {
  JavaScriptAnalyzedSource,
  JavaScriptSourceAnalysisFailure,
  JavaScriptSourceAnalysisLimits,
} from "../../domain/javascript/javascriptSourceAnalysis.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisTimeoutError,
  AnalysisOutputError,
  AnalysisResourceConstraintError,
  AnalysisCapabilityUnavailableError,
} from "../../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import { ok, err, type Result } from "../../domain/result.js";
import { javaScriptRuntime } from "../../domain/runtimeVersion.js";
import { PrivateRuntimeRoot } from "../../process/PrivateRuntimeRoot.js";
import { PrivateRuntimeRootUnavailableError } from "../../process/PrivateRuntimeRootUnavailableError.js";
import { javaScriptWorkerMemoryLimitBytes } from "../../process/JavaScriptWorkerMemoryLimit.js";
import {
  ProviderProcessSupervisor,
  spawnOwnedProviderProcess,
} from "../../process/ProviderProcess.js";
import { cleanupOwnedProcessGroup } from "../../process/ProcessOwnership.js";
import { prepareProcessOwnershipInspection } from "../../process/ProcessOwnershipObservation.js";
import {
  ProviderStartupDeadline,
  waitForAbortableDelay,
} from "../../process/ProviderDeadline.js";
import {
  readJavaScriptAnalysisTransfer,
  JAVASCRIPT_ANALYSIS_TRANSFER_RECORD_BYTES,
  javaScriptTransferRetentionBytes,
} from "./JavaScriptAnalysisTransfer.js";
import { javaScriptWorkerStaticAnalysisSchema } from "./JavaScriptAnalysisWorkerSchemas.js";
import {
  JAVASCRIPT_ANALYSIS_WORKER_DEFAULTS as DEFAULTS,
  javaScriptWorkerMessageSchema,
  javaScriptWorkerRequestSchema,
  javaScriptWorkerAdmissionSchema,
  type JavaScriptWorkerMessage,
} from "./JavaScriptAnalysisWorkerProtocol.js";

const OPERATION = "analyze_javascript_application";
const PROVIDER = "javascript-static-analysis";
const MIB = 1024 * 1024;
const STATIC_CHECKPOINT_RETENTION_EXPANSION = 6;
const pendingCleanup = new Set<JavaScriptAnalysisWorker>();
/** The worker runs on this executable; Bun accepts but ignores V8 heap flags. */
const WORKER_HEAP_FLAGS_ENFORCED =
  javaScriptRuntime(process.versions).id === "node";

/** One sequential owned worker, retained between source files and closed after analysis. */
export class JavaScriptAnalysisWorker {
  readonly #runId = `rea-javascript-analysis-${randomUUID()}`;
  #root: PrivateRuntimeRoot | undefined;
  #supervisor: ProviderProcessSupervisor | undefined;
  #ready = false;
  #heapLimitBytes = 0;
  #frames: JavaScriptWorkerMessage[] = [];
  #pending = "";
  #decoder = new StringDecoder("utf8");
  #protocolFailure: string | undefined;
  #phase = "startup";
  #lastFailure: AnalysisError | undefined;
  #estimatedRetainedBytes = 0;
  #applicationProjectionFailure: AnalysisResourceConstraintError | undefined;
  #parentCapacityExhausted = false;
  #sourcesRemaining: number | undefined;
  readonly #resultBudgetBytes: number;
  /** Null when the runtime enforces the V8 heap flags instead. */
  readonly #processMemoryLimitBytes: number | null;
  readonly #onStdout = (chunk: Buffer | string): void => {
    try {
      this.#pending +=
        typeof chunk === "string" ? chunk : this.#decoder.write(chunk);
      let newline: number;
      while ((newline = this.#pending.indexOf("\n")) >= 0) {
        const line = this.#pending.slice(0, newline);
        this.#pending = this.#pending.slice(newline + 1);
        if (
          Buffer.byteLength(line) > DEFAULTS.protocolBytes ||
          this.#frames.length >= 16
        )
          throw new RangeError(
            "JavaScript worker exceeded its control-frame budget",
          );
        const raw: unknown = JSON.parse(line);
        this.#frames.push(javaScriptWorkerMessageSchema.parse(raw));
      }
      if (Buffer.byteLength(this.#pending) > DEFAULTS.protocolBytes)
        throw new RangeError(
          "JavaScript worker control frame is unterminated or oversized",
        );
    } catch (cause: unknown) {
      this.#protocolFailure = message(cause);
    }
  };

  constructor(
    readonly limits: JavaScriptSourceAnalysisLimits = DEFAULTS,
    readonly launcher: typeof spawnOwnedProviderProcess = spawnOwnedProviderProcess,
    sourceCount?: number,
  ) {
    if (
      !Number.isSafeInteger(limits.heapMb) ||
      limits.heapMb < 128 ||
      limits.heapMb > 16_384 ||
      !Number.isSafeInteger(limits.timeoutMs) ||
      limits.timeoutMs <= 0 ||
      limits.timeoutMs > 2_147_483_647
    )
      throw new RangeError(
        "JavaScript worker requires valid heap and execution limits",
      );
    if (
      sourceCount !== undefined &&
      (!Number.isSafeInteger(sourceCount) || sourceCount < 0)
    )
      throw new RangeError(
        "JavaScript worker source count must be a nonnegative safe integer",
      );
    this.#sourcesRemaining = sourceCount;
    this.#processMemoryLimitBytes = javaScriptWorkerMemoryLimitBytes(
      limits.heapMb,
    );
    // Reserve host-side control, schema/Evidence work and a maximum record's
    // transient copies. Admission also accounts for retained earlier files.
    this.#resultBudgetBytes = Math.max(
      0,
      Math.floor(
        (getHeapStatistics().heap_size_limit -
          process.memoryUsage().heapUsed -
          24 * JAVASCRIPT_ANALYSIS_TRANSFER_RECORD_BYTES) /
          2,
      ),
    );
  }

  /** Analyze inert source; hard worker failure does not terminate this process. */
  async analyze(
    file: JavaScriptArtifactFile,
    nodeBudget: number,
    signal?: AbortSignal,
  ): Promise<
    Result<JavaScriptAnalyzedSource, JavaScriptSourceAnalysisFailure>
  > {
    let javascript: JavaScriptStaticAnalysis | null = null;
    let module: JavaScriptModuleSemanticIr | null = null;
    let projection: JavaScriptSemanticFileProjection | null = null;
    const id = randomUUID();
    this.#applicationProjectionFailure = undefined;
    this.#parentCapacityExhausted = false;
    if (this.#sourcesRemaining !== undefined)
      this.#sourcesRemaining = Math.max(0, this.#sourcesRemaining - 1);
    let deadline: ProviderStartupDeadline | undefined;
    let result: Result<
      JavaScriptAnalyzedSource,
      JavaScriptSourceAnalysisFailure
    >;
    try {
      if (signal?.aborted === true) throw new AnalysisCancelledError(OPERATION);
      if (!file.text.included || file.kind !== "javascript")
        throw new TypeError(
          "JavaScript analysis worker requires included JavaScript text",
        );
      // Host ownership preparation is outside the parser execution deadline.
      await prepareProcessOwnershipInspection(signal);
      for (const owner of pendingCleanup) await owner.close();
      deadline = new ProviderStartupDeadline(this.limits.timeoutMs, signal);
      await this.#start(deadline);
      const root = this.#root;
      const supervisor = this.#supervisor;
      if (root === undefined || supervisor === undefined)
        throw new TypeError("JavaScript worker resources were not acquired");
      if (this.#frames.length !== 0 || this.#pending !== "")
        throw new AnalysisOutputError(
          OPERATION,
          "JavaScript worker has unsolicited or incomplete control frames",
        );
      supervisor.resetOutput();
      this.#phase = "source-transfer";
      await writeFile(join(root.path, `${id}.source`), file.text.value, {
        flag: "wx",
        mode: 0o600,
        signal: deadline.signal,
      });
      const { text: _text, ...metadata } = file;
      let offeredResultBudget = 0;
      const request = javaScriptWorkerRequestSchema.parse({
        id,
        node_budget: nodeBudget,
        text_sha256: createHash("sha256").update(file.text.value).digest("hex"),
        file: metadata,
      });
      const frame = `${JSON.stringify(request)}\n`;
      if (Buffer.byteLength(frame) > DEFAULTS.protocolBytes)
        throw new AnalysisResourceConstraintError(
          OPERATION,
          "transport",
          `Source identity for ${file.path} exceeds the worker request byte budget`,
          { worker_request_bytes: DEFAULTS.protocolBytes },
        );
      const stdin = supervisor.launch.process.stdin;
      if (stdin === undefined || stdin === null)
        throw new TypeError("JavaScript worker has no writable request stream");
      await new Promise<void>((resolve, reject) =>
        stdin.write(frame, (error) =>
          error === null || error === undefined ? resolve() : reject(error),
        ),
      );
      for (;;) {
        const response = await this.#next(deadline, file.path);
        if (response.kind === "ready" || response.id !== id)
          throw new AnalysisOutputError(
            OPERATION,
            "JavaScript worker response names a different source job",
          );
        if (response.kind === "phase") {
          this.#phase = response.phase;
          continue;
        }
        if (response.kind === "static") {
          if (javascript !== null)
            throw new AnalysisOutputError(
              OPERATION,
              "JavaScript worker emitted a duplicate static checkpoint",
            );
          javascript = await this.#readCheckpoint(id, file.path, response);
          if (this.#parentCapacityExhausted)
            throw new AnalysisResourceConstraintError(
              OPERATION,
              "memory",
              `The parent's result capacity was exhausted after retaining static facts for ${file.path}; remaining sources were not analyzed`,
              {
                ...this.#limits(),
                parent_result_budget_bytes: this.#resultBudgetBytes,
                parent_result_budget_exhausted: true,
              },
            );
          offeredResultBudget =
            this.#applicationProjectionFailure !== undefined &&
            this.#sourcesRemaining !== undefined &&
            this.#sourcesRemaining > 0
              ? 0
              : this.#remainingResultBudget();
          const admission = javaScriptWorkerAdmissionSchema.parse({
            id,
            semantic_result_budget_bytes: offeredResultBudget,
          });
          await new Promise<void>((resolve, reject) =>
            stdin.write(`${JSON.stringify(admission)}\n`, (error) =>
              error === null || error === undefined ? resolve() : reject(error),
            ),
          );
          continue;
        }
        if (response.kind === "failure") {
          if (response.reason === "resource") {
            result = err({
              javascript,
              module,
              projection,
              error: new AnalysisResourceConstraintError(
                OPERATION,
                response.resource ?? "memory",
                `${file.path}: ${response.message}`,
                { ...this.#limits(), ...response.limits },
              ),
            });
            break;
          }
          throw new AnalysisOutputError(
            OPERATION,
            `${file.path} during ${this.#phase}: ${response.message}`,
          );
        }
        if (javascript === null)
          throw new AnalysisOutputError(
            OPERATION,
            "JavaScript worker completed before a static checkpoint",
          );
        if (response.descriptor === null) {
          result = ok({ javascript, module: null, projection: null });
          break;
        }
        const descriptor = response.descriptor;
        // JSON bytes alone omit object/array overhead and the later graph/Evidence
        // sealing/serialization copies. Reserve a conservative expansion budget.
        const moduleEstimate = javaScriptTransferRetentionBytes(
          descriptor.module_bytes,
          descriptor.module_records,
        );
        const graphEstimate = javaScriptTransferRetentionBytes(
          descriptor.graph_bytes,
          descriptor.graph_records,
        );
        const remaining = Math.min(
          offeredResultBudget,
          this.#remainingResultBudget(),
        );
        if (moduleEstimate > remaining) {
          result = err({
            javascript,
            module: null,
            projection: null,
            error: new AnalysisResourceConstraintError(
              OPERATION,
              "memory",
              `Completed module facts for ${file.path} exceed the parent's remaining result budget; static facts were retained`,
              {
                ...this.#limits(),
                parent_result_budget_bytes: this.#resultBudgetBytes,
                parent_available_result_budget_bytes: remaining,
                module_transfer_bytes: descriptor.module_bytes,
                module_retention_estimate_bytes: moduleEstimate,
              },
              {
                remediationAction:
                  "Use the retained static facts or analyze fewer source files. This limit belongs to the parent result budget; increasing the worker heap alone does not increase it.",
              },
            ),
          });
          break;
        }
        const retainGraph = moduleEstimate + graphEstimate <= remaining;
        this.#phase = "result-admission";
        const decoded = await readJavaScriptAnalysisTransfer(
          join(root.path, `${id}.records`),
          descriptor,
          file,
          deadline.signal,
          retainGraph,
        );
        module = decoded.module;
        projection = decoded.projection;
        this.#estimatedRetainedBytes +=
          moduleEstimate + (retainGraph ? graphEstimate : 0);
        result = retainGraph
          ? ok({ javascript, module, projection: decoded.projection })
          : err({
              javascript,
              module,
              projection,
              error: new AnalysisResourceConstraintError(
                OPERATION,
                "memory",
                `Semantic graph for ${file.path} exceeds the parent's remaining result budget; static and module facts were retained`,
                {
                  ...this.#limits(),
                  parent_result_budget_bytes: this.#resultBudgetBytes,
                  parent_available_result_budget_bytes: remaining,
                  module_retention_estimate_bytes: moduleEstimate,
                  graph_retention_estimate_bytes: graphEstimate,
                  graph_transfer_bytes: descriptor.graph_bytes,
                  graph_records: descriptor.graph_records,
                },
                {
                  remediationAction:
                    "Use the retained static and module facts or analyze fewer source files. This limit belongs to the parent result budget; increasing the worker heap alone does not increase it.",
                },
              ),
            });
        break;
      }
      // An allocation failure may surface as a protocol failure or be caught
      // inside the worker; any reached limit makes this file's result partial.
      if (this.#memoryLimitReached()) throw this.#memoryFailure(file.path);
    } catch (cause: unknown) {
      const error = this.#failure(cause, file.path, deadline, signal);
      this.#lastFailure = error;
      // Complete checkpoints remain readable after a child crash or cancellation.
      const cleanup = await this.#stop(error);
      if (
        cleanup === undefined &&
        javascript === null &&
        this.#root !== undefined
      ) {
        try {
          javascript = await this.#readCheckpoint(id, file.path);
        } catch (checkpointCause: unknown) {
          void checkpointCause;
        }
      }
      result = err({ error: cleanup ?? error, javascript, module, projection });
    } finally {
      deadline?.dispose();
    }
    if (result.ok) this.#lastFailure = undefined;
    else if (!(result.error.error instanceof ProviderCleanupError))
      this.#lastFailure = result.error.error;
    // Child stop must be verified before temporary files are released. On
    // cleanup uncertainty, close retains this owner for a later retry.
    if (this.#root !== undefined && !pendingCleanup.has(this)) {
      try {
        for (const suffix of ["source", "static.json", "records"])
          await rm(join(this.#root.path, `${id}.${suffix}`), { force: true });
      } catch (cause: unknown) {
        pendingCleanup.add(this);
        return err({
          javascript,
          module,
          projection,
          error: this.#cleanupError(message(cause)),
        });
      }
    }
    if (this.#applicationProjectionFailure !== undefined)
      return result.ok
        ? ok({
            ...result.value,
            applicationProjectionFailure: this.#applicationProjectionFailure,
          })
        : err({
            ...result.error,
            applicationProjectionFailure: this.#applicationProjectionFailure,
          });
    return result;
  }

  /** Verify process cleanup, then release the private runtime; failed close is retryable. */
  async close(): Promise<void> {
    const failure = await this.#stop();
    if (failure !== undefined) throw failure;
    if (this.#root !== undefined) {
      try {
        await this.#root.close();
        this.#root = undefined;
      } catch (cause: unknown) {
        pendingCleanup.add(this);
        throw this.#cleanupError(message(cause));
      }
    }
    pendingCleanup.delete(this);
  }

  async #start(deadline: ProviderStartupDeadline): Promise<void> {
    if (this.#supervisor !== undefined && this.#ready) return;
    this.#phase = "startup";
    this.#heapLimitBytes = 0;
    this.#root ??= await PrivateRuntimeRoot.create({
      prefix: "rea-javascript-analysis-",
    });
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      UV_THREADPOOL_SIZE: "1",
    };
    delete environment.NODE_OPTIONS;
    const spawned = await this.launcher({
      command: process.execPath,
      arguments: [
        `--max-old-space-size=${String(this.limits.heapMb)}`,
        "--max-semi-space-size=8",
        "--v8-pool-size=1",
        "--expose-gc",
        "--stack_size=2048",
        fileURLToPath(import.meta.resolve("#javascript-analysis-worker")),
      ],
      runId: `${this.#runId}-${randomUUID()}`,
      cwd: this.#root.path,
      hostEnvironment: environment,
      stdin: "pipe",
      ...(this.#processMemoryLimitBytes === null
        ? {}
        : { memoryLimitBytes: this.#processMemoryLimitBytes }),
      signal: deadline.signal,
    });
    this.#supervisor = new ProviderProcessSupervisor(
      {
        ...spawned,
        ownsProcessLifetime: true,
        cleanup:
          spawned.cleanup ??
          (() => cleanupOwnedProcessGroup(spawned.ownership)),
      },
      { captureStdout: false, maxDiagnosticBytes: 256 * 1024 },
    );
    spawned.process.stdout?.on("data", this.#onStdout);
    const ready = await this.#next(deadline, "worker startup");
    if (ready.kind !== "ready")
      throw new AnalysisOutputError(
        OPERATION,
        "JavaScript worker emitted facts before its startup handshake",
      );
    if ((ready.heap_limit_bytes === null) === WORKER_HEAP_FLAGS_ENFORCED)
      throw new AnalysisOutputError(
        OPERATION,
        "JavaScript worker heap limit does not match the runtime that launched it",
      );
    this.#heapLimitBytes = ready.heap_limit_bytes ?? 0;
    this.#ready = true;
  }

  async #next(
    deadline: ProviderStartupDeadline,
    path: string,
  ): Promise<JavaScriptWorkerMessage> {
    for (;;) {
      if (deadline.interruption === "cancelled")
        throw new AnalysisCancelledError(OPERATION);
      if (deadline.interruption === "timeout")
        throw new AnalysisTimeoutError(OPERATION, this.limits.timeoutMs);
      if (this.#protocolFailure !== undefined)
        throw new AnalysisOutputError(OPERATION, this.#protocolFailure);
      const frame = this.#frames.shift();
      if (frame !== undefined) return frame;
      const snapshot = this.#supervisor?.snapshot();
      if (
        snapshot !== undefined &&
        (snapshot.exitCode !== undefined || snapshot.signal !== undefined)
      ) {
        // Exit is not complete output: let any final control frame drain first.
        if (!(await this.#supervisor?.waitForOutputClose(10))) continue;
        if (this.#frames.length !== 0) continue;
        const drained = this.#supervisor?.snapshot() ?? snapshot;
        throw this.#memoryLimitReached()
          ? this.#memoryFailure(path)
          : /heap out of memory|heap limit|allocation failed/iu.test(
                drained.stderr.text,
              )
            ? new AnalysisResourceConstraintError(
                OPERATION,
                "memory",
                `Owned JavaScript worker exhausted its heap while analyzing ${path} during ${this.#phase}`,
                this.#limits(),
                { capturedOutput: this.#captured() },
              )
            : new ProviderAdapterError(PROVIDER, OPERATION, {
                capturedOutput: this.#captured(),
                diagnostics: {
                  source_path: path,
                  phase: this.#phase,
                  exit_code: drained.exitCode ?? null,
                  signal: drained.signal ?? null,
                },
              });
      }
      await waitForAbortableDelay(10, deadline.signal);
    }
  }

  async #readCheckpoint(
    id: string,
    sourcePath: string,
    expected?: { readonly bytes: number; readonly sha256: string },
  ): Promise<JavaScriptStaticAnalysis> {
    if (this.#root === undefined)
      throw new TypeError("JavaScript checkpoint has no owned runtime");
    const path = join(this.#root.path, `${id}.static.json`);
    const bytes = (await stat(path)).size;
    if (
      bytes > DEFAULTS.checkpointBytes ||
      (expected !== undefined && expected.bytes !== bytes)
    )
      throw new AnalysisOutputError(
        OPERATION,
        "JavaScript static checkpoint byte count exceeds or differs from its declared budget",
      );
    if (
      bytes * 16 + 4 * MIB >
      getHeapStatistics().heap_size_limit -
        process.memoryUsage().heapUsed -
        64 * MIB
    )
      throw new AnalysisResourceConstraintError(
        OPERATION,
        "memory",
        "The parent's remaining heap cannot safely decode the completed JavaScript static checkpoint",
        { ...this.#limits(), checkpoint_bytes: bytes },
      );
    const text = await readFile(path, "utf8");
    if (
      expected !== undefined &&
      createHash("sha256").update(text).digest("hex") !== expected.sha256
    )
      throw new AnalysisOutputError(
        OPERATION,
        "JavaScript static checkpoint digest does not match",
      );
    const value: unknown = JSON.parse(text);
    const facts = javaScriptWorkerStaticAnalysisSchema.parse(value);
    const remaining = this.#remainingTotalResultBudget();
    const retainedBytes = bytes * STATIC_CHECKPOINT_RETENTION_EXPANSION;
    this.#parentCapacityExhausted = retainedBytes > remaining;
    this.#estimatedRetainedBytes += retainedBytes;
    const expandedBytes = estimateJavaScriptStaticApplicationProjection(
      facts,
      bytes,
      sourcePath,
    );
    const availableResultBudget = this.#remainingResultBudget();
    if (expandedBytes <= availableResultBudget)
      this.#estimatedRetainedBytes += expandedBytes;
    else
      this.#applicationProjectionFailure = new AnalysisResourceConstraintError(
        OPERATION,
        "memory",
        `Expanded application relationships for ${sourcePath} exceed the parent's result budget; complete static facts were retained on the file node`,
        {
          parent_result_budget_bytes: this.#resultBudgetBytes,
          parent_available_result_budget_bytes: availableResultBudget,
          application_projection_required_bytes: expandedBytes,
        },
        {
          remediationAction:
            "Read the complete static facts on the file node or analyze fewer source files. Expanded application relationships exceed the parent result budget; increasing the worker heap alone does not increase it.",
        },
      );
    return facts;
  }

  #limits() {
    return {
      ...(WORKER_HEAP_FLAGS_ENFORCED
        ? {
            worker_old_space_mb: this.limits.heapMb,
            ...(this.#heapLimitBytes === 0
              ? {}
              : { worker_heap_limit_bytes: this.#heapLimitBytes }),
          }
        : // Bun enforces no worker heap limit; report it as unavailable.
          { worker_heap_limit_bytes: null }),
      ...(this.#processMemoryLimitBytes === null
        ? {}
        : {
            worker_process_memory_limit_bytes: this.#processMemoryLimitBytes,
          }),
      worker_timeout_ms: this.limits.timeoutMs,
    };
  }
  #memoryLimitReached(): boolean {
    return this.#supervisor?.launch.process.memoryLimitReached === true;
  }
  #memoryFailure(path: string): AnalysisResourceConstraintError {
    return new AnalysisResourceConstraintError(
      OPERATION,
      "memory",
      `Owned JavaScript worker reached its ${this.#processMemoryLimitBytes === null ? "" : `${String(this.#processMemoryLimitBytes)}-byte `}process memory limit while analyzing ${path} during ${this.#phase}`,
      this.#limits(),
      { capturedOutput: this.#captured() },
    );
  }
  #remainingResultBudget(): number {
    // One sequential worker produces one next checkpoint at a time. Reserve
    // its maximum protocol size at the same retained expansion used on receipt;
    // earlier checkpoints are already charged to estimatedRetainedBytes.
    // Reserving every unexamined source's maximum would reject useful results
    // merely because many small files remain. Actual retained growth and live
    // heap capacity are checked again for every checkpoint and transfer.
    const checkpointReserve =
      DEFAULTS.checkpointBytes * STATIC_CHECKPOINT_RETENTION_EXPANSION;
    const staticReserve =
      this.#sourcesRemaining !== undefined && this.#sourcesRemaining > 0
        ? checkpointReserve
        : 0;
    return Math.max(0, this.#remainingTotalResultBudget() - staticReserve);
  }
  #remainingTotalResultBudget(): number {
    return Math.max(
      0,
      Math.min(
        this.#resultBudgetBytes - this.#estimatedRetainedBytes,
        getHeapStatistics().heap_size_limit -
          process.memoryUsage().heapUsed -
          24 * JAVASCRIPT_ANALYSIS_TRANSFER_RECORD_BYTES,
      ),
    );
  }
  #captured() {
    const snapshot = this.#supervisor?.snapshot();
    return {
      stdout: "",
      stderr: snapshot?.stderr.text ?? "",
      truncated: snapshot?.diagnosticTruncated ?? false,
      stderr_bytes: snapshot?.stderr.observedBytes ?? 0,
      exit_code: snapshot?.exitCode ?? null,
      signal: snapshot?.signal ?? null,
    };
  }
  #failure(
    cause: unknown,
    path: string,
    deadline: ProviderStartupDeadline | undefined,
    signal: AbortSignal | undefined,
  ): AnalysisError {
    // Ownership preparation is abortable before the worker deadline exists.
    if (
      deadline?.interruption === "cancelled" ||
      (deadline === undefined &&
        signal?.aborted === true &&
        !(cause instanceof ProviderCleanupError))
    )
      return new AnalysisCancelledError(OPERATION, {
        capturedOutput: this.#captured(),
      });
    if (deadline?.interruption === "timeout")
      return new AnalysisTimeoutError(OPERATION, this.limits.timeoutMs, {
        capturedOutput: this.#captured(),
      });
    // A reached process limit explains the worker's exit, broken pipe or
    // truncated frame better than the symptom it produced.
    if (
      this.#memoryLimitReached() &&
      !(cause instanceof AnalysisResourceConstraintError)
    )
      return this.#memoryFailure(path);
    if (cause instanceof AnalysisError) return cause;
    if (
      cause instanceof z.ZodError ||
      cause instanceof TypeError ||
      cause instanceof SyntaxError
    )
      return new AnalysisOutputError(
        OPERATION,
        `${path} during ${this.#phase}: ${message(cause)}`,
        { cause, capturedOutput: this.#captured() },
      );
    return cause instanceof PrivateRuntimeRootUnavailableError
      ? new AnalysisCapabilityUnavailableError(
          PROVIDER,
          OPERATION,
          cause.message,
          { cause, retryable: cause.retryable },
        )
      : new ProviderAdapterError(PROVIDER, OPERATION, {
          cause,
          capturedOutput: this.#captured(),
          diagnostics: {
            source_path: path,
            phase: this.#phase,
            message: message(cause),
          },
        });
  }
  #cleanupError(
    reason: string,
    original: AnalysisError | undefined = this.#lastFailure,
  ): ProviderCleanupError {
    return new ProviderCleanupError(
      PROVIDER,
      [this.#runId, ...(this.#root === undefined ? [] : [this.#root.path])],
      {
        reason,
        worker_pid: this.#supervisor?.launch.process.pid ?? null,
        ...(original === undefined
          ? {}
          : {
              execution_failure: {
                tag: original._tag,
                message: original.message,
                captured_output: {
                  stdout: original.capturedOutput?.stdout ?? "",
                  stderr: original.capturedOutput?.stderr ?? "",
                  truncated: original.capturedOutput?.truncated ?? false,
                },
              },
            }),
      },
      {
        operation: OPERATION,
        cause: new Error(
          reason,
          original === undefined ? undefined : { cause: original },
        ),
      },
    );
  }
  async #stop(
    original: AnalysisError | undefined = this.#lastFailure,
  ): Promise<ProviderCleanupError | undefined> {
    if (this.#supervisor !== undefined) {
      const supervisor = this.#supervisor;
      const stopped = await supervisor.stop();
      if (stopped.status === "incomplete") {
        pendingCleanup.add(this);
        return this.#cleanupError(stopped.reason, original);
      }
      supervisor.launch.process.stdout?.off("data", this.#onStdout);
      supervisor.dispose();
      this.#supervisor = undefined;
    }
    this.#ready = false;
    this.#frames = [];
    this.#pending = "";
    this.#decoder = new StringDecoder("utf8");
    this.#protocolFailure = undefined;
    return undefined;
  }
}

const message = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);
