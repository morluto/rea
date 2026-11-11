import { SamplingReadBatchFailure } from "./ProcessSamplingObservation.js";
import { analysisErrorWithCancellation } from "../../domain/analysisErrorCancellation.js";
import {
  AnalysisCleanupLease,
  AnalysisCleanupLeaseGroup,
} from "../../artifacts/AnalysisCleanupLease.js";
import { AnalysisCancelledError } from "../../domain/analysisErrorCore.js";
import {
  ProcessOwnershipIdentityBatchFailure,
  isProcessOwnershipInspectionCancellation,
} from "../ProcessInspectionCancellation.js";
import {
  isProcessInspectionFailure,
  processInspectionCleanupFailures,
  processInspectionCancellations,
  type ProcessInspectionFailure,
} from "../ProcessInspectionCleanup.js";
import { DarwinProcessOwnershipInspectionError } from "../DarwinProcessRunTokenReader.js";
import {
  AnalysisError,
  primaryAnalysisError,
  type AnalysisErrorOptions,
} from "../../domain/analysisErrorBase.js";
import type {
  PartialProcessCaptureObservation,
  ProcessCaptureCleanupReport,
} from "../../domain/process/processCapture.js";

interface ProcessCaptureErrorOptions extends AnalysisErrorOptions {
  readonly userMessage?: string;
  readonly userCategory?: "cancelled";
  readonly reason?: "capture_failed" | "cleanup_incomplete" | "cancelled";
  readonly executionFailure?: string;
  readonly partialObservation?: PartialProcessCaptureObservation;
  readonly cleanupReport?: ProcessCaptureCleanupReport;
  /** Whether the producer identified a transient failure that can be retried. */
  readonly retryable?: boolean;
}

/** Typed application failure produced by controlled process capture. */
export class ProcessCaptureError extends AnalysisError {
  readonly _tag = "ProcessCaptureError";

  override readonly userMessage: string | undefined;
  override readonly userCategory: "cancelled" | undefined;
  readonly reason: NonNullable<ProcessCaptureErrorOptions["reason"]>;
  override readonly executionFailure: string | undefined;
  override readonly partialObservation:
    | PartialProcessCaptureObservation
    | undefined;
  override readonly cleanupReport: ProcessCaptureCleanupReport | undefined;
  readonly #retryable: boolean;

  get retryable(): boolean {
    return this.#retryable && !this.cleanupIncomplete;
  }

  constructor(message: string, options?: ProcessCaptureErrorOptions) {
    super(message, options);
    this.userMessage = options?.userMessage ?? message;
    this.userCategory = options?.userCategory;
    this.reason =
      options?.reason ??
      (options?.userCategory === "cancelled" ? "cancelled" : "capture_failed");
    this.cleanupIncomplete ||= this.reason === "cleanup_incomplete";
    this.executionFailure = options?.executionFailure ?? message;
    this.partialObservation = options?.partialObservation;
    this.cleanupReport = options?.cleanupReport;
    this.#retryable = options?.retryable === true;
  }

  /** Add final capture observations while preserving primary facts and cleanup ownership. */
  withFinalization(
    options: Pick<
      ProcessCaptureErrorOptions,
      "executionFailure" | "partialObservation" | "cleanupReport"
    > & { readonly cleanupFailure?: AnalysisError },
  ): ProcessCaptureError {
    const secondary = options.cleanupFailure;
    const resources = [
      ...new Set([
        ...this.cleanupResources,
        ...(secondary?.cleanupResources ?? []),
      ]),
    ];
    const executionFailure = this.executionFailure ?? options.executionFailure;
    const partialObservation =
      this.partialObservation ?? options.partialObservation;
    const cleanupReport = this.cleanupReport ?? options.cleanupReport;
    const finalized = new ProcessCaptureError(this.message, {
      cleanupPrimary: this,
      ...(Object.hasOwn(this, "cause") ? { cause: this.cause } : {}),
      ...(this.userMessage === undefined
        ? {}
        : { userMessage: this.userMessage }),
      ...(this.userCategory === undefined
        ? {}
        : { userCategory: this.userCategory }),
      reason: this.reason,
      ...(this.capturedOutput === undefined
        ? {}
        : { capturedOutput: this.capturedOutput }),
      ...(secondary === undefined
        ? this.cleanup === undefined
          ? {}
          : { cleanup: this.cleanup }
        : { cleanup: { reason: secondary.message, resources } }),
      ...(executionFailure === undefined ? {} : { executionFailure }),
      ...(partialObservation === undefined ? {} : { partialObservation }),
      ...(cleanupReport === undefined ? {} : { cleanupReport }),
      ...(this.#retryable ? { retryable: true } : {}),
    }).bindCleanupDependencies([
      this,
      ...(secondary === undefined ? [] : [secondary]),
    ]);
    if (secondary !== undefined) finalized.retainSecondaryFailure(secondary);
    return finalized;
  }
}

/** Return one non-recursive, domain-neutral summary of an execution failure. */
export const describeProcessCaptureExecutionFailure = (
  failure: unknown,
): string | undefined => {
  if (failure instanceof Error) return failure.message || failure.name;
  if (typeof failure === "string") return failure;
  if (failure === undefined) return undefined;
  return "Process capture failed with a non-error rejection.";
};

const captureCancellationPresentation = {
  userCategory: "cancelled",
  reason: "cancelled",
  userMessage: "Process capture was cancelled. Start it again when ready.",
} as const;

/** Caller-visible cancellation without exposing capture implementation state. */
export const processCaptureCancelled = (
  reason?: unknown,
): ProcessCaptureError =>
  new ProcessCaptureError("process capture was cancelled", {
    cause: reason,
    ...captureCancellationPresentation,
  });

/** Keep the exact inspection record and close capabilities through capture finalization. */
export class ProcessCaptureInspectionFailure extends ProcessCaptureError {
  readonly #cleanupLeases: readonly AnalysisCleanupLease[];

  get cleanupLeases(): readonly AnalysisCleanupLease[] {
    return this.#cleanupLeases;
  }

  constructor(readonly inspectionFailure: ProcessInspectionFailure) {
    const darwin =
      inspectionFailure instanceof DarwinProcessOwnershipInspectionError
        ? inspectionFailure
        : undefined;
    const cancellation =
      darwin?.cancellation ??
      (isProcessOwnershipInspectionCancellation(inspectionFailure)
        ? { reason: inspectionFailure.reason }
        : undefined);
    const cleanupFailures = processInspectionCleanupFailures(inspectionFailure);
    const cleanupResources = [
      ...new Set(
        cleanupFailures.flatMap((failure) =>
          failure instanceof DarwinProcessOwnershipInspectionError
            ? (failure.cleanupFailure?.cleanupResources ?? [
                "process ownership inspection",
              ])
            : [failure.path],
        ),
      ),
    ];
    super(
      cancellation === undefined
        ? inspectionFailure.message
        : "process capture was cancelled",
      {
        cause:
          cancellation === undefined ? inspectionFailure : cancellation.reason,
        ...(cancellation === undefined ? {} : captureCancellationPresentation),
        ...(cleanupFailures.length === 0
          ? {}
          : {
              cleanup: {
                reason: cleanupFailures
                  .map((failure) =>
                    failure instanceof DarwinProcessOwnershipInspectionError
                      ? (failure.cleanupFailure?.message ?? failure.message)
                      : (describeProcessCaptureExecutionFailure(
                          failure.cleanupCause,
                        ) ?? "descriptor cleanup failed"),
                  )
                  .join("; "),
                resources: cleanupResources,
              },
            }),
        ...(darwin?.capturedOutput === undefined
          ? {}
          : { capturedOutput: darwin.capturedOutput }),
        ...(darwin?.compilerOutcome?.outcome === "timed_out"
          ? { retryable: true }
          : {}),
        ...(inspectionFailure instanceof ProcessOwnershipIdentityBatchFailure
          ? {
              diagnostics: {
                retained_observation_count: inspectionFailure.observations.size,
                rejected_request_count: inspectionFailure.failures.length,
              },
            }
          : {}),
      },
    );
    const leases: AnalysisCleanupLease[] = [];
    for (const failure of cleanupFailures) {
      if (failure instanceof DarwinProcessOwnershipInspectionError) {
        const marker = failure.cleanupFailure;
        if (marker !== undefined) this.bindCleanupDependencies([marker]);
        if (
          failure.cleanupOwner === undefined ||
          marker?.cleanupIncomplete === false
        )
          continue;
        const owner = failure.cleanupOwner;
        const lease = new AnalysisCleanupLease(
          () => owner.close(),
          marker ?? ["process ownership inspection"],
        );
        if (marker !== undefined) lease.bindCleanupError(marker);
        leases.push(lease);
      } else
        leases.push(
          new AnalysisCleanupLease(() => failure.owner.close(), [failure.path]),
        );
    }
    this.#cleanupLeases = leases;
    if (leases.length > 0) new AnalysisCleanupLeaseGroup(this, leases);
    if (cancellation === undefined)
      for (const fact of processInspectionCancellations(inspectionFailure))
        this.retainSecondaryFailure(
          new AnalysisCancelledError("capture_process", { cause: fact.reason }),
        );
  }
}

/** Capture presentation and cleanup leases for a neutral, fully settled sampling batch. */
export class ProcessCaptureSamplingFailure extends ProcessCaptureError {
  readonly #inspectionFailures: readonly ProcessCaptureInspectionFailure[];
  readonly #samplingFailure: SamplingReadBatchFailure;

  get inspectionFailures(): readonly ProcessCaptureInspectionFailure[] {
    return this.#inspectionFailures;
  }
  get samplingFailure(): SamplingReadBatchFailure {
    return this.#samplingFailure;
  }

  constructor(samplingFailure: SamplingReadBatchFailure) {
    const inspections = samplingFailure.inspectionFailures.map(
      (failure) => new ProcessCaptureInspectionFailure(failure),
    );
    const primary =
      inspections.find((failure) => failure.userCategory !== "cancelled") ??
      (samplingFailure.otherFailures.length > 0 ? undefined : inspections[0]);
    const resources = [
      ...new Set(inspections.flatMap((failure) => failure.cleanupResources)),
    ];
    super(primary?.message ?? samplingFailure.message, {
      cause: samplingFailure,
      ...(primary === undefined ? {} : { cleanupPrimary: primary }),
      ...(primary?.userCategory === "cancelled"
        ? captureCancellationPresentation
        : {}),
      ...(resources.length === 0
        ? {}
        : {
            cleanup: {
              reason: "Process sampling descriptors remain owned",
              resources,
            },
          }),
    });
    this.#inspectionFailures = inspections;
    this.#samplingFailure = samplingFailure;
    for (const failure of inspections)
      if (failure !== primary) this.retainSecondaryFailure(failure);
    this.bindCleanupDependencies(inspections);
  }
}

/** Only capture-owned normalized records transfer capture lease capabilities. */
export const captureInspectionFailures = (
  cause: unknown,
): readonly ProcessCaptureInspectionFailure[] =>
  cause instanceof ProcessCaptureSamplingFailure
    ? cause.inspectionFailures
    : cause instanceof ProcessCaptureInspectionFailure
      ? [cause]
      : [];

/** Interpret only facts emitted by the inspection owner; caller values remain opaque. */
export const normalizeCaptureFailure = (cause: unknown): unknown => {
  if (cause instanceof ProcessCaptureError) return cause;
  if (cause instanceof SamplingReadBatchFailure)
    return new ProcessCaptureSamplingFailure(cause);
  if (isProcessInspectionFailure(cause))
    return new ProcessCaptureInspectionFailure(cause);
  return cause;
};

/** Keep normalized inspection cancellation visible when its failure becomes a cleanup child. */
export const retainCaptureInspectionCancellations = (
  failure: AnalysisError,
  inspection: ProcessCaptureInspectionFailure,
): void => {
  const primary = primaryAnalysisError(failure);
  if (inspection.reason === "cancelled" && primary !== inspection)
    analysisErrorWithCancellation(
      primary,
      new AnalysisCancelledError("capture_process", {
        cause: inspection.cause,
      }),
    );
  for (const secondary of inspection.secondaryFailures)
    if (secondary instanceof AnalysisCancelledError)
      analysisErrorWithCancellation(primary, secondary);
};
