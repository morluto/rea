import type { JsonValue } from "../domain/jsonValue.js";

/** Exact example inputs for residual-unknown lifecycle contracts. */
export const UNKNOWN_CONTRACT_EXAMPLES = {
  list_unknowns: {},
  record_unknown: {
    approved: true,
    question: "Does this branch require an unavailable external service?",
    severity: "medium",
    domain: "protocol",
    required_authority: "controlled-replay",
    required_confidence: "observed",
    required_environment: null,
    recommended_probes: [
      { operation: "capture_process_scenario", rationale: "Replay branch." },
    ],
    relationships: [],
  },
  update_unknown: {
    approved: true,
    unknown_id: `unk_${"0".repeat(64)}`,
    expected_revision: 1,
    status: "investigating",
    severity: "medium",
    supporting_evidence_ids: [],
    contradicting_evidence_ids: [],
    required_authority: "controlled-replay",
    required_confidence: "observed",
    required_environment: null,
    recommended_probes: [],
    relationships: [],
    resolution: null,
  },
  verify_unknown_resolution: { unknown_id: `unk_${"0".repeat(64)}` },
} satisfies Readonly<Record<string, Readonly<Record<string, JsonValue>>>>;
