import { AnalysisError } from "../domain/errors.js";

interface ProcessCaptureErrorOptions extends ErrorOptions {
  readonly userMessage?: string;
  readonly userCategory?: "permission_required" | "cancelled";
  readonly reason?:
    | "capture_failed"
    | "cleanup_incomplete"
    | "permission_required"
    | "cancelled";
  readonly cleanupResources?: readonly string[];
}

/** Typed application failure produced by controlled process capture. */
export class ProcessCaptureError extends AnalysisError {
  readonly _tag = "ProcessCaptureError";

  override readonly userMessage: string | undefined;
  override readonly userCategory:
    | "permission_required"
    | "cancelled"
    | undefined;
  readonly reason: NonNullable<ProcessCaptureErrorOptions["reason"]>;
  override readonly cleanupIncomplete: boolean;
  override readonly cleanupResources: readonly string[];

  constructor(message: string, options?: ProcessCaptureErrorOptions) {
    super(message, options);
    this.userMessage = options?.userMessage;
    this.userCategory = options?.userCategory;
    this.reason =
      options?.reason ??
      (options?.userCategory === "permission_required"
        ? "permission_required"
        : options?.userCategory === "cancelled"
          ? "cancelled"
          : "capture_failed");
    this.cleanupIncomplete = this.reason === "cleanup_incomplete";
    this.cleanupResources = options?.cleanupResources ?? [];
  }
}

/** Caller-visible cancellation without exposing capture implementation state. */
export const processCaptureCancelled = (): ProcessCaptureError =>
  new ProcessCaptureError("process capture was cancelled", {
    userCategory: "cancelled",
    reason: "cancelled",
    userMessage: "Process capture was cancelled. Start it again when ready.",
  });
