import { APPLICATION_TOOL_CONTRACTS } from "../../contracts/applicationToolContracts.js";
import type { Evidence } from "../../domain/evidence.js";
import { toCallToolResult } from "../toolResult.js";
import type { ApplicationToolRegistration } from "./types.js";

export const recordResult = (
  options: ApplicationToolRegistration,
  contract: (typeof APPLICATION_TOOL_CONTRACTS)[number],
  evidence: Evidence,
  unknownKind?:
    | "application-version-comparison"
    | "javascript-export-shape"
    | "source-to-bundle-comparison",
) => {
  const recorded =
    unknownKind === undefined
      ? options.recordEvidence?.(evidence)
      : options.recordEvidenceWithUnknown?.(
          evidence,
          unknownRegistration(evidence, unknownKind),
        );
  if (recorded !== undefined && !recorded.ok)
    return toCallToolResult(recorded, contract);
  return toCallToolResult({ ok: true, value: evidence }, contract);
};

const unknownRegistration = (
  evidence: Evidence,
  kind:
    | "application-version-comparison"
    | "javascript-export-shape"
    | "source-to-bundle-comparison",
) => ({
  question:
    kind === "application-version-comparison"
      ? "Which application entities remain unmatched or ambiguous across these versions?"
      : kind === "source-to-bundle-comparison"
        ? "Which historical source files remain unmatched or ambiguously mapped to the shipped bundle?"
        : "Which selected JavaScript export return shapes remain dynamic, incomplete, or ambiguously paired?",
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
