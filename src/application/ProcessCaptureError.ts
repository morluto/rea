import { AnalysisError } from "../domain/errors.js";

interface ProcessCaptureErrorOptions extends ErrorOptions {
  readonly userMessage?: string;
  readonly userCategory?: "permission_required" | "cancelled";
}

/** Typed application failure produced by controlled process capture. */
export class ProcessCaptureError extends AnalysisError {
  readonly _tag = "ProcessCaptureError";

  override readonly userMessage: string | undefined;
  override readonly userCategory:
    | "permission_required"
    | "cancelled"
    | undefined;

  constructor(message: string, options?: ProcessCaptureErrorOptions) {
    super(message, options);
    this.userMessage = options?.userMessage;
    this.userCategory = options?.userCategory;
  }
}

/** Caller-visible cancellation without exposing capture implementation state. */
export const processCaptureCancelled = (): ProcessCaptureError =>
  new ProcessCaptureError("process capture was cancelled", {
    userCategory: "cancelled",
    userMessage: "Process capture was cancelled. Start it again when ready.",
  });
