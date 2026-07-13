import { AnalysisError } from "../domain/errors.js";

/** Typed application failure produced by controlled process capture. */
export class ProcessCaptureError extends AnalysisError {
  readonly _tag = "ProcessCaptureError";
}
