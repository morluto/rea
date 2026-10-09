import { DarwinProcessOwnershipInspectionError } from "../DarwinProcessRunTokenReader.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import type {
  PartialProcessCaptureObservation,
  ProcessCaptureCleanupReport,
} from "../../domain/process/processCapture.js";

interface ProcessCaptureErrorOptions extends ErrorOptions {
  readonly userMessage?: string;
  readonly userCategory?: "cancelled";
  readonly reason?: "capture_failed" | "cleanup_incomplete" | "cancelled";
  readonly cleanupResources?: readonly string[];
  readonly executionFailure?: string;
  readonly partialObservation?: PartialProcessCaptureObservation;
  readonly cleanupReport?: ProcessCaptureCleanupReport;
}

/** Typed application failure produced by controlled process capture. */
export class ProcessCaptureError extends AnalysisError {
  readonly _tag = "ProcessCaptureError";

  override readonly userMessage: string | undefined;
  override readonly userCategory: "cancelled" | undefined;
  readonly reason: NonNullable<ProcessCaptureErrorOptions["reason"]>;
  override readonly cleanupIncomplete: boolean;
  override readonly cleanupResources: readonly string[];
  override readonly executionFailure: string | undefined;
  override readonly partialObservation:
    | PartialProcessCaptureObservation
    | undefined;
  override readonly cleanupReport: ProcessCaptureCleanupReport | undefined;

  constructor(message: string, options?: ProcessCaptureErrorOptions) {
    super(message, options);
    this.userMessage = options?.userMessage ?? message;
    this.userCategory = options?.userCategory;
    this.reason =
      options?.reason ??
      (options?.userCategory === "cancelled" ? "cancelled" : "capture_failed");
    this.cleanupIncomplete = this.reason === "cleanup_incomplete";
    this.cleanupResources = options?.cleanupResources ?? [];
    this.executionFailure = options?.executionFailure ?? message;
    this.partialObservation = options?.partialObservation;
    this.cleanupReport = options?.cleanupReport;
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

/** Caller-visible cancellation without exposing capture implementation state. */
export const processCaptureCancelled = (): ProcessCaptureError =>
  new ProcessCaptureError("process capture was cancelled", {
    userCategory: "cancelled",
    reason: "cancelled",
    userMessage: "Process capture was cancelled. Start it again when ready.",
  });

/** Preserve typed process-inspection preflight failures at the capture boundary. */
export const normalizeCaptureFailure = (
  cause: unknown,
  signal: AbortSignal | undefined,
): unknown => {
  if (cause instanceof ProcessCaptureError) return cause;
  if (cause instanceof DarwinProcessOwnershipInspectionError)
    return new ProcessCaptureError(cause.message, { cause });
  if (
    signal?.aborted === true &&
    (cause === signal.reason ||
      (cause instanceof Error && cause.name === "AbortError"))
  )
    return processCaptureCancelled();
  return cause;
};
