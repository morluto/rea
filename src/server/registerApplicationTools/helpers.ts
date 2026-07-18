import { APPLICATION_TOOL_CONTRACTS } from "../../contracts/applicationToolContracts.js";
import type { Evidence } from "../../domain/evidence.js";
import { toCallToolResult } from "../toolResult.js";
import type { ApplicationToolRegistration } from "./types.js";

export const coverageWorkspaceUri = (workspace: {
  readonly workspace_id: string;
  readonly revision: number;
}): string =>
  `rea://reconstruction-coverage/${workspace.workspace_id}/revision/${String(workspace.revision)}`;

export const recordSources = (
  recordEvidence: ApplicationToolRegistration["recordEvidence"],
  sources: readonly Evidence[],
) => {
  for (const source of sources) {
    const recorded = recordEvidence?.(source);
    if (recorded !== undefined && !recorded.ok) return recorded;
  }
  return { ok: true as const, value: null };
};

export const recordResult = (
  options: ApplicationToolRegistration,
  contract: (typeof APPLICATION_TOOL_CONTRACTS)[number],
  evidence: Evidence,
  recordUnknown = false,
) => {
  const recorded = recordUnknown
    ? options.recordEvidenceWithUnknown?.(evidence, {
        approved: true,
        question:
          "Which application entities remain unmatched or ambiguous across these versions?",
        severity: "medium",
        domain: "application-version-comparison",
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
          {
            operation: "reconcile_javascript_runtime",
            rationale:
              "Add approved passive runtime Evidence without promoting it to static fact.",
          },
        ],
        relationships: [],
      })
    : options.recordEvidence?.(evidence);
  if (recorded !== undefined && !recorded.ok)
    return toCallToolResult(recorded, contract);
  return toCallToolResult({ ok: true, value: evidence }, contract, {
    evidenceResourcesAvailable: recorded !== undefined,
  });
};
