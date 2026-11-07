import { rm } from "node:fs/promises";

import { AnalysisCancelledError } from "../../domain/analysisErrorCore.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import type { TaskFileView } from "../../domain/desktop/appTaskChecks.js";
import { DarwinProcessOwnershipInspectionError } from "../../process/DarwinProcessRunTokenReader.js";
import { OwnedCommandFailure } from "../../process/OwnedCommand.js";
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
    readonly folder: string,
    readonly failure: ProviderCleanupError,
    readonly stop: () => Promise<void>,
  ) {}

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
      await this.stop();
      await rm(this.folder, { recursive: true, force: true });
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
  const owner =
    cause instanceof OwnedCommandFailure ? cause.cleanupOwner : undefined;
  const preparation =
    cause instanceof OwnedCommandFailure
      ? cause.preparationFailure
      : cause instanceof DarwinProcessOwnershipInspectionError
        ? cause
        : undefined;
  if (
    owner === undefined &&
    preparation?.cleanupOwner === undefined &&
    folderFailure === undefined
  )
    return undefined;
  let stopped = owner === undefined;
  let prepared = preparation?.cleanupOwner === undefined;
  const original = primaryFailure(cause);
  const resources = [
    ...(cause instanceof OwnedCommandFailure ? cause.resources : []),
    folder,
  ];
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
  processWorkerCleanup.add(
    new ReaderCleanup(folder, failure, async () => {
      if (!stopped && owner !== undefined) {
        const result = await owner.stop();
        if (result.status === "incomplete") throw new Error(result.reason);
        owner.dispose();
        stopped = true;
      }
      if (!prepared) {
        await preparation?.cleanupOwner?.close();
        prepared = true;
      }
    }),
  );
  return failure;
};
