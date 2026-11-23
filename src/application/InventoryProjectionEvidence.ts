import { unknownTarget } from "../domain/targetIdentity.js";
import { projectAndroidInventory } from "../domain/android/androidApplication.js";
import { projectAppleInventory } from "../domain/apple/appleApplication.js";
import { projectHarmonyInventory } from "../domain/harmony/harmonyApplication.js";
import {
  ANDROID_APPLICATION_PROVIDER,
  APPLE_APPLICATION_PROVIDER,
  HARMONY_APPLICATION_PROVIDER,
} from "../domain/investigationProviders.js";
import {
  resolveEvidenceRequest,
  type EvidenceLookup,
} from "./EvidenceInputResolver.js";
import type { ExecutionOptions } from "../ports/AnalysisProvider.js";
import type { AnalysisInputError } from "../domain/analysisErrorCore.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  createEvidence,
  type Evidence,
  type EvidenceProvider,
  evidenceSubjectInput,
} from "../domain/evidence.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { ParsedInventorySet } from "../domain/artifactInventoryEvidence.js";
import {
  applicationInventoryProjectionInputSchema,
  readApplicationInventoryProjection,
} from "../domain/mobileApplicationGraphProjection.js";
import { ok, type Result } from "../domain/result.js";

interface InventoryProjectionResult {
  readonly root_sha256: string;
  readonly source_evidence_ids: readonly string[];
  readonly limitations: readonly string[];
}

export interface InventoryProjectionEvidenceResult {
  readonly evidence: Evidence;
  readonly sources: readonly Evidence[];
}

interface InventoryProjectionOptions<
  Output extends InventoryProjectionResult & JsonValue,
> {
  readonly rawInput: unknown;
  readonly lookup?: EvidenceLookup;
  readonly execution?: Pick<ExecutionOptions, "signal">;
  readonly project: (
    input: ParsedInventorySet,
  ) => Result<Output, AnalysisInputError>;
  readonly operation: string;
  readonly predicateType: string;
  readonly provider: EvidenceProvider;
}

/** Resolve source inventory once, then wrap its family projection in Evidence. */
export const projectInventoryEvidence = <
  Output extends InventoryProjectionResult & JsonValue,
>(
  options: InventoryProjectionOptions<Output>,
): Result<InventoryProjectionEvidenceResult, AnalysisError> => {
  const request = resolveEvidenceRequest(
    options.operation,
    options.rawInput,
    applicationInventoryProjectionInputSchema,
    options.lookup,
    options.execution,
  );
  if (!request.ok) return request;
  const source = readApplicationInventoryProjection(
    request.value.input,
    options.operation,
  );
  if (!source.ok) return source;
  const projected = options.project(source.value);
  if (!projected.ok) return projected;
  const result = projected.value;
  const first = source.value.evidence[0];
  return ok({
    evidence: createEvidence(
      first === undefined
        ? unknownTarget("derived-from-linked-evidence")
        : evidenceSubjectInput(first.subject),
      options.provider,
      {
        predicateType: options.predicateType,
        operation: options.operation,
        parameters: { inventory_evidence_ids: [...result.source_evidence_ids] },
        result,
        rawResult: null,
        confidence: "inferred",
        authority: "analyst-inference",
        environment: null,
        limitations: result.limitations,
        evidenceLinks: result.source_evidence_ids,
      },
    ),
    sources: source.value.evidence,
  });
};

const createApplicationProjection =
  <Output extends InventoryProjectionResult & JsonValue>(spec: {
    readonly project: (
      input: ParsedInventorySet,
    ) => Result<Output, AnalysisInputError>;
    readonly operation: string;
    readonly predicateType: string;
    readonly provider: EvidenceProvider;
  }) =>
  (
    rawInput: unknown,
    lookup?: EvidenceLookup,
    execution?: Pick<ExecutionOptions, "signal">,
  ): Result<InventoryProjectionEvidenceResult, AnalysisError> =>
    projectInventoryEvidence({
      rawInput,
      ...(lookup === undefined ? {} : { lookup }),
      ...(execution === undefined ? {} : { execution }),
      ...spec,
    });

/** Project authenticated APK inventory Evidence into Android application Evidence. */
export const projectAndroidApplicationEvidence = createApplicationProjection({
  project: projectAndroidInventory,
  operation: "project_android_application_graph",
  predicateType: "rea.android-application-graph",
  provider: ANDROID_APPLICATION_PROVIDER,
});

/** Project authenticated IPA or macOS app inventory Evidence into Apple application evidence. */
export const projectAppleApplicationEvidence = createApplicationProjection({
  project: projectAppleInventory,
  operation: "project_apple_application_graph",
  predicateType: "rea.apple-application-graph",
  provider: APPLE_APPLICATION_PROVIDER,
});

/** Project authenticated HarmonyOS package inventory Evidence into application evidence. */
export const projectHarmonyApplicationEvidence = createApplicationProjection({
  project: projectHarmonyInventory,
  operation: "project_harmony_application_graph",
  predicateType: "rea.harmony-application-graph",
  provider: HARMONY_APPLICATION_PROVIDER,
});
