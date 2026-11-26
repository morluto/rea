import { unknownTarget } from "../../domain/targetIdentity.js";
import {
  resolveEvidenceRequest,
  type EvidenceLookup,
} from "../EvidenceInputResolver.js";
import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { InvestigationWorkflowExecution } from "../investigation/InvestigationWorkflows.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  createEvidence,
  evidenceSubjectTarget,
  type Evidence,
  type EvidenceSubjectTarget,
} from "../../domain/evidence.js";
import {
  managedApplicationGraphReferenceInputSchema,
  projectManagedGraph,
  readManagedGraphProjection,
  type ManagedApplicationGraphResult,
  type ManagedGraphProjection,
  type ParsedManagedGraphInput,
} from "../../domain/managed/managedApplicationGraph.js";
import { ok, type Result } from "../../domain/result.js";
import { MANAGED_WORKFLOW_PROVIDER } from "../../domain/investigationProviders.js";

const OPERATION = "project_managed_application_graph" as const;

/**
 * Project authenticated managed Evidence into a provider-neutral graph; the
 * selected artifact, member and boundary records are its sources.
 */
export const projectManagedApplicationGraphExecution = (
  rawInput: unknown,
  lookup?: EvidenceLookup,
  options: Pick<ExecutionOptions, "signal"> = {},
): Result<InvestigationWorkflowExecution, AnalysisError> => {
  const request = resolveManagedGraphEvidenceInput(rawInput, lookup, options);
  if (!request.ok) return request;
  const { artifact, members, boundaries } = request.value.sources;
  return ok({
    evidence: projectManagedGraphEvidence(request.value),
    sources: [artifact, members, boundaries].flatMap((source) =>
      source === undefined || source === null ? [] : [source.evidence],
    ),
    unknown: undefined,
  });
};

/** Project authenticated managed Evidence into a provider-neutral graph. */
export const projectManagedApplicationGraphEvidence = (
  rawInput: unknown,
  lookup?: EvidenceLookup,
  options: Pick<ExecutionOptions, "signal"> = {},
): Result<Evidence, AnalysisError> => {
  const projected = projectManagedApplicationGraphExecution(
    rawInput,
    lookup,
    options,
  );
  return projected.ok ? ok(projected.value.evidence) : projected;
};

/** Resolve selected records before the managed owner authenticates and joins them. */
const resolveManagedGraphEvidenceInput = (
  rawInput: unknown,
  lookup?: EvidenceLookup,
  options: Pick<ExecutionOptions, "signal"> = {},
): Result<ManagedGraphProjection, AnalysisError> => {
  const request = resolveEvidenceRequest(
    OPERATION,
    rawInput,
    managedApplicationGraphReferenceInputSchema,
    lookup,
    options,
  );
  return request.ok ? readManagedGraphProjection(request.value.input) : request;
};

/** Project the workflow owner's authenticated, identity-checked source facts. */
const projectManagedGraphEvidence = (
  request: ManagedGraphProjection,
): Evidence =>
  createManagedApplicationGraphEvidence(
    request.sources,
    projectManagedGraph(request),
  );

const createManagedApplicationGraphEvidence = (
  input: ParsedManagedGraphInput,
  result: ManagedApplicationGraphResult,
): Evidence =>
  createEvidence(
    subjectTarget(input) ?? unknownTarget("derived-from-linked-evidence"),
    MANAGED_WORKFLOW_PROVIDER,
    {
      predicateType: "rea.managed-application-graph",
      operation: OPERATION,
      parameters: {
        managed_artifact_evidence_id:
          input.artifact?.evidence.evidence_id ?? null,
        managed_members_evidence_id:
          input.members?.evidence.evidence_id ?? null,
        managed_native_boundaries_evidence_id:
          input.boundaries?.evidence.evidence_id ?? null,
      },
      result,
      rawResult: null,
      confidence: "inferred",
      authority: "analyst-inference",
      environment: null,
      limitations: result.limitations,
      evidenceLinks: result.evidence_links,
    },
    { immutable: true },
  );

const subjectTarget = (
  input: ParsedManagedGraphInput,
): EvidenceSubjectTarget | undefined => {
  // Every subject is present; an unknown one names no file, so the first
  // file subject among the inputs is the graph's target.
  const target = [input.artifact, input.members, input.boundaries]
    .map((source) => evidenceSubjectTarget(source?.evidence.subject))
    .find((candidate) => candidate !== undefined);
  return target?.format === "pe" ? target : undefined;
};
