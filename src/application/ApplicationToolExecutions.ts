import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { Evidence } from "../domain/evidence.js";
import type { RecordUnknownInput } from "../domain/residualUnknown.js";
import { ok, type Result } from "../domain/result.js";
import type { ExecutionOptions } from "../ports/AnalysisProvider.js";
import type { ArtifactResourceScope } from "../resources/index.js";
import type { EvidenceLookup } from "./EvidenceInputResolver.js";
import type { EvidenceWorkflowExecution } from "./investigation/EvidenceWorkflowExecution.js";
import type { InvestigationWorkflowExecution } from "./investigation/InvestigationWorkflows.js";
import {
  compareApplicationVersionsEvidence,
  compareJavaScriptExportShapesEvidence,
  executeSourceToBundleComparison,
} from "./javascript/JavaScriptApplicationWorkflowService.js";
import { buildResolvedReconstructionObligationLedgerEvidence } from "./ReconstructionObligationLedgerService.js";
import { resolveReconstructionObligationLedgerRequest } from "./ReconstructionObligationLedgerRequest.js";

type Options = Pick<ExecutionOptions, "signal">;

type ComparisonUnknownKind =
  | "application-version-comparison"
  | "javascript-export-shape"
  | "source-to-bundle-comparison";

export const mapResult = <Value, Mapped>(
  result: Result<Value, AnalysisError>,
  map: (value: Value) => Mapped,
): Result<Mapped, AnalysisError> =>
  result.ok ? ok(map(result.value)) : result;

/** A completed workflow whose result leaves nothing for the session to track. */
export const settledExecution = ({
  evidence,
  sources,
}: EvidenceWorkflowExecution): InvestigationWorkflowExecution => ({
  evidence,
  sources,
  unknown: undefined,
});

/** An inspection of caller-named files, which reads no session-held Evidence. */
export const inspectionExecution = (
  inspected: Result<Evidence, AnalysisError>,
): Result<InvestigationWorkflowExecution, AnalysisError> =>
  mapResult(inspected, (evidence) =>
    settledExecution({ evidence, sources: [] }),
  );

const comparisonUnknown = (
  evidence: Evidence,
  kind: ComparisonUnknownKind,
): RecordUnknownInput => ({
  // Scope unknown identity to the comparison while keeping exact replays stable.
  question: `${
    kind === "application-version-comparison"
      ? "Which application entities remain unmatched or ambiguous across these versions?"
      : kind === "source-to-bundle-comparison"
        ? "Which historical source files remain unmatched or ambiguously mapped to the shipped bundle?"
        : "Which selected JavaScript export return shapes remain dynamic, incomplete, or ambiguously paired?"
  } (comparison ${evidence.evidence_id})`,
  severity: "medium",
  domain: kind,
  supporting_evidence_ids: [evidence.evidence_id],
  contradicting_evidence_ids: [],
  required_authority: "shipped-artifact",
  required_confidence: "observed",
  required_environment: null,
  recommended_probes: [
    {
      operation: "analyze_javascript_application",
      rationale:
        "Repeat static reconstruction with complete artifacts and source maps when available.",
    },
    ...(kind === "application-version-comparison"
      ? [
          {
            operation: "reconcile_javascript_runtime",
            rationale:
              "Add passive runtime Evidence without promoting it to static fact.",
          },
        ]
      : []),
  ],
  relationships: [],
});

const comparisonExecution = (
  { evidence, sources }: EvidenceWorkflowExecution,
  unresolved: ComparisonUnknownKind | undefined,
): InvestigationWorkflowExecution => ({
  evidence,
  sources,
  unknown:
    unresolved === undefined
      ? undefined
      : comparisonUnknown(evidence, unresolved),
});

/** Compare application versions; unmatched or ambiguous entities stay tracked. */
export const compareApplicationVersionsExecution = (
  rawInput: unknown,
  lookup: EvidenceLookup | undefined,
  options: Options,
) =>
  mapResult(
    compareApplicationVersionsEvidence(rawInput, lookup, options),
    (execution) =>
      comparisonExecution(
        execution,
        execution.result.summary.unknown > 0
          ? "application-version-comparison"
          : undefined,
      ),
  );

/** Compare export shapes; dynamic, partial or ambiguous pairs stay tracked. */
export const compareJavaScriptExportShapesExecution = (
  rawInput: unknown,
  lookup: EvidenceLookup | undefined,
  options: Options,
) =>
  mapResult(
    compareJavaScriptExportShapesEvidence(rawInput, lookup, options),
    (execution) =>
      comparisonExecution(
        execution,
        execution.result.summary.unknown > 0 ||
          execution.result.coverage.status !== "complete-within-inputs"
          ? "javascript-export-shape"
          : undefined,
      ),
  );

/** Compare historical source with a bundle; unmapped files stay tracked. */
export const sourceToBundleComparisonExecution = async (
  rawInput: unknown,
  lookup: EvidenceLookup | undefined,
  resources: ArtifactResourceScope,
  options: Options,
) =>
  mapResult(
    await executeSourceToBundleComparison(rawInput, lookup, resources, options),
    (execution) =>
      comparisonExecution(
        execution,
        execution.result.summary.unknown > 0
          ? "source-to-bundle-comparison"
          : undefined,
      ),
  );

/** Build the obligation ledger from the bundle the request names, which it retains. */
export const reconstructionObligationLedgerExecution = (
  rawInput: unknown,
): Result<InvestigationWorkflowExecution, AnalysisError> =>
  mapResult(
    resolveReconstructionObligationLedgerRequest(rawInput),
    (resolved) =>
      settledExecution({
        evidence: buildResolvedReconstructionObligationLedgerEvidence(resolved),
        sources: resolved.sources.bundle.records,
      }),
  );
