import { capturedProviderOutput } from "./capturedProviderOutput.js";
import {
  AnalysisCleanupLease,
  AnalysisCleanupLeaseGroup,
  ArtifactReaderFailure,
  type CleanupFailedRead,
  ArtifactResourceScope,
  readStableArtifact,
  streamStableArtifact,
} from "../resources/index.js";
import {
  AnalysisError,
  type AnalysisCapturedOutput,
  type AnalysisErrorOptions,
} from "../domain/analysisErrorBase.js";
import {
  AnalysisArtifactChangedError,
  AnalysisResourceConstraintError,
  AnalysisOutputError,
  cancelledBy,
  carriedReason,
} from "../domain/analysisErrorCore.js";
import {
  analysisErrorWithCleanupDependencies,
  providerCleanupErrorFromFailures,
} from "../domain/analysisErrorCleanup.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { err, type Result } from "../domain/result.js";
import {
  readLinuxResourceLimits,
  type LinuxResourceLimits,
} from "./LinuxResourceLimits.js";
import type { PrivateRuntimeRoot } from "./PrivateRuntimeRoot.js";
import type { ProviderProcessSupervisor } from "./ProviderProcess.js";
import { OwnedCommandFailure, ownedCommandResources } from "./OwnedCommand.js";
import type { ProviderOutcomeContext } from "./classifyProviderOutcome.js";
import {
  deadlineParameterLimit,
  MAX_NODE_TIMER_DELAY_MS,
} from "../domain/analysisResourceLimits.js";
import type {
  AnalysisLimit,
  AnalysisParameterLimit,
} from "../domain/analysisSettings.js";

/** Limitations shared by resource-limited artifact producer observations. */
export const ARTIFACT_PRODUCER_LIMITATION =
  "Linux prlimit enforces the reported per-process address-space, per-file and CPU limits before execution with no core dumps, preserving tighter inherited soft and hard limits. Input, command deadline and retained output budgets are reported in limits; producer_limits can change their requested defaults on the next call without restart. Output overflow fails. Parser and transport bounds remain independent. These are per-process/per-file limits, not aggregate memory or filesystem quotas; caller-supplied tools and the limiter are trusted.";

export type ArtifactAnalysisRuntime = Pick<
  PrivateRuntimeRoot,
  "path" | "close"
>;

/** A selected input one resource-owned read admits. */
export interface SelectedArtifactRead {
  readonly path: string;
  /** The per-call input budget; its effective value is the largest admitted read. */
  readonly budget: AnalysisParameterLimit;
  readonly observedOutput: AnalysisCapturedOutput | undefined;
  readonly signal?: AbortSignal | undefined;
}

/** The selected and omitted values of an owned producer command's per-call budgets. */
export interface ProducerCommandLimits {
  readonly selected: {
    readonly command_timeout_ms: number;
    readonly output_bytes: number;
  };
  readonly defaults: { readonly command_timeout_ms: number };
  /** The control that raises the output budget: a parameter, or a setting backing it. */
  readonly output: AnalysisLimit;
}

/** What a resource-owned read was doing when it failed. */
export type ArtifactResourceFailureContext =
  | {
      readonly kind: "selected-input";
      readonly operation: string;
      readonly input: SelectedArtifactRead;
    }
  | {
      readonly kind: "integrity";
      readonly operation: string;
      readonly path: string;
      readonly capturedOutput: AnalysisCapturedOutput | undefined;
    }
  | { readonly kind: "resources"; readonly operation: string };

/**
 * Classifies a raw failure these resources observed. The provider layer owns
 * raw-failure classification, so the consumer supplies it; the resources
 * supply the typed pieces (`selectedFileSize`, `integrityChanged`,
 * `readCleanupFailure`) its dialect is built from.
 */
export type ArtifactResourceClassifier = (
  cause: unknown,
  context: ArtifactResourceFailureContext,
) => AnalysisError;

/** Own admission, artifact descriptors, producer cleanup and private workspaces together. */
export class ArtifactAnalysisResources {
  readonly #artifacts: {
    readonly scope: ArtifactResourceScope;
    operation: string;
  };
  readonly #pending = new Map<
    ArtifactAnalysisRuntime,
    {
      readonly owner: ProviderProcessSupervisor | undefined;
      readonly operation: string;
      readonly lease: AnalysisCleanupLease;
    }
  >();
  #tail: Promise<void> = Promise.resolve();
  #busy = false;
  #closed = false;

  constructor(
    readonly providerId: string,
    readonly operation: string,
    readonly readArtifact: typeof readStableArtifact,
    readonly readKernelLimits: typeof readLinuxResourceLimits,
    readonly capacity: {
      readonly message: string;
      readonly details: Readonly<Record<string, JsonValue>>;
    },
    readonly classify: ArtifactResourceClassifier,
  ) {
    this.#artifacts = { scope: new ArtifactResourceScope(), operation };
  }

  run<T>(
    work: () => Promise<Result<T, AnalysisError>>,
    signal?: AbortSignal,
    operation = this.operation,
  ): Promise<Result<T, AnalysisError>> {
    if (this.#closed || signal?.aborted)
      return Promise.resolve(
        err(
          cancelledBy(
            operation,
            carriedReason(signal?.aborted ? signal.reason : undefined),
          ),
        ),
      );
    if (this.#busy)
      return Promise.resolve(
        err(
          new AnalysisResourceConstraintError(
            operation,
            "capacity",
            this.capacity.message,
            this.capacity.details,
            { measuredExhaustion: true },
          ),
        ),
      );
    this.#busy = true;
    const running = this.#tail
      .then(() =>
        this.#artifacts.scope.run(() => {
          // Failed descriptor cleanup still belongs to the preceding request until
          // this scope has drained it and admits acquisition for the new request.
          this.#artifacts.operation = operation;
          if (signal?.aborted)
            return Promise.resolve(err(cancelledBy(operation, signal)));
          return work();
        }),
      )
      .catch((cause: unknown) =>
        err(
          this.classify(cause, {
            kind: "resources",
            operation: this.#artifacts.operation,
          }),
        ),
      )
      .finally(() => {
        this.#busy = false;
      });
    this.#tail = running.then(
      () => undefined,
      () => undefined,
    );
    return running;
  }

  read(path: string, maximumBytes: number, signal?: AbortSignal) {
    return this.readArtifact(
      path,
      maximumBytes,
      signal,
      undefined,
      this.#artifacts.scope,
    );
  }

  /** Stream-hash a bounded regular file without buffering its full bytes in heap. */
  async hash(
    path: string,
    maximumBytes: number,
    signal?: AbortSignal,
  ): Promise<{ readonly bytes: number; readonly sha256: string }> {
    if (this.readArtifact === readStableArtifact) {
      const streamed = await streamStableArtifact(path, maximumBytes, {
        retainBytes: () => 0,
        onChunk: () => undefined,
        signal,
        resourceScope: this.#artifacts.scope,
      });
      return { bytes: streamed.size, sha256: streamed.sha256 };
    }
    const snapshot = await this.read(path, maximumBytes, signal);
    return { bytes: snapshot.bytes.byteLength, sha256: snapshot.sha256 };
  }

  /** Admit a selected input and classify its physical failure before later stages. */
  async readSelectedArtifact(input: SelectedArtifactRead) {
    const operation = this.#artifacts.operation;
    try {
      return await this.read(
        input.path,
        input.budget.effective_value,
        input.signal,
      );
    } catch (cause: unknown) {
      throw this.classify(cause, { kind: "selected-input", operation, input });
    }
  }

  /** The read budget and recovery for a selected input larger than it admits. */
  selectedFileSize(input: SelectedArtifactRead, operation: string) {
    const { budget } = input;
    return (cause: ArtifactReaderFailure, details: AnalysisErrorOptions) =>
      new AnalysisResourceConstraintError(
        operation,
        "file-size",
        cause.message,
        { input_bytes: budget.effective_value },
        {
          ...details,
          cause,
          limit:
            cause.observedBytes === undefined ||
            cause.observedBytes > BigInt(Number.MAX_SAFE_INTEGER)
              ? budget
              : { ...budget, required_value: Number(cause.observedBytes) },
          retryable: false,
        },
      );
  }

  readLimits(limits: LinuxResourceLimits): Promise<LinuxResourceLimits> {
    return this.readKernelLimits(limits, this.#artifacts.scope);
  }

  /** Finish bounded identity reads after output, independently of caller cancellation. */
  async readCommandAfterRun(
    command: string,
    limiter: { readonly path: string; readonly sha256: string },
    capturedOutput: AnalysisCapturedOutput,
    operation = this.operation,
  ) {
    const read = async (path: string) => {
      try {
        return await this.hash(path, 64 * 1024 * 1024);
      } catch (cause: unknown) {
        throw this.classify(cause, {
          kind: "integrity",
          operation,
          path,
          capturedOutput,
        });
      }
    };
    const current = await read(command);
    const currentLimiter = await read(limiter.path);
    if (currentLimiter.sha256 !== limiter.sha256)
      throw new AnalysisArtifactChangedError(
        operation,
        limiter.path,
        "Configured resource limiter changed during analysis.",
        { capturedOutput },
      );
    return current;
  }

  /** A post-run identity read whose failure shows the file changed. */
  integrityChanged(
    cause: ArtifactReaderFailure,
    path: string,
    details: AnalysisErrorOptions,
    operation: string,
  ): AnalysisArtifactChangedError | undefined {
    return ["limit", "integrity", "path"].includes(cause.reason)
      ? new AnalysisArtifactChangedError(
          operation,
          path,
          `Post-run identity verification failed for ${path}: ${cause.message}`,
          details,
        )
      : undefined;
  }

  retain(
    root: ArtifactAnalysisRuntime,
    owner?: ProviderProcessSupervisor,
  ): void {
    const retained = this.#pending.get(root);
    const resources = () => this.#resourcesFor(root);
    this.#pending.set(root, {
      owner: owner ?? retained?.owner,
      operation: retained?.operation ?? this.#artifacts.operation,
      lease:
        retained?.lease ??
        new AnalysisCleanupLease(() => this.#releaseRoot(root), {
          get cleanupResources() {
            return resources();
          },
        }),
    });
  }

  /** Keep a failed command's cleanup owner with the workspace that acquired it. */
  retainCommandCleanup(
    root: ArtifactAnalysisRuntime | undefined,
    cause: unknown,
  ): void {
    if (
      root !== undefined &&
      cause instanceof OwnedCommandFailure &&
      cause.cleanupOwner !== undefined
    )
      this.retain(root, cause.cleanupOwner);
  }

  get pendingPaths(): readonly string[] {
    return [...this.#pending.keys()].map((root) => root.path);
  }

  #resourcesFor(root: ArtifactAnalysisRuntime): readonly string[] {
    const retained = this.#pending.get(root);
    if (retained === undefined) return [];
    const ownership = retained.owner?.launch.ownership;
    return ownership === undefined
      ? [root.path]
      : ownedCommandResources(ownership, root.path);
  }

  async release(): Promise<void> {
    const failures: ProviderCleanupError[] = [];
    for (const [root, retained] of this.#pending) {
      try {
        await retained.lease.release();
      } catch (cause: unknown) {
        const diagnostics =
          cause instanceof ProviderCleanupError ? cause.diagnostics : undefined;
        const failure = new ProviderCleanupError(
          this.providerId,
          this.#resourcesFor(root),
          {
            ...diagnostics,
            reason:
              cause instanceof ProviderCleanupError
                ? String(diagnostics?.reason ?? cause.message)
                : String(cause),
          },
          { operation: retained.operation, cause },
        );
        new AnalysisCleanupLeaseGroup(failure, [retained.lease]);
        failures.push(failure);
      }
    }
    if (failures.length === 0) return;
    if (failures.length === 1) throw failures[0];
    throw providerCleanupErrorFromFailures(
      this.providerId,
      failures,
      {
        reason: "One or more analysis runtime resources remain owned.",
        failures: failures.map((failure) => projectAnalysisError(failure)),
      },
      {
        operation: failures[0]?.operation ?? this.#artifacts.operation,
        message: "Analysis runtime cleanup remains incomplete",
      },
    );
  }

  async #releaseRoot(root: ArtifactAnalysisRuntime): Promise<void> {
    const retained = this.#pending.get(root);
    if (retained === undefined) return;
    if (retained.owner !== undefined) {
      const stopped = await retained.owner.stop();
      if (stopped.status === "incomplete") {
        const cleanup = stopped.cleanupResult;
        throw new ProviderCleanupError(
          this.providerId,
          this.#resourcesFor(root),
          {
            reason: stopped.reason,
            ...(cleanup?.failures === undefined
              ? {}
              : {
                  failures: cleanup.failures.map((failure) => ({ ...failure })),
                }),
            ...(cleanup?.unverified === undefined
              ? {}
              : {
                  unverified: cleanup.unverified.map((process) => ({
                    ...process,
                  })),
                }),
          },
          { operation: retained.operation },
        );
      }
      this.#pending.set(root, { ...retained, owner: undefined });
    }
    if (this.#artifacts.scope.hasPending)
      throw new ProviderCleanupError(
        this.providerId,
        [root.path],
        {
          reason:
            "Artifact resources remain owned; the private runtime root is retained until their cleanup succeeds.",
        },
        { operation: retained.operation },
      );
    await root.close();
    this.#pending.delete(root);
  }

  /**
   * This provider's report for a read whose own cleanup failed: its cleanup
   * error, bound to the read's descriptor leases (or to a retained unresolved
   * lease), composed with what the read reports apart from that cleanup.
   */
  readCleanupFailure(
    cause: CleanupFailedRead,
    primary: AnalysisError | undefined,
    capturedOutput?: AnalysisCapturedOutput,
    operation = this.operation,
  ): AnalysisError {
    const observation = cause.cleanup;
    const failure = new ProviderCleanupError(
      this.providerId,
      observation.resources,
      {
        reason: observation.reason,
        ...(capturedOutput === undefined
          ? {}
          : { captured_output: { ...capturedOutput } }),
      },
      { operation, cause },
    );
    let leases = cause.cleanupLeases;
    if (leases === undefined) {
      // An unreported capability cannot be recovered by observing an empty scope.
      // Retain the unresolved source failure and refuse replacement admission.
      const unresolved = new AnalysisCleanupLease(async () => {
        throw cause;
      }, observation.resources);
      this.#artifacts.scope.retain({
        kind: "lease",
        resource: observation.resources[0] ?? "Unresolved artifact cleanup",
        lease: unresolved,
      });
      leases = [unresolved];
    }
    new AnalysisCleanupLeaseGroup(failure, leases);
    if (cause.partialObservation !== undefined)
      (primary ?? failure).retainPartialObservation(cause.partialObservation);
    return primary === undefined
      ? failure
      : analysisErrorWithCleanupDependencies(primary, failure, operation);
  }

  /** How this provider's owned producer commands report, for the shared classifiers. */
  commandContext(
    { selected: limits, defaults, output }: ProducerCommandLimits,
    effectiveLimits: LinuxResourceLimits | undefined,
    operation: string,
  ): ProviderOutcomeContext {
    return {
      providerId: this.providerId,
      operation,
      capturedOutput: capturedProviderOutput,
      timeout: {
        ms: limits.command_timeout_ms,
        limit: deadlineParameterLimit(
          "producer_limits.command_timeout_ms",
          limits.command_timeout_ms,
          defaults.command_timeout_ms,
        ),
        userMessage: `The owned producer command reached its ${String(limits.command_timeout_ms)} ms deadline. This is not a client-side timeout; extending only the MCP client's deadline does not change this budget.`,
        remediationAction: `${limits.command_timeout_ms < MAX_NODE_TIMER_DELAY_MS ? `Increase producer_limits.command_timeout_ms above ${String(limits.command_timeout_ms)} milliseconds on the next call (range 1..${String(MAX_NODE_TIMER_DELAY_MS)}); no restart is required.` : `producer_limits.command_timeout_ms is already at the runtime timer maximum ${String(MAX_NODE_TIMER_DELAY_MS)} milliseconds; no higher deadline is supported. Narrow the selected work if that preserves the required observation.`} Inspect retained observations and confirm cleanup before retrying. This does not raise CPU, memory, output, parser or external client limits.`,
      },
      outputLimit: {
        limits: { output_bytes: limits.output_bytes },
        limit: output,
        // The capture stops at the budget, so the output it needs is unmeasured.
        recovery: { retryable: false },
      },
      resourceSignal: (signal) => {
        const reported =
          effectiveLimits === undefined
            ? "The effective inherited limit was not reported."
            : `The effective inherited limits are ${String(effectiveLimits.address_space_bytes)} bytes of address space, ${String(effectiveLimits.file_bytes)} bytes per file, and ${String(effectiveLimits.cpu_seconds)} CPU seconds.`;
        // A producer can raise SIGXCPU/SIGXFSZ without exhausting the retained
        // rlimit, so an unchanged retry is not a proven failure.
        return {
          limits: effectiveLimits === undefined ? null : { ...effectiveLimits },
          recovery: {
            retryable: true,
            remediationAction: `${reported} REA retains the tighter inherited limit. Review producer_limits.${signal === "SIGXFSZ" ? "file_bytes" : "cpu_seconds"} for a new call; a higher requested policy cannot raise a tighter inherited soft or hard limit. No REA restart is needed for a per-call update. A smaller artifact may finish inside the retained limit. The signal does not prove that ceiling was exhausted, so an unchanged retry may succeed or may fail the same way.`,
          },
        };
      },
      dialect: (_outcome, _details, unclassified) => unclassified(),
    };
  }

  close(): Promise<void> {
    this.#closed = true;
    const work = this.#tail.then(() => this.#closeResources());
    this.#tail = work.catch(() => undefined);
    return work;
  }

  async #closeResources(): Promise<void> {
    let descriptorFailure: AnalysisError | undefined;
    try {
      await this.#artifacts.scope.close();
    } catch (cause: unknown) {
      descriptorFailure = this.classify(cause, {
        kind: "resources",
        operation: this.#artifacts.operation,
      });
    }
    try {
      await this.release();
    } catch (cause: unknown) {
      if (descriptorFailure !== undefined && cause instanceof AnalysisError)
        throw analysisErrorWithCleanupDependencies(
          descriptorFailure,
          cause,
          this.#artifacts.operation,
        );
      throw cause;
    }
    if (descriptorFailure !== undefined) throw descriptorFailure;
  }
}
