import { unknownTarget } from "../../domain/targetIdentity.js";
import {
  callPathRequestSchema,
  staticRuntimeCorrelationRequestSchema,
} from "../../contracts/investigationInputContracts.js";
import {
  changedBehaviorInputSchema,
  findChangedBehavior,
} from "../../domain/changedBehavior.js";
import { buildCallPath } from "../../domain/callPath.js";
import { correlateStaticAndRuntime } from "../../domain/staticRuntimeCorrelation.js";
import { verifyReconstruction } from "../../domain/reconstructionVerification.js";
import { reconstructionVerificationInputSchema } from "../../domain/reconstructionVerificationSchemas.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import { createAnalysisProfile } from "../../domain/analysisProfile.js";
import { readImmutableEvidence } from "../../domain/evidenceValidation.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  CALL_PATH_PROVIDER,
  CHANGED_BEHAVIOR_PROVIDER,
  RECONSTRUCTION_PROVIDER,
  STATIC_RUNTIME_PROVIDER,
} from "../../domain/investigationProviders.js";
import type { RecordUnknownInput } from "../../domain/residualUnknown.js";
import { err, ok, type Result } from "../../domain/result.js";
import { resolveEvidenceRequest } from "../EvidenceInputResolver.js";
import type { EvidenceReader } from "./InvestigationRecordPort.js";
import type { EvidenceWorkflowExecution } from "./EvidenceWorkflowExecution.js";
import { resolveInvestigationEvidenceClosure } from "./InvestigationEvidence.js";
import { workflowUnknownInput } from "./WorkflowUnknown.js";

export interface InvestigationWorkflowExecution extends EvidenceWorkflowExecution {
  readonly unknown: RecordUnknownInput | undefined;
}

type Reader = Pick<EvidenceReader, "evidenceForAnalysis">;
type UnknownDescription = {
  readonly question: string;
  readonly domain: string;
  readonly requiredAuthority: "shipped-artifact" | "controlled-replay" | null;
  readonly requiredConfidence: "observed" | "derived";
  readonly probes: readonly {
    readonly operation: string;
    readonly rationale: string;
  }[];
};

const finish = (
  evidence: Evidence,
  sources: readonly Evidence[],
  unresolved: boolean,
  description: UnknownDescription,
): Result<InvestigationWorkflowExecution, AnalysisError> => {
  if (!unresolved) return ok({ evidence, sources, unknown: undefined });
  const unknown = workflowUnknownInput(evidence.evidence_id, {
    question: description.question,
    severity: "high",
    domain: description.domain,
    required_authority: description.requiredAuthority,
    required_confidence: description.requiredConfidence,
    required_environment: null,
    recommended_probes: [...description.probes],
    relationships: [],
  });
  return unknown.ok
    ? ok({ evidence, sources, unknown: unknown.value })
    : unknown;
};

/** Compose exact existing dossiers without starting a provider or resending payloads. */
export const buildCallPathEvidence = (
  input: unknown,
  reader: Reader,
  signal?: AbortSignal,
): Result<InvestigationWorkflowExecution, AnalysisError> => {
  const selected = resolveEvidenceRequest(
    "build_call_path",
    input,
    callPathRequestSchema,
    reader.evidenceForAnalysis.bind(reader),
    {
      ...(signal === undefined ? {} : { signal }),
      referenceScope: "retained-closure",
      readEvidence: readImmutableEvidence,
    },
  );
  if (!selected.ok) return selected;
  try {
    const result = buildCallPath(selected.value.input);
    const sources = selected.value.input.functions;
    const closure = resolveInvestigationEvidenceClosure(
      reader,
      result.evidence_links,
      sources,
    );
    if (!closure.ok) return closure;
    const evidence = createEvidence(
      unknownTarget("derived-from-linked-evidence"),
      CALL_PATH_PROVIDER,
      {
        predicateType: "rea.call-path",
        operation: "build_call_path",
        analysisProfile: createAnalysisProfile(CALL_PATH_PROVIDER, {
          workflow_revision: 2,
        }),
        parameters: {
          start: selected.value.input.start.address,
          goal: selected.value.input.goal.address,
        },
        result,
        confidence: "derived",
        authority: "analyst-inference",
        limitations: result.limitations,
        evidenceLinks: closure.value,
      },
    );
    return finish(evidence, sources, result.status === "unknown", {
      question:
        "Can the requested call path be established from complete analysis?",
      domain: "call-path",
      requiredAuthority: "shipped-artifact",
      requiredConfidence: "derived",
      probes: [
        {
          operation: "analyze_function",
          rationale:
            "Inspect reachable code and compare independent provider observations where call discovery is uncertain.",
        },
      ],
    });
  } catch (cause: unknown) {
    if (cause instanceof AnalysisError) return err(cause);
    throw cause;
  }
};

/** Aggregate caller-selected comparisons and preserve their exact source closure. */
export const findChangedBehaviorEvidence = (
  input: unknown,
  reader: Reader,
  signal?: AbortSignal,
): Result<InvestigationWorkflowExecution, AnalysisError> => {
  const selected = resolveEvidenceRequest(
    "find_changed_behavior",
    input,
    changedBehaviorInputSchema,
    reader.evidenceForAnalysis.bind(reader),
    {
      ...(signal === undefined ? {} : { signal }),
      referenceScope: "retained-closure",
      readEvidence: readImmutableEvidence,
    },
  );
  if (!selected.ok) return selected;
  try {
    const { result, comparisonEvidenceIds } = findChangedBehavior(
      selected.value.input,
    );
    const sources = selected.value.input.comparisons;
    const closure = resolveInvestigationEvidenceClosure(
      reader,
      result.evidence_links,
      sources,
    );
    if (!closure.ok) return closure;
    const evidence = createEvidence(
      unknownTarget("derived-from-linked-evidence"),
      CHANGED_BEHAVIOR_PROVIDER,
      {
        predicateType: "rea.changed-behavior",
        operation: "find_changed_behavior",
        parameters: { comparison_evidence_ids: [...comparisonEvidenceIds] },
        result,
        confidence: "derived",
        authority: "analyst-inference",
        limitations: result.limitations,
        evidenceLinks: closure.value,
      },
    );
    return finish(
      evidence,
      sources,
      result.behavior_status === "unknown" ||
        result.behavior_status === "truncated",
      {
        question:
          "Did both versions behave the same under a complete controlled replay?",
        domain: "changed-behavior",
        requiredAuthority: "controlled-replay",
        requiredConfidence: "observed",
        probes: [
          {
            operation: "capture_process_scenario",
            rationale:
              "Capture both versions under the same bounded scenario and environment.",
          },
        ],
      },
    );
  } catch (cause: unknown) {
    if (cause instanceof AnalysisError) return err(cause);
    throw cause;
  }
};

/** Keep correlation hypotheses explicit while resolving record transport centrally. */
export const correlateStaticAndRuntimeEvidence = (
  input: unknown,
  reader: Reader,
  signal?: AbortSignal,
): Result<InvestigationWorkflowExecution, AnalysisError> => {
  const selected = resolveEvidenceRequest(
    "correlate_static_and_runtime",
    input,
    staticRuntimeCorrelationRequestSchema,
    reader.evidenceForAnalysis.bind(reader),
    {
      ...(signal === undefined ? {} : { signal }),
      referenceScope: "retained-closure",
      readEvidence: readImmutableEvidence,
    },
  );
  if (!selected.ok) return selected;
  try {
    const sources = [
      ...selected.value.input.static_comparisons,
      ...selected.value.input.runtime_comparisons,
    ];
    const supplied = new Map(
      sources.map((source) => [source.evidence_id, source]),
    );
    const result = correlateStaticAndRuntime(selected.value.input, {
      sourceEvidence: (id) =>
        supplied.get(id) ?? reader.evidenceForAnalysis(id),
    });
    const closure = resolveInvestigationEvidenceClosure(
      reader,
      result.evidence_links,
      sources,
    );
    if (!closure.ok) return closure;
    const evidence = createEvidence(
      unknownTarget("derived-from-linked-evidence"),
      STATIC_RUNTIME_PROVIDER,
      {
        predicateType: "rea.static-runtime-correlation",
        operation: "correlate_static_and_runtime",
        parameters: { mapping_count: selected.value.input.mappings.length },
        result,
        confidence: "inferred",
        authority: "analyst-inference",
        limitations: result.limitations,
        evidenceLinks: closure.value,
      },
    );
    return finish(
      evidence,
      sources,
      result.status === "unknown" || result.status === "truncated",
      {
        question: "Does runtime behavior match the available static analysis?",
        domain: "static-runtime-correlation",
        requiredAuthority: null,
        requiredConfidence: "derived",
        probes: [
          {
            operation: "capture_process_scenario",
            rationale:
              "Repeat runtime observations and complete the mapped static comparison Evidence.",
          },
        ],
      },
    );
  } catch (cause: unknown) {
    if (cause instanceof AnalysisError) return err(cause);
    throw cause;
  }
};

/**
 * Verify a reconstruction specification against the session's immutable
 * Evidence bundle. The verification reads the bundle in place, so it retains
 * no sources; its links name the exact session records it relied on.
 */
export const verifyReconstructionEvidence = (
  input: unknown,
  reader: Pick<
    EvidenceReader,
    "evidenceForAnalysis" | "immutableEvidenceBundle"
  >,
): Result<InvestigationWorkflowExecution, AnalysisError> => {
  const parsed = reconstructionVerificationInputSchema.safeParse(input);
  if (!parsed.success)
    return err(
      analysisInputErrorFromIssues(
        "verify_reconstruction",
        parsed.error.issues,
        input,
        { cause: parsed.error },
      ),
    );
  try {
    const result = verifyReconstruction(
      parsed.data.specification,
      reader.immutableEvidenceBundle(),
    );
    const closure = resolveInvestigationEvidenceClosure(
      reader,
      result.evidence_links,
    );
    if (!closure.ok) return closure;
    const evidence = createEvidence(
      unknownTarget("derived-from-linked-evidence"),
      RECONSTRUCTION_PROVIDER,
      {
        predicateType: "rea.reconstruction-verification",
        operation: "verify_reconstruction",
        analysisProfile: createAnalysisProfile(RECONSTRUCTION_PROVIDER, {
          workflow_revision: 2,
        }),
        parameters: {
          specification_sha256: result.specification_sha256,
          claim_ids: parsed.data.specification.claims.map(
            ({ claim_id: id }) => id,
          ),
        },
        result,
        confidence: "derived",
        authority: "analyst-inference",
        limitations: result.limitations,
        evidenceLinks: closure.value,
      },
    );
    return finish(evidence, [], result.status === "unknown", {
      question: "Does the reconstruction satisfy every declared claim?",
      domain: "reconstruction-verification",
      requiredAuthority: null,
      requiredConfidence: "derived",
      probes: result.recommended_probes.map(({ operation, rationale }) => ({
        operation,
        rationale,
      })),
    });
  } catch (cause: unknown) {
    if (cause instanceof AnalysisError) return err(cause);
    throw cause;
  }
};
