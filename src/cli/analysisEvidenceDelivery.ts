import { explicitValuesOccurIn } from "../domain/explicitSensitiveValues.js";
import {
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
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { redactExplicitFailure } from "../domain/explicitSensitiveFailure.js";
import { err, ok, type Result } from "../domain/result.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import {
  cliEvidenceDeliveryInputError,
  type CliDeliveryDetail,
} from "./analysisEvidenceDeliveryOptions.js";
import {
  agentBudgetDelivery,
  agentBudgetOverflowBytes,
  currentAgentResultBudget,
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
      ? result.error
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
  if (evidenceOutput === undefined) {
    if (overBudget === undefined) return complete;
    const summary = await overBudgetSummary(complete);
    return summary === undefined
      ? complete
      : {
          summary,
          delivery: deliveryJson(overBudget({ kind: "not-retained" })),
        };
  }
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
): ((recovery: AgentBudgetRecovery) => AgentBudgetDelivery) | undefined => {
  if (input.detail !== undefined) return undefined;
  const budget = currentAgentResultBudget(
    cliPublicationInvocation().agentBudgetSeed,
  );
  if (budget === undefined) return undefined;
  const completeBytes = agentBudgetOverflowBytes(complete, budget);
  return completeBytes === undefined
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

/**
 * Project the requested view, then publish the complete bundle. Projection
 * runs first so a view failure cannot commit an unreported bundle;
 * publication then owns every post-commit outcome. An over-budget delivery
 * publishes its summary when the operation has one, and complete Evidence
 * otherwise.
 */
const publishDeliveredEvidence = async (
  complete: Evidence,
  evidenceOutput: string,
  input: CliEvidencePublication,
  overBudget = false,
): Promise<
  Result<
    {
      readonly delivered: Evidence;
      readonly receipt: JsonValue;
      /** Whether `delivered` is a summary of the published complete record. */
      readonly summarized: boolean;
      /** Whether that summary replaced over-budget complete Evidence. */
      readonly budgeted: boolean;
    },
    {
      readonly error: AnalysisError;
      readonly committed: boolean;
      /** The projected view, once projection succeeded. */
      readonly delivered?: Evidence;
    }
  >
> => {
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
    { evidenceDeliveryCommitted, publishEvidenceDelivery },
  ] = await Promise.all([
    import("../application/AnalysisEvidenceSources.js"),
    import("../domain/evidenceBundle.js"),
    import("../application/EvidenceBundleCommands.js"),
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
  const published = await publishEvidenceDelivery({
    bundle,
    complete,
    delivered: selected,
    outputPath: absoluteCallerPath(evidenceOutput),
    operation: input.operation,
    signal: input.signal,
  });
  if (!published.ok)
    return err({
      error: published.error,
      committed: evidenceDeliveryCommitted(published.error),
      delivered: selected,
    });
  const { path, bytes } = published.value.evidenceBundle;
  const receipt = bundleReceipt(path, bytes, input);
  recordCliEvidencePublication(receipt);
  return ok({
    delivered: published.value.delivered,
    receipt,
    summarized,
    budgeted: budgeted !== undefined,
  });
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
  const published = await publishDeliveredEvidence(
    partial,
    evidenceOutput,
    input,
  );
  if (!published.ok) {
    const refusal = refusedPartialPublication(
      failure,
      details,
      published.error,
      input,
    );
    return published.error.committed
      ? refusal
      : withUndeliveredSourceClosure(refusal, input);
  }
  return {
    ...failure,
    details: {
      ...details,
      partial_observation: published.value.delivered,
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
): JsonValue => {
  const diagnostics = isObject(details.diagnostics) ? details.diagnostics : {};
  const refusal = projectAnalysisError(
    redactExplicitFailure(refused.error, input.sensitiveValues ?? []),
  );
  const refusalDetails: JsonObject = isObject(refusal.details)
    ? refusal.details
    : {};
  const receipt = committedReceipt(refusalDetails, input);
  const cleanupIncomplete = refusalDetails.cleanup === "incomplete";
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
        : { partial_observation: refused.delivered }),
      diagnostics: {
        ...diagnostics,
        ...(receipt === undefined ? {} : { evidence_bundle: receipt }),
        evidence_bundle_error: {
          code: refusal.code,
          message: refusal.message,
          limitation:
            receipt === undefined
              ? "The partial Evidence was not published to --evidence_output; it remains complete in details.partial_observation."
              : cleanupIncomplete
                ? "The partial Evidence was published to --evidence_output, but its staging cleanup remains incomplete; details.resources lists what remains."
                : "The partial Evidence was published to --evidence_output before delivery stopped.",
        },
      },
    },
  };
};

/** Either committed receipt form, as {path, bytes}. */
const committedReceipt = (
  refusalDetails: JsonObject,
  input: CliEvidencePublication,
): JsonValue | undefined => {
  if (refusalDetails.published === true && refusalDetails.bytes !== undefined)
    return bundleReceipt(
      typeof refusalDetails.published_path === "string"
        ? refusalDetails.published_path
        : undefined,
      refusalDetails.bytes,
      input,
    );
  const later = isObject(refusalDetails.diagnostics)
    ? refusalDetails.diagnostics.evidence_bundle
    : undefined;
  return isObject(later)
    ? bundleReceipt(
        typeof later.path === "string" ? later.path : undefined,
        later.bytes ?? null,
        input,
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
