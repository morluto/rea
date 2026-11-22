import { resolveInvestigationEvidenceClosure } from "./investigation/InvestigationEvidence.js";
import { dispatchQueuedInterrupts } from "../process/queuedInterrupts.js";

import {
  EvidenceFileError,
  type PublishedEvidenceFile,
} from "../domain/evidenceErrors.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { withInheritedCleanupOwnership } from "../domain/analysisErrorCleanup.js";
import {
  AnalysisInputError,
  cancelledBy,
} from "../domain/analysisErrorCore.js";
import type { Evidence } from "../domain/evidence.js";
import type { EvidenceBundle } from "../domain/evidenceBundle.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  compareBundles,
  type BundleRecordPair,
} from "../domain/bundleComparison.js";
import { ArtifactResourceScope } from "../resources/index.js";
import {
  readEvidenceBundle,
  readImmutableEvidenceBundle,
  readComparisonEvidenceBundles,
  writeEvidenceBundle,
  evidenceBundleExportReceipt,
} from "./EvidenceBundleFiles.js";
import { inspectEvidenceBundle } from "./investigation/InspectEvidenceBundle.js";
import type { EvidenceRecordFilters } from "../domain/evidenceRecordSummary.js";
import {
  finalizedResult,
  runOwned,
  type RunOwnedOptions,
} from "../providers/runOwned.js";

/** Validate a standalone bundle and report its complete record/revision counts. */
export const importEvidenceBundleCommand = async (
  path: string,
  signal?: AbortSignal,
): Promise<Result<JsonValue, AnalysisError>> => {
  return withBundleReadResources(
    async (resources) => {
      const loaded = await readEvidenceBundle(
        path,
        signal,
        resources,
        "import_evidence_bundle",
      );
      if (!loaded.ok) return loaded;
      return ok({
        imported: loaded.value.records.length,
        unknowns_added: loaded.value.unknowns.length,
        total: loaded.value.records.length,
      });
    },
    "import_evidence_bundle",
    signal,
  );
};

/** Validate a source bundle and atomically export canonical bytes. */
export const exportEvidenceBundleCommand = async (
  sourcePath: string,
  outputPath: string,
  overwrite: boolean,
  signal?: AbortSignal,
): Promise<Result<JsonValue, AnalysisError>> => {
  // The sealed snapshot lets the writer reuse this authentication.
  const loaded = await withBundleReadResources(
    (resources) =>
      readImmutableEvidenceBundle(
        sourcePath,
        signal,
        resources,
        "export_evidence_bundle",
      ),
    "export_evidence_bundle",
    signal,
  );
  if (!loaded.ok) return loaded;
  const written = await finalizeBundleWork(
    () =>
      persistEvidenceBundleCommand(
        loaded.value,
        outputPath,
        overwrite,
        signal,
        "export_evidence_bundle",
      ),
    {
      providerId: "rea",
      operation: "export_evidence_bundle",
      signal,
      // Deliver interrupts queued during publication cleanup before deciding
      // whether a written bundle survives cancellation.
      close: dispatchQueuedInterrupts,
      diagnostics: (receipt) => ({ evidence_bundle: { ...receipt } }),
    },
  );
  return projectWrite(loaded.value, written);
};

/** Selected Evidence delivered after its complete bundle was committed. */
export interface PublishedEvidenceDelivery {
  readonly delivered: Evidence;
  readonly evidenceBundle: PublishedEvidenceFile;
}

/**
 * Publish a complete bundle, then deliver Evidence already projected from it.
 * Cancellation observed before commit leaves no output and retains the
 * complete Evidence. A committed publication wins a later cancellation race;
 * its receipt stays in the typed cancellation as diagnostics.evidence_bundle,
 * and a cleanup failure after commit keeps its own published receipt.
 */
export const publishEvidenceDelivery = async (input: {
  readonly bundle: EvidenceBundle;
  readonly complete: Evidence;
  readonly delivered: Evidence;
  readonly outputPath: string;
  readonly operation: string;
  readonly signal?: AbortSignal | undefined;
}): Promise<Result<PublishedEvidenceDelivery, AnalysisError>> => {
  const { signal, operation } = input;
  // Partial analysis can hold only some of its linked sources. Both delivery
  // adapters must establish closure before committing a complete source bundle.
  const sources = new Map(
    input.bundle.records.map((record) => [record.evidence_id, record]),
  );
  const closure = resolveInvestigationEvidenceClosure(
    { evidenceForAnalysis: (id) => sources.get(id) },
    [input.complete.evidence_id],
  );
  if (!closure.ok)
    return err(closure.error.retainPartialObservation(input.complete));
  const written = await persistEvidenceBundleCommand(
    input.bundle,
    input.outputPath,
    false,
    signal,
    operation,
  );
  // Deliver interrupts queued during final publication cleanup before the
  // command's signal owner accepts completion and removes its listeners.
  await dispatchQueuedInterrupts();
  if (!written.ok) {
    const original = written.error;
    // This publication workflow never overwrites. The standalone export
    // command retains its own overwrite-capable recovery guidance.
    const failure =
      original instanceof EvidenceFileError && original.reason === "exists"
        ? withInheritedCleanupOwnership(
            new EvidenceFileError(original.operation, original.reason, {
              cause: original,
              ...(original.path === undefined ? {} : { path: original.path }),
              userMessage:
                "Evidence file already exists. Choose another output path.",
              ...(original.cleanupIncomplete
                ? { cleanup: original.cleanup }
                : {}),
              diagnostics: original.diagnostics,
            }),
            original,
          )
        : original;
    return err(failure.retainPartialObservation(input.complete));
  }
  if (signal?.aborted)
    return err(
      cancelledBy(operation, signal, {
        partialObservation: input.delivered,
        diagnostics: { evidence_bundle: { ...written.value } },
      }),
    );
  return ok({ delivered: input.delivered, evidenceBundle: written.value });
};

/** A delivery failure can follow commit; its receipt then owns the source closure. */
export const evidenceDeliveryCommitted = (error: AnalysisError): boolean =>
  error.diagnostics?.evidence_bundle !== undefined ||
  (error instanceof EvidenceFileError && error.published !== undefined);

/** Publish a completed bundle and retry its exact staged-output cleanup owner. */
const persistEvidenceBundleCommand = async (
  bundle: EvidenceBundle,
  outputPath: string,
  overwrite: boolean,
  signal?: AbortSignal,
  operation?: string,
): Promise<Result<PublishedEvidenceFile, AnalysisError>> => {
  const resources = new ArtifactResourceScope();
  const written = await writeEvidenceBundle(
    bundle,
    outputPath,
    overwrite,
    resources,
    signal,
    operation,
  );
  if (written.ok) return written;

  // Confirmed release resolves the bound error to its primary outcome; a
  // failed retry leaves that error incomplete with its exact retained owner.
  await resources.close().catch(() => undefined);
  if (
    !written.error.cleanupIncomplete &&
    written.error instanceof EvidenceFileError &&
    written.error.published?.path !== undefined
  ) {
    return ok({
      path: written.error.published.path,
      bytes: written.error.published.bytes,
    });
  }
  return written;
};

/** Compare two validated canonical Evidence bundles without session state. */
export const compareEvidenceBundlesCommand = async (input: {
  readonly leftPath: string;
  readonly rightPath: string;
  readonly recordPairs?: readonly BundleRecordPair[];
  readonly signal?: AbortSignal;
}): Promise<Result<JsonValue, AnalysisError>> => {
  // Sealed snapshots let comparison and its bundle digests reuse this
  // authentication instead of re-validating every record twice more.
  return withBundleReadResources(
    async (resources) => {
      const loaded = await readComparisonEvidenceBundles(
        input.leftPath,
        input.rightPath,
        input.signal,
        resources,
      );
      if (!loaded.ok) return loaded;
      const { left, right } = loaded.value;
      try {
        return ok(
          jsonValueSchema.parse(compareBundles(left, right, input.recordPairs)),
        );
      } catch (cause: unknown) {
        if (cause instanceof AnalysisInputError) return err(cause);
        throw cause;
      }
    },
    "compare_bundles",
    input.signal,
  );
};

const projectWrite = (
  bundle: EvidenceBundle,
  written: Result<PublishedEvidenceFile, AnalysisError>,
): Result<JsonValue, AnalysisError> =>
  written.ok ? ok(evidenceBundleExportReceipt(bundle, written.value)) : written;

/** Standalone bundle discovery shares the same read owner as import and comparison. */
export const inspectEvidenceBundleCommand = async (
  input: {
    readonly path: string;
    readonly detail: "complete" | "summary" | "records" | "links";
    readonly filters?: EvidenceRecordFilters | undefined;
    readonly offset?: number | undefined;
    readonly limit?: number | undefined;
    readonly traversal?: "direct" | "retained-closure" | undefined;
    readonly linked_evidence_id?: string | undefined;
    readonly link_status?: "missing" | "retained" | "all" | undefined;
  },
  signal?: AbortSignal,
) => {
  return withBundleReadResources(
    async (resources) => {
      const loaded = await readEvidenceBundle(
        input.path,
        signal,
        resources,
        "get_evidence_bundle",
      );
      return loaded.ok ? inspectEvidenceBundle(loaded.value, input) : loaded;
    },
    "get_evidence_bundle",
    signal,
  );
};

/** Final read cleanup retries the exact leases already bound to a failed read. */
const withBundleReadResources = async <Value extends JsonValue>(
  read: (
    resources: ArtifactResourceScope,
  ) => Promise<Result<Value, AnalysisError>>,
  operation: string,
  signal?: AbortSignal,
): Promise<Result<Value, AnalysisError>> => {
  const resources = new ArtifactResourceScope();
  let readFailed = false;
  return finalizeBundleWork(() => read(resources), {
    providerId: "rea",
    operation,
    signal,
    inspectPrimary: (primary) => {
      readFailed = !primary.ok;
    },
    close: async () => {
      try {
        await resources.close();
      } catch (cause: unknown) {
        // A failed read already owns its retained leases and observes their
        // resolution in place; a retry must not replace that failure. Only
        // a completed read leaves a close failure without another owner.
        if (!readFailed) throw cause;
      } finally {
        await dispatchQueuedInterrupts();
      }
    },
    fallbackResource: `${operation} bundle read resources`,
    diagnostics: (value) => ({ completed_result: value }),
  });
};

/**
 * Finalize bundle work through runOwned. An unexpected throw is a defect the
 * adapters report as such, so it is rethrown after cleanup instead of being
 * typed as a provider failure.
 */
const finalizeBundleWork = async <Value>(
  work: () => Promise<Result<Value, AnalysisError>>,
  options: RunOwnedOptions<Value>,
): Promise<Result<Value, AnalysisError>> => {
  let defect: { readonly cause: unknown } | undefined;
  const finalized = await runOwned(async () => {
    try {
      return await work();
    } catch (cause: unknown) {
      defect = { cause };
      throw cause;
    }
  }, options);
  if (defect !== undefined) throw defect.cause;
  return finalizedResult(finalized);
};
