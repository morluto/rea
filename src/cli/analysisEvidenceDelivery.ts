import { recordCliEvidencePublication } from "./cliEvidencePublication.js";
import { analysisEvidenceSources } from "../application/AnalysisEvidenceSources.js";
import type { AnalysisViewRequest } from "../domain/analysisView/analysisView.js";
import { z } from "incur";
import {
  parseEvidence,
  tryParseEvidence,
  withEvidenceCallerInputPath,
  type Evidence,
} from "../domain/evidence.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { redactExplicitFailure } from "../domain/explicitSensitiveFailure.js";
import { err, ok, type Result } from "../domain/result.js";
import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import { createEvidenceBundle } from "../domain/evidenceBundle.js";
import { publishEvidenceDelivery } from "../application/EvidenceBundleCommands.js";
import { inspectAnalysisViewValidated } from "../application/analysisView/AnalysisViewService.js";
import { localPathStringSchema } from "../domain/localPath.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import { finishAnalysisCommand } from "./finishAnalysisCommand.js";
import { projectCliAnalysisResult } from "./projectCliAnalysisResult.js";
import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";
import type { ZodSafeParseResult } from "zod";
import { bindCliEvidenceCallerPath } from "./cliEvidenceCallerPath.js";

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
  let view: unknown;
  try {
    view = options.view === undefined ? undefined : JSON.parse(options.view);
  } catch (cause) {
    return err(
      new AnalysisInputError(operation, { cause }, [
        {
          path: ["view"],
          reason: "invalid_format",
          message: "view must be valid JSON",
        },
      ]),
    );
  }
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
      : bindCliEvidenceCallerPath(input.callerInputPath, run),
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

const extractPartialEvidence = (
  failure: JsonValue,
):
  | {
      errorRecord: { [key: string]: JsonValue };
      partialEvidence: Evidence;
    }
  | undefined => {
  if (typeof failure !== "object" || failure === null || Array.isArray(failure))
    return undefined;
  const errorRecord = failure as { [key: string]: JsonValue };
  const details =
    typeof errorRecord.details === "object" &&
    errorRecord.details !== null &&
    !Array.isArray(errorRecord.details)
      ? (errorRecord.details as { [key: string]: JsonValue })
      : undefined;
  if (details?.partial_observation === undefined) return undefined;
  const partialEvidence = tryParseEvidence(details.partial_observation);
  return partialEvidence === undefined
    ? undefined
    : { errorRecord, partialEvidence };
};

const formatEvidenceBundleReceipt = (
  bundle: { readonly path: string; readonly bytes: number },
  sensitiveValues?: readonly string[],
): { readonly path?: string; readonly bytes: number } => ({
  ...(sensitiveValues?.some(
    (literal) => literal !== "" && bundle.path.includes(literal),
  )
    ? {}
    : { path: bundle.path }),
  bytes: bundle.bytes,
});

const committedReceiptFromError = (
  error: unknown,
): { readonly path: string; readonly bytes: number } | undefined => {
  if (
    typeof error === "object" &&
    error !== null &&
    "diagnostics" in error &&
    typeof (error as Record<string, unknown>).diagnostics === "object" &&
    (error as Record<string, unknown>).diagnostics !== null &&
    "evidence_bundle" in
      ((error as Record<string, unknown>).diagnostics as Record<
        string,
        unknown
      >)
  ) {
    const raw = (
      (error as Record<string, unknown>).diagnostics as Record<string, unknown>
    ).evidence_bundle;
    if (
      typeof raw === "object" &&
      raw !== null &&
      "path" in raw &&
      typeof (raw as Record<string, unknown>).path === "string" &&
      "bytes" in raw &&
      typeof (raw as Record<string, unknown>).bytes === "number"
    )
      return {
        path: (raw as Record<string, unknown>).path as string,
        bytes: (raw as Record<string, unknown>).bytes as number,
      };
  }
  return undefined;
};

const sanitizeSaveError = (
  error: AnalysisError,
  sensitiveValues?: readonly string[],
): JsonValue => {
  const rawSaveError = projectAnalysisError(
    redactExplicitFailure(error, sensitiveValues ?? []),
  );
  if (
    rawSaveError.details !== undefined &&
    typeof rawSaveError.details === "object" &&
    rawSaveError.details !== null &&
    "partial_observation" in rawSaveError.details
  ) {
    const { partial_observation: _, ...restDetails } =
      rawSaveError.details as Record<string, JsonValue>;
    return {
      ...rawSaveError,
      details: restDetails,
    };
  }
  return rawSaveError;
};

const publishPartialCliAnalysisEvidence = async (
  failure: JsonValue,
  input: CliEvidenceDelivery,
): Promise<JsonValue> => {
  const { operation, signal, detail, evidenceOutput } = input;
  if (evidenceOutput === undefined) return failure;
  const extracted = extractPartialEvidence(failure);
  if (extracted === undefined) return failure;
  const { errorRecord, partialEvidence } = extracted;

  const delivered =
    detail === "summary"
      ? inspectAnalysisViewValidated({
          source: { kind: "inline", evidence: partialEvidence },
          view: input.view ?? { kind: "summary" },
        })
      : ok(partialEvidence);
  const selected =
    detail === "summary" &&
    partialEvidence.caller_input_path !== undefined &&
    delivered.ok
      ? withEvidenceCallerInputPath(
          delivered.value,
          partialEvidence.caller_input_path,
        )
      : delivered.ok
        ? delivered.value
        : partialEvidence;
  const inspectionSources = analysisEvidenceSources(partialEvidence);
  if (!inspectionSources.ok) return failure;
  const published = await publishEvidenceDelivery({
    bundle: createEvidenceBundle([
      ...new Map(
        [...(input.sourceEvidence ?? []), ...inspectionSources.value].map(
          (record) => [record.evidence_id, record],
        ),
      ).values(),
    ]),
    complete: partialEvidence,
    delivered: selected,
    outputPath: absoluteCallerPath(evidenceOutput),
    operation,
    signal,
  });
  if (!published.ok) {
    const saveError = sanitizeSaveError(published.error, input.sensitiveValues);
    const committedRaw = committedReceiptFromError(published.error);
    const committedReceipt =
      committedRaw !== undefined
        ? formatEvidenceBundleReceipt(committedRaw, input.sensitiveValues)
        : undefined;
    const updatedDetails: { [key: string]: JsonValue } = {
      ...(errorRecord.details as { [key: string]: JsonValue }),
      publication_error: saveError,
      ...(committedReceipt !== undefined
        ? { evidence_bundle: committedReceipt }
        : {}),
    };
    return {
      ...errorRecord,
      details: updatedDetails,
    };
  }
  const receipt = formatEvidenceBundleReceipt(
    published.value.evidenceBundle,
    input.sensitiveValues,
  );
  recordCliEvidencePublication(receipt);
  const updatedDetails: { [key: string]: JsonValue } = {
    ...(errorRecord.details as { [key: string]: JsonValue }),
    evidence_bundle: receipt,
  };
  if (detail === "summary" && delivered.ok) {
    updatedDetails.partial_observation = selected;
  }
  return {
    ...errorRecord,
    details: updatedDetails,
  };
};

/** Publish already finalized CLI analysis without opening a second provider/session. */
export const publishCliAnalysisEvidence = async (
  result: Result<Evidence, JsonValue>,
  input: CliEvidenceDelivery,
): Promise<JsonValue> => {
  const { operation, signal, detail, evidenceOutput } = input;
  const projectFailure = (error: AnalysisError) =>
    projectAnalysisError(
      redactExplicitFailure(error, input.sensitiveValues ?? []),
    );
  if (!result.ok) return publishPartialCliAnalysisEvidence(result.error, input);
  const complete = parseEvidence(result.value);
  const inputError = cliEvidenceDeliveryInputError(input);
  if (inputError !== undefined) {
    inputError.retainPartialObservation(complete);
    return projectFailure(inputError);
  }
  if (evidenceOutput === undefined) return complete;
  // Project before publication so a view failure cannot commit an
  // unreported bundle; publication then owns every post-commit outcome.
  const delivered =
    detail === "summary"
      ? inspectAnalysisViewValidated({
          source: { kind: "inline", evidence: complete },
          view: input.view ?? { kind: "summary" },
        })
      : ok(complete);
  if (!delivered.ok)
    return projectFailure(delivered.error.retainPartialObservation(complete));
  // This projection answers the same direct invocation as its parent. Later
  // inspect_analysis_view calls own their own input and do not inherit it.
  const selected =
    detail === "summary" && complete.caller_input_path !== undefined
      ? withEvidenceCallerInputPath(delivered.value, complete.caller_input_path)
      : delivered.value;
  const inspectionSources = analysisEvidenceSources(complete);
  if (!inspectionSources.ok) return projectFailure(inspectionSources.error);
  const published = await publishEvidenceDelivery({
    bundle: createEvidenceBundle([
      ...new Map(
        [...(input.sourceEvidence ?? []), ...inspectionSources.value].map(
          (record) => [record.evidence_id, record],
        ),
      ).values(),
    ]),
    complete,
    delivered: selected,
    outputPath: absoluteCallerPath(evidenceOutput),
    operation,
    signal,
  });
  if (!published.ok) return projectFailure(published.error);
  const receipt = formatEvidenceBundleReceipt(
    published.value.evidenceBundle,
    input.sensitiveValues,
  );
  recordCliEvidencePublication(receipt);
  return detail === "summary"
    ? { summary: published.value.delivered, evidence_bundle: receipt }
    : published.value.delivered;
};
