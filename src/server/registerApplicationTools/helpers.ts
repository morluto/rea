import { setImmediate } from "node:timers/promises";
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { ToolResultDelivery } from "../ToolResultDelivery.js";
import { APPLICATION_TOOL_CONTRACTS } from "../../contracts/applicationToolContracts.js";
import { inspectAnalysisViewValidated } from "../../application/analysisView/AnalysisViewService.js";
import { recordEvidenceSources } from "../../application/investigation/recordEvidenceSources.js";
import { AnalysisCancelledError } from "../../domain/analysisErrorCore.js";
import type { AnalysisViewRequest } from "../../domain/analysisView/analysisView.js";
import type { Evidence } from "../../domain/evidence.js";
import { jsonValueSchema } from "../../domain/jsonValue.js";
import { ok } from "../../domain/result.js";
import type { ApplicationToolRegistration } from "./types.js";

type UnknownKind =
  | "application-version-comparison"
  | "javascript-export-shape"
  | "source-to-bundle-comparison";

export const recordResult = (
  options: ApplicationToolRegistration & {
    readonly delivery: ToolResultDelivery;
  },
  contract: (typeof APPLICATION_TOOL_CONTRACTS)[number],
  evidence: Evidence,
  unknownKind?: UnknownKind,
) => {
  const recorded = recordApplicationResult(options, evidence, unknownKind);
  return options.delivery.toEvidenceToolResult(evidence, contract, recorded);
};

/**
 * Stage an optional caller-selected view against the completed parent, then
 * commit its sources and the parent and deliver. A request cancelled before
 * commit leaves the session unchanged; a delivered view that does not fit
 * names the retained parent and a smaller page instead of its own record.
 */
export const deliverApplicationEvidence = async (
  server: { readonly delivery: ToolResultDelivery },
  options: ApplicationToolRegistration,
  contract: (typeof APPLICATION_TOOL_CONTRACTS)[number],
  execution: {
    readonly evidence: Evidence;
    readonly sources: readonly Evidence[];
  },
  view: AnalysisViewRequest | undefined,
  signal: AbortSignal,
  unknownKind?: UnknownKind,
): Promise<CallToolResult> => {
  const { delivery } = server;
  const parent = execution.evidence;
  const selected =
    view === undefined
      ? ok(parent)
      : inspectAnalysisViewValidated(
          {
            source: {
              kind: "retained-evidence",
              evidence_id: parent.evidence_id,
            },
            view,
          },
          (id) =>
            id === parent.evidence_id ? parent : options.evidenceById?.(id),
        );
  await setImmediate();
  if (signal.aborted)
    return delivery.toErrorToolResult(
      new AnalysisCancelledError(contract.name, { cause: signal.reason }),
      contract.returnsTargetContent,
    );
  if (!selected.ok) return delivery.toCallToolResult(selected, contract);
  const sources = recordEvidenceSources(
    options.recordEvidence,
    execution.sources,
  );
  if (!sources.ok) return delivery.toCallToolResult(sources, contract);
  const saved = recordApplicationResult(options, parent, unknownKind);
  if (view === undefined)
    return delivery.toEvidenceToolResult(parent, contract, saved);
  if (saved !== undefined && !saved.ok)
    return delivery.toCallToolResult(saved, contract);
  return delivery.toSelectedViewToolResult(
    selected.value,
    { parent, request: jsonValueSchema.parse(view) },
    contract,
    options.recordEvidence?.(selected.value),
  );
};

/** Record the complete parent before choosing a delivery projection. */
export const recordApplicationResult = (
  options: ApplicationToolRegistration,
  evidence: Evidence,
  unknownKind?: UnknownKind,
) =>
  unknownKind === undefined
    ? options.recordEvidence?.(evidence)
    : options.recordEvidenceWithUnknown?.(
        evidence,
        unknownRegistration(evidence, unknownKind),
      );

const unknownRegistration = (evidence: Evidence, kind: UnknownKind) => ({
  // Scope unknown identity to the comparison while keeping exact replays stable.
  question: `${
    kind === "application-version-comparison"
      ? "Which application entities remain unmatched or ambiguous across these versions?"
      : kind === "source-to-bundle-comparison"
        ? "Which historical source files remain unmatched or ambiguously mapped to the shipped bundle?"
        : "Which selected JavaScript export return shapes remain dynamic, incomplete, or ambiguously paired?"
  } (comparison ${evidence.evidence_id})`,
  severity: "medium" as const,
  domain: kind,
  supporting_evidence_ids: [evidence.evidence_id],
  contradicting_evidence_ids: [],
  required_authority: "shipped-artifact" as const,
  required_confidence: "observed" as const,
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
