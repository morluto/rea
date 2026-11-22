import { capturedProviderOutput } from "./capturedProviderOutput.js";
import {
  AnalysisCleanupLease,
  AnalysisCleanupLeaseGroup,
  ArtifactReaderFailure,
  type CleanupFailedRead,
  ArtifactResourceScope,
  readStableArtifact,
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
import {
  fixedAllowanceOptions,
  fixedProducerInputAllowance,
} from "../domain/fixedAllowanceRemediation.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { err, type Result } from "../domain/result.js";
import {
  readLinuxResourceLimits,
  type LinuxResourceLimits,
} from "./LinuxResourceLimits.js";
import type { PrivateRuntimeRoot } from "./PrivateRuntimeRoot.js";
import type {
  ProviderProcessSnapshot,
  ProviderProcessSupervisor,
} from "./ProviderProcess.js";
import { OwnedCommandFailure, ownedCommandResources } from "./OwnedCommand.js";
import { providerOutcomeOf } from "./ProviderOutcome.js";
import {
  classifyProviderOutcome,
  type ProviderOutcomeContext,
} from "./classifyProviderOutcome.js";
import { MAX_NODE_TIMER_DELAY_MS } from "../domain/analysisResourceLimits.js";

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
  readonly maximumBytes: number;
  readonly allowanceName: string;
  readonly observedOutput: AnalysisCapturedOutput | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly budgetParameter?: "producer_limits.input_bytes";
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

  /** Admit a selected input and classify its physical failure before later stages. */
  async readSelectedArtifact(input: SelectedArtifactRead) {
    const operation = this.#artifacts.operation;
    try {
      return await this.read(input.path, input.maximumBytes, input.signal);
    } catch (cause: unknown) {
      throw this.classify(cause, { kind: "selected-input", operation, input });
    }
  }

  /** The read budget and recovery for a selected input larger than it admits. */
  selectedFileSize(input: SelectedArtifactRead, operation: string) {
    const { maximumBytes, allowanceName, budgetParameter } = input;
    return (cause: ArtifactReaderFailure, details: AnalysisErrorOptions) =>
      new AnalysisResourceConstraintError(
        operation,
        "file-size",
        cause.message,
        { input_bytes: maximumBytes },
        {
          ...details,
          cause,
          ...(budgetParameter === undefined
            ? fixedProducerInputAllowance(maximumBytes, allowanceName)
            : {
                retryable: false,
                remediationAction: `Increase ${budgetParameter} above ${String(maximumBytes)} bytes on the next call to admit the same complete selected artifact; no REA restart is required. Do not truncate required input bytes. Output, parser, transport and inherited OS limits remain independent.`,
              }),
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
        return await this.read(path, 64 * 1024 * 1024);
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

  commandFailure(
    cause: OwnedCommandFailure,
    limits: {
      readonly command_timeout_ms: number;
      readonly output_bytes: number;
    },
    effectiveLimits: LinuxResourceLimits | undefined,
    operation = this.operation,
    budgetParameter?: "producer_limits",
  ): AnalysisError {
    return classifyProviderOutcome(
      providerOutcomeOf(cause),
      this.commandContext(limits, effectiveLimits, operation, budgetParameter),
    );
  }

  /** How this provider's owned producer commands report, for the shared classifiers. */
  commandContext(
    limits: {
      readonly command_timeout_ms: number;
      readonly output_bytes: number;
    },
    effectiveLimits: LinuxResourceLimits | undefined,
    operation = this.operation,
    budgetParameter?: "producer_limits",
  ): ProviderOutcomeContext {
    return {
      providerId: this.providerId,
      operation,
      capturedOutput: capturedProviderOutput,
      timeout: {
        ms: limits.command_timeout_ms,
        userMessage: `The owned producer command reached its ${String(limits.command_timeout_ms)} ms deadline. This is not a client-side timeout; extending only the MCP client's deadline does not change this budget.`,
        remediationAction:
          budgetParameter === undefined
            ? `REA's fixed producer command deadline is ${String(limits.command_timeout_ms)} ms and this release has no runtime override. Inspect any partial output and cleanup before retrying. Repeating the unchanged request reaches the same deadline.`
            : `${limits.command_timeout_ms < MAX_NODE_TIMER_DELAY_MS ? `Increase ${budgetParameter}.command_timeout_ms above ${String(limits.command_timeout_ms)} milliseconds on the next call (range 1..${String(MAX_NODE_TIMER_DELAY_MS)}); no restart is required.` : `${budgetParameter}.command_timeout_ms is already at the runtime timer maximum ${String(MAX_NODE_TIMER_DELAY_MS)} milliseconds; no higher deadline is supported. Narrow the selected work if that preserves the required observation.`} Inspect retained observations and confirm cleanup before retrying. This does not raise CPU, memory, output, parser or external client limits.`,
      },
      outputLimit: {
        limits: { output_bytes: limits.output_bytes },
        recovery:
          budgetParameter === undefined
            ? fixedAllowanceOptions(
                `The retained command-output allowance of ${String(limits.output_bytes)} bytes (this release has no runtime override)`,
                "capture",
                { limit: limits.output_bytes, unit: "bytes" },
              )
            : {
                retryable: false,
                remediationAction: `Increase ${budgetParameter}.output_bytes above ${String(limits.output_bytes)} bytes on the next call; no restart is required. Inspect captured output and confirm cleanup before retrying. This controls collection, not parser, transport, host memory or inherited OS limits. Repeating the unchanged request cannot raise it.`,
              },
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
            remediationAction: `${reported} REA retains the tighter inherited limit. ${budgetParameter === undefined ? "This release has no runtime override for that ceiling." : `Review ${budgetParameter}.${signal === "SIGXFSZ" ? "file_bytes" : "cpu_seconds"} for a new call; a higher requested policy cannot raise a tighter inherited soft or hard limit. No REA restart is needed for a per-call update.`} A smaller artifact may finish inside the retained limit. The signal does not prove that ceiling was exhausted, so an unchanged retry may succeed or may fail the same way.`,
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
