import {
  explicitValuesOccurIn,
  redactExplicitText,
} from "../domain/explicitSensitiveValues.js";
import {
  clearCliEvidencePublication,
  cliPublicationInvocation,
  recordCliEvidencePublication,
} from "./cliEvidencePublication.js";
import { recordCliDeliveredEvidence } from "./cliResultControls.js";
import type { AnalysisViewRequest } from "../domain/analysisView/analysisViewRequest.js";
import {
  isImmutableEvidence,
  parseEvidence,
  withEvidenceCallerInputPath,
  type Evidence,
  type CallerInputPaths,
} from "../domain/evidence.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { EvidenceBundle } from "../domain/evidenceBundle.js";
import { errorMessage } from "../kernel/errorMessage.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { redactExplicitFailure } from "../domain/explicitSensitiveFailure.js";
import { err, ok, type Result } from "../domain/result.js";
import { EvidenceFileError } from "../domain/evidenceErrors.js";
import type { RetentionStop } from "./cliEvidenceRetention.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import {
  cliEvidenceDeliveryInputError,
  type CliDeliveryDetail,
} from "./analysisEvidenceDeliveryOptions.js";
import {
  agentBudgetDelivery,
  budgetedSummaryBytes,
  currentAgentResultBudget,
  failureEnvelopeBytes,
  PARTIAL_OBSERVATION_DELIVERY,
  type AgentBudgetDelivery,
  type AgentBudgetRecovery,
} from "../domain/agentResultBudget.js";
import { finishAnalysisCommand } from "./finishAnalysisCommand.js";
import {
  isObject,
  projectCliAnalysisResult,
} from "./projectCliAnalysisResult.js";
import { bindCliEvidenceCallerPath } from "./cliEvidenceCallerPath.js";
import type { AnalysisResultWithSources } from "../application/investigation/recordEvidenceSources.js";

/** How one CLI invocation publishes its Evidence. */
interface CliEvidencePublication {
  readonly view?: AnalysisViewRequest;
  readonly operation: string;
  readonly signal: AbortSignal;
  /** Undefined leaves delivery to the agent result budget. */
  readonly detail: CliDeliveryDetail;
  readonly evidenceOutput: string | undefined;
  /** Exact one-shot CLI target spelling, when this invocation selects a file. */
  readonly callerInputPath?: string;
  /** Verbatim named auxiliary path choices for the same direct invocation. */
  readonly callerInputPaths?: CallerInputPaths;
  /** Derived workflows publish their selected source closure with the result. */
  readonly sourceEvidence?: readonly Evidence[];
  /** Invocation exclusions cover final cleanup and publication paths/diagnostics. */
  readonly sensitiveValues?: readonly string[];
  /**
   * False when a rerun would not reproduce the result, as for a
   * non-idempotent extraction: an over-budget result the cache cannot keep
   * is then delivered complete instead of pointing at a rerun.
   */
  readonly rerunRecoversResult?: boolean;
}

/** A one-shot run whose provider cleanup the delivery finishes before publishing. */
interface CliEvidenceDelivery extends CliEvidencePublication {
  readonly providerId: string;
}

/** One-shot delivery owns report publication; analysis keeps its own cleanup owner. */
export const deliverCliAnalysisEvidence = async (
  input: CliEvidenceDelivery & {
    readonly run: () => Promise<Result<Evidence, AnalysisError>>;
    readonly service: { close(): Promise<void> };
  },
) => {
  const {
    run,
    service,
    providerId,
    operation,
    signal,
    detail,
    evidenceOutput,
  } = input;
  const redactFailure = (error: AnalysisError) =>
    redactExplicitFailure(error, input.sensitiveValues ?? []);
  const inputError = cliEvidenceDeliveryInputError(input);
  if (inputError !== undefined)
    return finishAnalysisCommand(
      async () => ({ ok: false, error: inputError }),
      service,
      providerId,
      operation,
      signal,
      undefined,
      { redactFailure },
    ).then(projectCliAnalysisResult);
  const callerInputPath =
    input.callerInputPath === undefined ||
    revealsSensitiveValue(input.callerInputPath, input)
      ? undefined
      : input.callerInputPath;
  const callerInputPaths = safeCallerInputPaths(input);
  const complete = await finishAnalysisCommand(
    callerInputPath === undefined && callerInputPaths === undefined
      ? run
      : bindCliEvidenceCallerPath(callerInputPath, run, callerInputPaths),
    service,
    providerId,
    operation,
    signal,
    undefined,
    { redactFailure },
  );
  return publishCliAnalysisEvidence(complete, {
    operation,
    signal,
    detail,
    evidenceOutput,
    ...(input.sensitiveValues === undefined
      ? {}
      : { sensitiveValues: input.sensitiveValues }),
    ...(input.view === undefined ? {} : { view: input.view }),
    ...(input.sourceEvidence === undefined
      ? {}
      : { sourceEvidence: input.sourceEvidence }),
  });
};

/**
 * A requested bundle that never committed cannot silently drop what a completed
 * observation cites. Absent delivery or observation leaves the failure untouched.
 */
const withUndeliveredSourceClosure = async (
  failure: JsonValue,
  input: CliEvidencePublication,
): Promise<JsonValue> => {
  if (input.evidenceOutput === undefined || !isObject(failure)) return failure;
  const { details } = failure;
  if (!isObject(details) || details.partial_observation === undefined)
    return failure;
  const { undeliveredSourceClosure } =
    await import("../application/AnalysisEvidenceSources.js");
  const closure = undeliveredSourceClosure(
    details.partial_observation,
    input.sourceEvidence ?? [],
    // Error output is not the caller's selected Evidence sink. Keep records
    // out of it when this invocation carries explicit exclusions.
    { inlineRecords: (input.sensitiveValues?.length ?? 0) === 0 },
  );
  return closure === undefined
    ? failure
    : { ...failure, details: { ...details, source_closure: closure } };
};

/** Publish already finalized CLI analysis without opening a second provider/session. */
export const publishCliAnalysisEvidence = async (
  result: AnalysisResultWithSources<Evidence, JsonValue>,
  input: CliEvidencePublication,
): Promise<JsonValue> => {
  const { detail, evidenceOutput } = input;
  // A composed result can retain source records separately from its parent.
  // Both successful and partial publication use that same captured closure.
  const capturedSources = [
    ...(input.sourceEvidence ?? []),
    ...(result.sourceEvidence ?? []),
  ];
  const closureInput =
    capturedSources.length === 0
      ? input
      : { ...input, sourceEvidence: capturedSources };
  const projectFailure = (error: AnalysisError) =>
    projectAnalysisError(
      redactExplicitFailure(error, input.sensitiveValues ?? []),
    );
  if (!result.ok)
    return evidenceOutput === undefined
      ? budgetFailurePartialEvidence(result.error, closureInput)
      : publishFailurePartialEvidence(
          result.error,
          evidenceOutput,
          closureInput,
        );
  const complete = parseEvidence(result.value);
  // A summary delivery wraps the view; controls are read from this Evidence.
  recordCliDeliveredEvidence(complete);
  const inputError = cliEvidenceDeliveryInputError(input);
  if (inputError !== undefined) {
    inputError.retainPartialObservation(complete);
    return projectFailure(inputError);
  }
  const overBudget = budgetDelivery(complete, input);
  if (evidenceOutput === undefined)
    return overBudget === undefined
      ? complete
      : deliverRetainedSummary(
          complete,
          closureInput,
          overBudget,
          projectFailure,
        );
  const outputPath = absoluteCallerPath(evidenceOutput);
  const published = await publishDeliveredEvidence(
    complete,
    evidenceOutput,
    closureInput,
    overBudget !== undefined,
  );
  if (!published.ok) {
    const failure = projectFailure(published.error.error);
    return published.error.committed
      ? failure
      : withUndeliveredSourceClosure(failure, closureInput);
  }
  const delivery =
    published.value.budgeted && overBudget !== undefined
      ? overBudget({
          kind: "evidence-file",
          path: revealsSensitiveValue(outputPath, input)
            ? undefined
            : outputPath,
        })
      : undefined;
  return published.value.summarized
    ? {
        summary: published.value.delivered,
        evidence_bundle: published.value.receipt,
        ...(delivery === undefined ? {} : { delivery: deliveryJson(delivery) }),
      }
    : published.value.delivered;
};

/**
 * An over-budget result without --evidence_output: its summary, with the
 * complete Evidence kept in the private cache when that is on, and the
 * rerun arguments otherwise. An operation without a summary view keeps
 * complete delivery, as does one whose rerun would not reproduce it when
 * the cache does not keep it.
 */
const deliverRetainedSummary = async (
  complete: Evidence,
  input: CliEvidencePublication,
  overBudget: (recovery: AgentBudgetRecovery) => AgentBudgetDelivery,
  projectFailure: (error: AnalysisError) => JsonValue,
): Promise<JsonValue> => {
  const summary = await overBudgetSummary(complete);
  if (summary === undefined) return complete;
  const retained = await retainOverBudgetEvidence(
    complete,
    input,
    overBudget({ kind: "not-retained" }).complete_bytes,
  );
  // Either the file committed before a later failure, or staging cleanup
  // stayed incomplete before commit: report that failure and cleanup owner.
  if (retained?.ok === false && retained.error.reportError !== undefined)
    return projectFailure(retained.error.reportError);
  if (retained?.ok !== true && input.rerunRecoversResult === false)
    return complete;
  return retained?.ok === true
    ? {
        summary,
        evidence_bundle: retained.value.receipt,
        delivery: cacheFileDelivery(overBudget, retained.value),
      }
    : {
        summary,
        delivery: notRetainedDelivery(
          overBudget,
          retained?.error.reason,
          input,
        ),
      };
};

/** Delivery facts when an over-budget record sits in the private cache. */
const cacheFileDelivery = (
  overBudget: (recovery: AgentBudgetRecovery) => AgentBudgetDelivery,
  retained: {
    readonly path: string | undefined;
    readonly retentionFailure?: string;
  },
): JsonValue =>
  deliveryJson(
    overBudget({
      kind: "cache-file",
      path: retained.path,
      ...(retained.retentionFailure === undefined
        ? {}
        : { reason: retained.retentionFailure }),
    }),
  );

/** Delivery facts when an over-budget record was not kept in the cache. */
const notRetainedDelivery = (
  overBudget: (recovery: AgentBudgetRecovery) => AgentBudgetDelivery,
  reason: string | undefined,
  input: Pick<CliEvidencePublication, "sensitiveValues">,
): JsonValue =>
  deliveryJson(
    overBudget({
      kind: "not-retained",
      ...(reason === undefined
        ? {}
        : {
            reason: redactExplicitText(reason, input.sensitiveValues ?? []),
          }),
    }),
  );

/**
 * Keep an over-budget result this invocation was not told to save in the
 * private retained-Evidence cache, so it pages without a rerun. Undefined
 * when retention is off (--no-retain, or the setting is 0); a failure says
 * why, and the result falls back to the rerun arguments unless the writer
 * committed or left incomplete staging cleanup.
 */
const retainOverBudgetEvidence = async (
  complete: Evidence,
  input: CliEvidencePublication,
  completeBytes: number,
): Promise<
  | Result<
      {
        readonly path: string | undefined;
        readonly receipt: JsonValue;
        /** Set when an oversized bundle stayed on disk after removal failed. */
        readonly retentionFailure?: string;
      },
      {
        readonly reason: string;
        readonly reportError?: AnalysisError;
        readonly committed?: boolean;
        readonly committedPath?: string;
        readonly recordSha256?: string;
      }
    >
  | undefined
> => {
  const { retention } = cliPublicationInvocation();
  if (retention === undefined) return undefined;
  const sensitiveCachePathReason =
    "The retained-Evidence cache path contains a value marked sensitive, so nothing was retained.";
  // A cache under a path that holds a value marked sensitive is never used,
  // so neither its path nor a failure naming it reaches the output.
  if (revealsSensitiveValue(retention.directory, input))
    return err({ reason: sensitiveCachePathReason });
  const {
    retainCliEvidence,
    retainedEvidenceDigest,
    retainedEvidenceBundleDigest,
  } = await import("./cliEvidenceRetention.js");
  let prepared: PreparedCliEvidence;
  let recordSha256: string;
  let cacheKey: string;
  try {
    const projected = await prepareDeliveredEvidence(complete, input, true);
    if (!projected.ok) {
      clearCliEvidencePublication();
      return err({
        reason: redactExplicitText(
          projected.error.error.message,
          input.sensitiveValues ?? [],
        ),
      });
    }
    prepared = projected.value;
    recordSha256 = retainedEvidenceDigest(complete);
    cacheKey = retainedEvidenceBundleDigest(prepared.bundle);
  } catch (cause: unknown) {
    clearCliEvidencePublication();
    return err({
      reason: redactExplicitText(
        "The retained-Evidence cache could not be used: " + errorMessage(cause),
        input.sensitiveValues ?? [],
      ),
    });
  }
  let attemptedPath: string | undefined;
  const kept = await retainCliEvidence<AnalysisError>({
    cacheKey,
    completeBytes,
    retention,
    rejectResolvedDirectory: (resolved) =>
      revealsSensitiveValue(resolved, input)
        ? sensitiveCachePathReason
        : undefined,
    write: async (path) => {
      attemptedPath = path;
      // The bundle writer creates the file exclusively and never overwrites.
      const published = await publishPreparedEvidence(prepared, path, input);
      if (published.ok) {
        const { bytes } = published.value.receipt as { readonly bytes: number };
        return ok({ bytes });
      }
      const { error, committed } = published.error;
      if (
        error instanceof EvidenceFileError &&
        error.reason === "exists" &&
        !error.cleanupIncomplete
      )
        return err("exists");
      return err({
        reason: redactExplicitText(error.message, input.sensitiveValues ?? []),
        ...(committed
          ? { committed: error }
          : error.cleanupIncomplete
            ? { cleanupIncomplete: error }
            : {}),
      });
    },
  });
  const cacheReceipt = (path: string, bytes: number) => ({
    ...bundleReceipt(path, bytes, input),
    // The parent record digest is independent of the complete bundle's cache key.
    record_sha256: recordSha256,
  });
  if (!kept.ok) {
    const redactedReason = redactExplicitText(
      kept.error.reason,
      input.sensitiveValues ?? [],
    );
    // An oversized bundle whose post-write removal failed still survives on
    // disk: report its receipt, paging cursor, and the removal failure.
    if (
      kept.error.fileRemains === true &&
      kept.error.remainingFile !== undefined
    ) {
      const receipt = cacheReceipt(
        kept.error.remainingFile.path,
        kept.error.remainingFile.bytes,
      );
      recordCliEvidencePublication(receipt);
      return ok({
        path: receipt.path,
        receipt,
        retentionFailure: redactedReason,
      });
    }
    // Clear the recorded receipt whenever no published file remains on disk.
    if (kept.error.committed === undefined && kept.error.fileRemains !== true)
      clearCliEvidencePublication();
    if (kept.error.committed !== undefined)
      return err({
        reason: redactedReason,
        reportError: kept.error.committed,
        committed: true,
        ...(attemptedPath === undefined
          ? {}
          : { committedPath: attemptedPath }),
        recordSha256,
      });
    if (kept.error.cleanupIncomplete !== undefined)
      return err({
        reason: redactedReason,
        reportError: kept.error.cleanupIncomplete,
        committed: false,
      });
    return err({ reason: redactedReason });
  }
  const receipt = cacheReceipt(kept.value.path, kept.value.bytes);
  recordCliEvidencePublication(receipt);
  return ok({ path: receipt.path, receipt });
};

/** Delivery facts are plain JSON by construction. */
const deliveryJson = (delivery: AgentBudgetDelivery): JsonValue =>
  delivery as unknown as JsonValue;

/**
 * For a caller that left `--detail` to the agent result budget, the
 * delivery facts an over-budget result carries for each place the complete
 * Evidence can be; undefined when complete Evidence fits or was chosen.
 */
const budgetDelivery = (
  complete: Evidence,
  input: CliEvidencePublication,
  /** Bytes of the failure that carries `complete` as its partial observation. */
  envelopeBytes?: number,
): ((recovery: AgentBudgetRecovery) => AgentBudgetDelivery) | undefined => {
  const invocation = cliPublicationInvocation();
  // An explicit --filter-output selects fields directly from the command's
  // Evidence; replacing it with {summary, delivery} would drop those paths.
  if (invocation.hasFilterOutput === true) return undefined;
  const budget = currentAgentResultBudget(invocation.agentBudgetSeed);
  // The one-shot CLI can always publish and page the complete record: with
  // --evidence_output through the bundle, without it by a rerun.
  const completeBytes = budgetedSummaryBytes({
    detail: input.detail,
    evidence: complete,
    budget,
    retained: true,
    pageable: true,
    ...(envelopeBytes === undefined ? {} : { envelopeBytes }),
  });
  return completeBytes === undefined || budget === undefined
    ? undefined
    : (recovery) =>
        agentBudgetDelivery({
          operation: complete.operation,
          evidenceId: complete.evidence_id,
          completeBytes,
          budget,
          recovery,
        });
};

/** A failure's partial observation, when it is complete Evidence. */
const failurePartialEvidence = (
  failure: JsonValue,
): { readonly failure: JsonObject; readonly partial: Evidence } | undefined => {
  if (
    !isObject(failure) ||
    !isObject(failure.details) ||
    failure.details.partial_observation === undefined
  )
    return undefined;
  try {
    return {
      failure,
      partial: parseEvidence(failure.details.partial_observation),
    };
  } catch {
    return undefined;
  }
};

/**
 * Without --evidence_output, a failure whose partial Evidence does not fit
 * the agent result budget beside its own facts delivers that Evidence's
 * summary. Complete partial Evidence is retained in the private cache when
 * retention is enabled (reporting path, bytes and record_sha256 under
 * details.diagnostics.evidence_bundle), and falls back to the rerun arguments
 * when retention is off or fails. Cancellation keeps its no-publication
 * contract, and the failure's code, retry and recovery are never budgeted.
 */
const budgetFailurePartialEvidence = async (
  failure: JsonValue,
  input: CliEvidencePublication,
): Promise<JsonValue> => {
  const found = failurePartialEvidence(failure);
  if (found === undefined) return failure;
  // Controls are read from the complete partial Evidence of this operation,
  // since its summary may replace it.
  if (found.partial.operation === input.operation)
    recordCliDeliveredEvidence(found.partial);
  const overBudget = budgetDelivery(
    found.partial,
    input,
    failureEnvelopeBytes(found.failure),
  );
  if (overBudget === undefined) return failure;
  const summary = await overBudgetSummary(found.partial);
  if (summary === undefined) return failure;
  const details = found.failure.details as JsonObject;
  // Cancellation keeps its no-publication contract: budget the reply without
  // writing to or renewing the retained-Evidence cache.
  const retained =
    input.signal.aborted || found.failure.code === "cancelled"
      ? undefined
      : await retainOverBudgetEvidence(
          found.partial,
          input,
          overBudget({ kind: "not-retained" }).complete_bytes,
        );
  // Either the cache file committed before a later failure, or staging
  // cleanup stayed incomplete before commit: preserve the original analysis
  // failure and report the committed receipt or remaining cleanup owner.
  if (retained?.ok === false && retained.error.reportError !== undefined) {
    const committedPath =
      retained.error.committed === true &&
      retained.error.committedPath !== undefined &&
      !revealsSensitiveValue(retained.error.committedPath, input)
        ? retained.error.committedPath
        : undefined;
    return refusedPartialPublication(
      found.failure,
      details,
      { error: retained.error.reportError, delivered: summary },
      input,
      retained.error.committed === true
        ? deliveryJson(overBudget({ kind: "cache-file", path: committedPath }))
        : undefined,
      { target: "retained-cache", recordSha256: retained.error.recordSha256 },
    );
  }
  if (retained?.ok === true) {
    const diagnostics = isObject(details.diagnostics)
      ? details.diagnostics
      : {};
    return {
      ...found.failure,
      details: {
        ...details,
        partial_observation: summary,
        [PARTIAL_OBSERVATION_DELIVERY]: cacheFileDelivery(
          overBudget,
          retained.value,
        ),
        diagnostics: {
          ...diagnostics,
          evidence_bundle: retained.value.receipt,
        },
      },
    };
  }
  return {
    ...found.failure,
    details: {
      ...details,
      partial_observation: summary,
      [PARTIAL_OBSERVATION_DELIVERY]: notRetainedDelivery(
        overBudget,
        retained?.error.reason,
        input,
      ),
    },
  };
};

/**
 * The summary that replaces over-budget complete Evidence, answering this
 * same invocation; undefined when the operation has no summary view, which
 * keeps complete delivery.
 */
const overBudgetSummary = async (
  complete: Evidence,
): Promise<Evidence | undefined> => {
  const { summarizeOverBudgetEvidence } =
    await import("../application/analysisView/AnalysisViewService.js");
  const summary = summarizeOverBudgetEvidence(complete);
  if (!summary.ok) return undefined;
  return complete.caller_input_path !== undefined ||
    complete.caller_input_paths !== undefined
    ? withEvidenceCallerInputPath(
        summary.value,
        complete.caller_input_path,
        complete.caller_input_paths,
      )
    : summary.value;
};

interface PreparedCliEvidence {
  readonly complete: Evidence;
  readonly delivered: Evidence;
  readonly bundle: EvidenceBundle;
  readonly summarized: boolean;
  readonly budgeted: boolean;
}

interface CliEvidencePublicationFailure {
  readonly error: AnalysisError;
  readonly committed: boolean;
  readonly delivered?: Evidence;
}

/** Resolve the requested projection and exact bundle once before publication. */
const prepareDeliveredEvidence = async (
  complete: Evidence,
  input: CliEvidencePublication,
  overBudget = false,
): Promise<Result<PreparedCliEvidence, CliEvidencePublicationFailure>> => {
  const budgeted = overBudget ? await overBudgetSummary(complete) : undefined;
  const summarized = input.detail === "summary" || budgeted !== undefined;
  const delivered =
    input.detail === "summary"
      ? (
          await import("../application/analysisView/AnalysisViewService.js")
        ).inspectAnalysisViewValidated({
          source: { kind: "inline", evidence: complete },
          view: input.view ?? { kind: "summary" },
        })
      : ok(budgeted ?? complete);
  if (!delivered.ok)
    return err({
      error: delivered.error.retainPartialObservation(complete),
      committed: false,
    });
  // This projection answers the same direct invocation as its parent. Later
  // inspect_analysis_view calls own their own input and do not inherit it.
  const selected =
    input.detail === "summary" &&
    (complete.caller_input_path !== undefined ||
      complete.caller_input_paths !== undefined)
      ? withEvidenceCallerInputPath(
          delivered.value,
          complete.caller_input_path,
          complete.caller_input_paths,
        )
      : delivered.value;
  const [
    { analysisEvidenceSources },
    { createEvidenceBundle, createImmutableEvidenceBundle },
  ] = await Promise.all([
    import("../application/AnalysisEvidenceSources.js"),
    import("../domain/evidenceBundle.js"),
  ]);
  const inspectionSources = analysisEvidenceSources(complete);
  if (!inspectionSources.ok)
    return err({
      error: inspectionSources.error,
      committed: false,
      delivered: selected,
    });
  const records = [
    ...new Map(
      [...(input.sourceEvidence ?? []), ...inspectionSources.value].map(
        (record) => [record.evidence_id, record],
      ),
    ).values(),
  ];
  // Sealed records already carry authentication; mutable producers still need
  // the writer's allocation admission before publication.
  const bundle = records.every(isImmutableEvidence)
    ? createImmutableEvidenceBundle(records)
    : createEvidenceBundle(records);
  return ok({
    complete,
    delivered: selected,
    bundle,
    summarized,
    budgeted: budgeted !== undefined,
  });
};

/** Publish the same prepared bundle whose complete contents select the cache file. */
const publishPreparedEvidence = async (
  prepared: PreparedCliEvidence,
  evidenceOutput: string,
  input: CliEvidencePublication,
): Promise<
  Result<
    {
      readonly delivered: Evidence;
      readonly receipt: JsonValue;
      readonly summarized: boolean;
      readonly budgeted: boolean;
    },
    CliEvidencePublicationFailure
  >
> => {
  const { evidenceDeliveryCommitted, publishEvidenceDelivery } =
    await import("../application/EvidenceBundleCommands.js");
  const published = await publishEvidenceDelivery({
    bundle: prepared.bundle,
    complete: prepared.complete,
    delivered: prepared.delivered,
    outputPath: absoluteCallerPath(evidenceOutput),
    operation: input.operation,
    signal: input.signal,
  });
  if (!published.ok)
    return err({
      error: published.error,
      committed: evidenceDeliveryCommitted(published.error),
      delivered: prepared.delivered,
    });
  const { path, bytes } = published.value.evidenceBundle;
  const receipt = bundleReceipt(path, bytes, input);
  recordCliEvidencePublication(receipt);
  return ok({
    delivered: published.value.delivered,
    receipt,
    summarized: prepared.summarized,
    budgeted: prepared.budgeted,
  });
};

/** Project before committing so a view failure cannot publish an unreported bundle. */
const publishDeliveredEvidence = async (
  complete: Evidence,
  evidenceOutput: string,
  input: CliEvidencePublication,
  overBudget = false,
) => {
  const prepared = await prepareDeliveredEvidence(complete, input, overBudget);
  return prepared.ok
    ? publishPreparedEvidence(prepared.value, evidenceOutput, input)
    : prepared;
};

/** Whether a caller-selected path contains an excluded sensitive literal. */
const revealsSensitiveValue = (
  path: string,
  input: Pick<CliEvidenceDelivery, "sensitiveValues">,
): boolean => explicitValuesOccurIn(path, input.sensitiveValues ?? []);

/**
 * The named caller paths the Evidence may retain: a choice that contains an
 * excluded sensitive literal is omitted whole, so a repeated option never
 * loses its order.
 */
const safeCallerInputPaths = (
  input: Pick<CliEvidenceDelivery, "callerInputPaths" | "sensitiveValues">,
): CallerInputPaths | undefined => {
  if (input.callerInputPaths === undefined) return undefined;
  const kept = Object.entries(input.callerInputPaths).filter(([, value]) =>
    (typeof value === "string" ? [value] : value).every(
      (path) => !revealsSensitiveValue(path, input),
    ),
  );
  return kept.length === 0 ? undefined : Object.fromEntries(kept);
};

/** A receipt omits a path that contains an excluded sensitive literal. */
const bundleReceipt = <Bytes extends JsonValue>(
  path: string | undefined,
  bytes: Bytes,
  input: Pick<CliEvidencePublication, "sensitiveValues">,
): { readonly path?: string; readonly bytes: Bytes } => ({
  ...(path === undefined || revealsSensitiveValue(path, input) ? {} : { path }),
  bytes,
});

/**
 * A failure that carries partial Evidence publishes it to --evidence_output
 * as a successful run would. The failure keeps its code, message and
 * remediation unless publication cleanup remains incomplete; with summary
 * detail, the inline partial observation becomes
 * its summary view, and details.diagnostics.evidence_bundle names the file.
 * Cancellation keeps its no-publication contract, raw provider observations
 * stay inline, and a refused publication keeps the complete partial Evidence
 * inline with details.diagnostics.evidence_bundle_error.
 */
const publishFailurePartialEvidence = async (
  failure: JsonValue,
  evidenceOutput: string,
  input: CliEvidencePublication,
): Promise<JsonValue> => {
  if (
    input.signal.aborted ||
    !isObject(failure) ||
    failure.code === "cancelled" ||
    !isObject(failure.details) ||
    failure.details.partial_observation === undefined
  )
    return withUndeliveredSourceClosure(failure, input);
  const details = failure.details;
  const diagnostics = isObject(details.diagnostics) ? details.diagnostics : {};
  let partial: Evidence;
  try {
    partial = parseEvidence(details.partial_observation);
  } catch {
    return withUndeliveredSourceClosure(failure, input);
  }
  // Publication replaces the inline partial with its delivery; controls
  // are read from the partial Evidence of this operation.
  if (partial.operation === input.operation)
    recordCliDeliveredEvidence(partial);
  // Partial Evidence over the budget left beside the failure's own facts is
  // delivered as its summary, as a successful result's would be.
  const overBudget = budgetDelivery(
    partial,
    input,
    failureEnvelopeBytes(failure),
  );
  const published = await publishDeliveredEvidence(
    partial,
    evidenceOutput,
    input,
    overBudget !== undefined,
  );
  // Where a budgeted summary's complete partial Evidence is: the bundle.
  const outputPath = absoluteCallerPath(evidenceOutput);
  const bundleDelivery = (): JsonValue | undefined =>
    overBudget === undefined
      ? undefined
      : deliveryJson(
          overBudget({
            kind: "evidence-file",
            path: revealsSensitiveValue(outputPath, input)
              ? undefined
              : outputPath,
          }),
        );
  if (!published.ok) {
    // A committed bundle holds the complete partial even when a later step
    // failed, so a summary delivered with it keeps its paging call.
    const summarized =
      published.error.delivered !== undefined &&
      published.error.delivered.evidence_id !== partial.evidence_id;
    const refusal = refusedPartialPublication(
      failure,
      details,
      published.error,
      input,
      summarized ? bundleDelivery() : undefined,
    );
    return published.error.committed
      ? refusal
      : withUndeliveredSourceClosure(refusal, input);
  }
  const delivery = published.value.budgeted ? bundleDelivery() : undefined;
  return {
    ...failure,
    details: {
      ...details,
      partial_observation: published.value.delivered,
      ...(delivery === undefined
        ? {}
        : { [PARTIAL_OBSERVATION_DELIVERY]: delivery }),
      diagnostics: { ...diagnostics, evidence_bundle: published.value.receipt },
    },
  };
};

type JsonObject = { readonly [key: string]: JsonValue };

/**
 * Retain the analysis failure when partial publication is refused. A refusal
 * can follow a commit: cleanup that stays incomplete reports
 * published_path and bytes, and a later cancellation reports
 * diagnostics.evidence_bundle. A committed file gets the same receipt as a
 * published one, and incomplete publication cleanup keeps the details shape
 * of a successful run's cleanup_incomplete outcome. Until cleanup is
 * confirmed, the canonical code and remediation must also reflect the live
 * resource owner, while preserving the original execution failure.
 */
const refusedPartialPublication = (
  failure: JsonObject,
  details: JsonObject,
  refused: { readonly error: AnalysisError; readonly delivered?: Evidence },
  input: CliEvidencePublication,
  /** Delivery facts for a budgeted summary that replaced the partial. */
  delivery?: JsonValue,
  options: {
    readonly target?: "evidence-output" | "retained-cache";
    readonly recordSha256?: string | undefined;
  } = {},
): JsonValue => {
  const diagnostics = isObject(details.diagnostics) ? details.diagnostics : {};
  const refusal = projectAnalysisError(
    redactExplicitFailure(refused.error, input.sensitiveValues ?? []),
  );
  const refusalDetails: JsonObject = isObject(refusal.details)
    ? refusal.details
    : {};
  const receipt = committedReceipt(refusalDetails, input, options.recordSha256);
  const cleanupIncomplete = refusalDetails.cleanup === "incomplete";
  const destination =
    options.target === "retained-cache"
      ? "the retained-Evidence cache"
      : "--evidence_output";
  return {
    ...failure,
    ...(cleanupIncomplete
      ? {
          code: "cleanup_incomplete",
          retryable: false,
          remediation: refusal.remediation,
        }
      : {}),
    details: {
      ...details,
      ...(cleanupIncomplete
        ? {
            ...publicationCleanupDetails(details, refusalDetails),
            execution_failure: details.execution_failure ?? failure.code,
          }
        : {}),
      ...(receipt === undefined || refused.delivered === undefined
        ? {}
        : {
            partial_observation: refused.delivered,
            ...(delivery === undefined
              ? {}
              : { [PARTIAL_OBSERVATION_DELIVERY]: delivery }),
          }),
      diagnostics: {
        ...diagnostics,
        ...(receipt === undefined ? {} : { evidence_bundle: receipt }),
        evidence_bundle_error: {
          code: refusal.code,
          message: refusal.message,
          limitation:
            receipt === undefined
              ? cleanupIncomplete
                ? `The partial Evidence was not published to ${destination} and its staging cleanup remains incomplete; details.resources lists what remains, and it remains complete in details.partial_observation.`
                : `The partial Evidence was not published to ${destination}; it remains complete in details.partial_observation.`
              : cleanupIncomplete
                ? `The partial Evidence was published to ${destination}, but its staging cleanup remains incomplete; details.resources lists what remains.`
                : `The partial Evidence was published to ${destination} before delivery stopped.`,
        },
      },
    },
  };
};

/** Either committed receipt form, as {path, bytes, record_sha256?}. */
const committedReceipt = (
  refusalDetails: JsonObject,
  input: CliEvidencePublication,
  recordSha256?: string,
): JsonObject | undefined => {
  const withDigest = (receipt: {
    readonly path?: string;
    readonly bytes: JsonValue;
  }): JsonObject => ({
    ...receipt,
    ...(recordSha256 === undefined ? {} : { record_sha256: recordSha256 }),
  });
  if (refusalDetails.published === true && refusalDetails.bytes !== undefined)
    return withDigest(
      bundleReceipt(
        typeof refusalDetails.published_path === "string"
          ? refusalDetails.published_path
          : undefined,
        refusalDetails.bytes,
        input,
      ),
    );
  const later = isObject(refusalDetails.diagnostics)
    ? refusalDetails.diagnostics.evidence_bundle
    : undefined;
  return isObject(later)
    ? withDigest(
        bundleReceipt(
          typeof later.path === "string" ? later.path : undefined,
          later.bytes ?? null,
          input,
        ),
      )
    : undefined;
};

/**
 * Publication and cleanup fields of an incomplete-cleanup refusal, in the
 * details shape a successful run reports. Fields the analysis failure already
 * reports are merged: resources are joined and its own reason is kept.
 */
const publicationCleanupDetails = (
  details: JsonObject,
  refusalDetails: JsonObject,
): JsonObject => {
  const keep = (key: string) =>
    refusalDetails[key] === undefined || details[key] !== undefined
      ? {}
      : { [key]: refusalDetails[key] };
  const resources = [
    ...(Array.isArray(details.resources) ? details.resources : []),
    ...(Array.isArray(refusalDetails.resources)
      ? refusalDetails.resources
      : []),
  ];
  return {
    ...keep("published"),
    ...keep("published_path"),
    ...keep("bytes"),
    ...keep("cleanup_reason"),
    ...keep("cleanup_report"),
    cleanup: "incomplete",
    resources,
  };
};
