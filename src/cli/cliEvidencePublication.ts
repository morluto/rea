import { AsyncLocalStorage } from "node:async_hooks";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { CliEvidenceRetention } from "./cliEvidenceRetention.js";

export interface PublishedEvidenceReceipt {
  readonly path?: string;
  readonly bytes: number;
}

interface PublicationContext {
  receipt?: PublishedEvidenceReceipt;
  readonly invocation?: CliPublicationInvocation;
}
const publication = new AsyncLocalStorage<PublicationContext>();

/** What one CLI invocation captured that its delivery reads. */
export interface CliPublicationInvocation {
  /** REA_AGENT_RESULT_BUDGET_BYTES from the environment this invocation captured. */
  readonly agentBudgetSeed?: string | undefined;
  /** Whether the caller selected specific output fields with `--filter-output`. */
  readonly hasFilterOutput?: boolean | undefined;
  /**
   * Where an over-budget result without --evidence_output is kept, from the
   * environment this invocation captured; undefined retains nothing
   * (--no-retain, or the setting is 0).
   */
  readonly retention?: CliEvidenceRetention | undefined;
}

/** Keep publication state in the invocation that owns delivery and formatting. */
export const withCliEvidencePublication = <Value>(
  run: () => Value,
  invocation?: CliPublicationInvocation,
): Value =>
  publication.run(invocation === undefined ? {} : { invocation }, run);

/** What this invocation captured; nothing outside one. */
export const cliPublicationInvocation = (): CliPublicationInvocation =>
  publication.getStore()?.invocation ?? {};

export const recordCliEvidencePublication = (
  receipt: PublishedEvidenceReceipt,
): void => {
  const context = publication.getStore();
  if (context !== undefined) context.receipt = receipt;
};

/** Withdraw this invocation's receipt when the file it named was discarded. */
export const clearCliEvidencePublication = (): void => {
  const context = publication.getStore();
  if (context !== undefined) delete context.receipt;
};

/** Snapshot a receipt for output recovery after the invocation context ends. */
export const cliEvidencePublicationReceipt = ():
  | PublishedEvidenceReceipt
  | undefined => publication.getStore()?.receipt;

/** Preserve an already committed file when subsequent output selection fails. */
export const retainCliPublicationOnError = <ErrorType extends AnalysisError>(
  error: ErrorType,
  receipt = cliEvidencePublicationReceipt(),
): ErrorType => {
  return receipt === undefined
    ? error
    : error.retainDiagnostics({ evidence_bundle: { ...receipt } });
};
