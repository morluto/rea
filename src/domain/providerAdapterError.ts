import {
  AnalysisError,
  type AnalysisErrorOptions,
} from "./analysisErrorBase.js";

/** A provider adapter failed outside its more precise typed variants. */
export interface ProviderAdapterErrorOptions extends AnalysisErrorOptions {
  readonly userMessage?: string;
  readonly remediationAction?: string;
}

/** A provider adapter failed outside its more precise typed variants. */
export class ProviderAdapterError extends AnalysisError {
  readonly _tag = "ProviderAdapterError";
  override readonly userMessage: string | undefined;
  readonly remediationAction: string | undefined;

  constructor(
    readonly providerId: string,
    readonly operation: string,
    options: ProviderAdapterErrorOptions = {},
  ) {
    super(`Provider ${providerId} adapter failed during ${operation}`, options);
    this.userMessage = options.userMessage;
    this.remediationAction = options.remediationAction;
  }
}

/** A request reached an analysis client after its session closed that client. */
export const closedAnalysisClientError = (
  providerId: string,
  operation: string,
): ProviderAdapterError =>
  new ProviderAdapterError(providerId, operation, {
    userMessage: `The ${providerId} analysis client for this session was closed before ${operation} ran.`,
    remediationAction:
      "Open the target again with open_binary, or rerun the CLI command, then send the request to the new session.",
    diagnostics: { reason: "client_closed" },
  });
