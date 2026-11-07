import { AnalysisCancelledError } from "../../domain/analysisErrorCore.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import type { TaskFileView } from "../../domain/desktop/appTaskChecks.js";
import { OwnedCommandFailure } from "../../process/OwnedCommand.js";
import { RetainedCommandCleanup } from "../../process/RetainedCommandCleanup.js";
import {
  processWorkerCleanup,
  type RetainedWorkerCleanup,
} from "../../process/OwnedWorkerRuntime.js";
import { DESKTOP_PROVIDER } from "./DesktopCaptureRefusals.js";

const OPERATION = "export_desktop_application";

export interface ReaderFacts {
  readonly views: ReadonlyMap<string, TaskFileView>;
  readonly absent: readonly string[];
}

const primaryFailure = (cause: unknown): AnalysisError | undefined => {
  if (cause instanceof AnalysisError) return cause;
  if (cause === undefined) return undefined;
  return cause instanceof OwnedCommandFailure && cause.reason === "cancelled"
    ? new AnalysisCancelledError(OPERATION, {
        cause: cause.cancellation?.reason,
      })
    : new ProviderAdapterError(DESKTOP_PROVIDER.id, OPERATION, {
        cause,
        userMessage: `The task reader could not complete: ${cause instanceof Error ? cause.message : String(cause)}`,
      });
};

const readerDiagnostics = ({ views, absent }: ReaderFacts) => ({
  ...(views.size === 0
    ? {}
    : {
        completed_reader_views: Object.fromEntries(
          [...views].map(([id, view]) => [
            id,
            {
              format: view.format,
              view: view.view,
              ...(view.compression === undefined
                ? {}
                : { compression: view.compression }),
              ...(view.error === undefined ? {} : { error: view.error }),
            },
          ]),
        ),
      }),
  ...(absent.length === 0 ? {} : { completed_reader_absent: [...absent] }),
});

/** Preserve completed readers when a later reader fails or is cancelled. */
export const readerFailure = (
  cause: unknown,
  facts: ReaderFacts,
): AnalysisError =>
  (
    primaryFailure(cause) ??
    new ProviderAdapterError(DESKTOP_PROVIDER.id, OPERATION, { cause })
  ).retainDiagnostics(readerDiagnostics(facts));

/** Own an unconfirmed reader process and its working folder across requests. */
class ReaderCleanup implements RetainedWorkerCleanup {
  #retry: Promise<void> | undefined;
  constructor(
    readonly owner: RetainedCommandCleanup,
    readonly failure: ProviderCleanupError,
  ) {
    failure.bindCleanupResourceOwner(owner);
  }

  retryRetainedCleanup(): Promise<void> {
    if (this.#retry !== undefined) return this.#retry;
    const attempt = this.#release();
    this.#retry = attempt;
    void attempt
      .finally(() => {
        this.#retry = undefined;
      })
      .catch(() => {});
    return attempt;
  }

  async #release(): Promise<void> {
    try {
      await this.owner.close();
      processWorkerCleanup.delete(this);
      this.failure.resolveCleanup();
    } catch (cause: unknown) {
      this.failure.retainDiagnostics({
        retry_failure: cause instanceof Error ? cause.message : String(cause),
      });
      throw this.failure;
    }
  }
}

/** Retain the physical owner before projecting an interrupted reader result. */
export const retainReaderCleanup = (
  folder: string,
  cause: unknown,
  facts: ReaderFacts,
  folderFailure?: { readonly cause: unknown },
): ProviderCleanupError | undefined => {
  const owner = new RetainedCommandCleanup(folder, cause);
  if (!owner.hasProcess && folderFailure === undefined) return undefined;
  const original = primaryFailure(cause);
  const resources = owner.cleanupResources;
  const problem =
    folderFailure?.cause ??
    (cause instanceof OwnedCommandFailure ? cause.cleanupFailure : undefined) ??
    cause;
  const failure = new ProviderCleanupError(
    DESKTOP_PROVIDER.id,
    resources,
    {
      reason: problem instanceof Error ? problem.message : String(problem),
      ...readerDiagnostics(facts),
    },
    {
      operation: OPERATION,
      cause,
      ...(original === undefined ? {} : { cleanupPrimary: original }),
      remediationAction:
        "Retry cleanup in this REA process before starting another reader; if it exits first, inspect the reported local resources.",
    },
  );
  processWorkerCleanup.add(new ReaderCleanup(owner, failure));
  return failure;
};
