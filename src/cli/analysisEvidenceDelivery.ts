import { recordCliEvidencePublication } from "./cliEvidencePublication.js";
import {
  analysisEvidenceSources,
  undeliveredSourceClosure,
} from "../application/AnalysisEvidenceSources.js";
import type { AnalysisViewRequest } from "../domain/analysisView/analysisViewRequest.js";
import { z } from "incur";
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
import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import { parseCliJsonOption } from "./cliJsonOption.js";
import {
  createEvidenceBundle,
  createImmutableEvidenceBundle,
} from "../domain/evidenceBundle.js";
import {
  evidenceDeliveryCommitted,
  publishEvidenceDelivery,
} from "../application/EvidenceBundleCommands.js";
import { inspectAnalysisViewValidated } from "../application/analysisView/AnalysisViewService.js";
import { localPathStringSchema } from "../domain/localPath.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import { finishAnalysisCommand } from "./finishAnalysisCommand.js";
import {
  isObject,
  projectCliAnalysisResult,
} from "./projectCliAnalysisResult.js";
import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";
import type { ZodSafeParseResult } from "zod";
import { bindCliEvidenceCallerPath } from "./cliEvidenceCallerPath.js";
import type { AnalysisResultWithSources } from "../application/investigation/recordEvidenceSources.js";

export const analysisEvidenceDeliveryOptions = {
  detail: z
    .enum(["complete", "summary"])
    .default("complete")
    .describe("Deliver complete Evidence, or a summary with --evidence_output"),
  evidence_output: localPathStringSchema
    .optional()
    .describe(
      "Save complete Evidence as a bundle; required for summary delivery. Never overwrites.",
    ),
};

interface CliEvidenceDelivery {
  readonly view?: AnalysisViewRequest;
  readonly providerId: string;
  readonly operation: string;
  readonly signal: AbortSignal;
  readonly detail: "complete" | "summary";
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

export const cliEvidenceDeliveryInputError = (
  input: Pick<CliEvidenceDelivery, "detail" | "evidenceOutput" | "operation">,
): AnalysisInputError | undefined =>
  input.detail === "summary" && input.evidenceOutput === undefined
    ? new AnalysisInputError(input.operation, undefined, [
        {
          path: ["evidence_output"],
          reason: "invalid_value",
          message:
            "Summary delivery requires --evidence_output so complete source Evidence remains available.",
        },
      ])
    : undefined;

/** Parse delivery JSON once and enforce its owning schema before opening a target. */
export const parseCliAnalysisEvidenceDelivery = <
  Delivery extends {
    readonly detail: "complete" | "summary";
    readonly view?: AnalysisViewRequest | undefined;
  },
>(
  operation: string,
  options: {
    readonly detail: "complete" | "summary";
    readonly evidence_output?: string | undefined;
    readonly view?: string | undefined;
  },
  schema: {
    readonly safeParse: (input: unknown) => ZodSafeParseResult<Delivery>;
  },
): Result<
  Delivery & { readonly evidenceOutput: string | undefined },
  AnalysisError
> => {
  const decoded = parseCliJsonOption(
    operation,
    "view",
    options.view,
    "view must be valid JSON",
  );
  if (!decoded.ok) return decoded;
  const view = decoded.value;
  const raw = {
    detail: options.detail,
    ...(view === undefined ? {} : { view }),
  };
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    return err(
      analysisInputErrorFromIssues(operation, parsed.error.issues, raw),
    );
  const value = { ...parsed.data, evidenceOutput: options.evidence_output };
  const invalid = cliEvidenceDeliveryInputError({ ...value, operation });
  return invalid === undefined ? ok(value) : err(invalid);
};

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
  const complete = await finishAnalysisCommand(
    input.callerInputPath === undefined
      ? run
      : bindCliEvidenceCallerPath(
          input.callerInputPath,
          run,
          input.callerInputPaths,
        ),
    service,
    providerId,
    operation,
    signal,
    undefined,
    { redactFailure },
  );
  return publishCliAnalysisEvidence(complete, {
    providerId,
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
const withUndeliveredSourceClosure = (
  failure: JsonValue,
  input: CliEvidenceDelivery,
): JsonValue => {
  if (input.evidenceOutput === undefined || !isObject(failure)) return failure;
  const { details } = failure;
  if (!isObject(details)) return failure;
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
  input: CliEvidenceDelivery,
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
  const inputError = cliEvidenceDeliveryInputError(input);
  if (inputError !== undefined) {
    inputError.retainPartialObservation(complete);
    return projectFailure(inputError);
  }
  if (evidenceOutput === undefined) return complete;
  const published = await publishDeliveredEvidence(
    complete,
    evidenceOutput,
    closureInput,
  );
  if (!published.ok) {
    const failure = projectFailure(published.error.error);
    return evidenceDeliveryCommitted(published.error.error)
      ? failure
      : withUndeliveredSourceClosure(failure, closureInput);
  }
  return detail === "summary"
    ? {
        summary: published.value.delivered,
        evidence_bundle: published.value.receipt,
      }
    : published.value.delivered;
};

/**
 * Project the requested view, then publish the complete bundle. Projection
 * runs first so a view failure cannot commit an unreported bundle;
 * publication then owns every post-commit outcome.
 */
const publishDeliveredEvidence = async (
  complete: Evidence,
  evidenceOutput: string,
  input: CliEvidenceDelivery,
): Promise<
  Result<
    { readonly delivered: Evidence; readonly receipt: JsonValue },
    {
      readonly error: AnalysisError;
      /** The projected view, once projection succeeded. */
      readonly delivered?: Evidence;
    }
  >
> => {
  const delivered =
    input.detail === "summary"
      ? inspectAnalysisViewValidated({
          source: { kind: "inline", evidence: complete },
          view: input.view ?? { kind: "summary" },
        })
      : ok(complete);
  if (!delivered.ok)
    return err({ error: delivered.error.retainPartialObservation(complete) });
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
  const inspectionSources = analysisEvidenceSources(complete);
  if (!inspectionSources.ok)
    return err({ error: inspectionSources.error, delivered: selected });
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
    return err({ error: published.error, delivered: selected });
  const { path, bytes } = published.value.evidenceBundle;
  const receipt = bundleReceipt(path, bytes, input);
  recordCliEvidencePublication(receipt);
  return ok({ delivered: published.value.delivered, receipt });
};

/** A receipt omits a path that contains an excluded sensitive literal. */
const bundleReceipt = <Bytes extends JsonValue>(
  path: string | undefined,
  bytes: Bytes,
  input: Pick<CliEvidenceDelivery, "sensitiveValues">,
): { readonly path?: string; readonly bytes: Bytes } => ({
  ...(path === undefined ||
  input.sensitiveValues?.some(
    (literal) => literal !== "" && path.includes(literal),
  )
    ? {}
    : { path }),
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
  input: CliEvidenceDelivery,
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
    return evidenceDeliveryCommitted(published.error.error)
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
  input: CliEvidenceDelivery,
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
  input: CliEvidenceDelivery,
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
