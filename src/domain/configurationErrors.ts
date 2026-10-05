import { AnalysisError } from "./analysisErrorBase.js";

/** Runtime configuration could not be parsed safely. */
export class ConfigurationError extends AnalysisError {
  readonly _tag = "ConfigurationError";
}

/** No app or binary session exists for an analysis request. */
export class NoBinaryOpenError extends AnalysisError {
  readonly _tag = "NoBinaryOpenError";
  constructor() {
    super(
      "No app is open. Ask the user which app to investigate, then call open_binary with its local path.",
    );
  }
}

/** A supplied target path could not be safely opened as a supported app or binary. */
export class BinaryTargetError extends AnalysisError {
  readonly _tag = "BinaryTargetError";
  constructor(
    readonly path: string,
    reason: string,
    options?: ErrorOptions,
  ) {
    super(`Cannot open artifact: ${reason}`, options);
  }
}
