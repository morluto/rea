import type { McpServer } from "@modelcontextprotocol/server";
import canonicalize from "canonicalize";
import { z } from "zod";

import type { BinarySessionPort } from "../application/BinarySession.js";
import { SESSION_TOOL_CONTRACTS } from "../contracts/toolContracts.js";
import { createEvidence } from "../domain/evidence.js";
import { EvidenceIntegrityError } from "../domain/errors.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import type { RecordUnknownInput } from "../domain/residualUnknown.js";
import {
  compareProcessCaptures,
  processCaptureSchema,
} from "../domain/processCapture.js";
import { recordDerivedEvidence } from "./recordDerivedEvidence.js";
import { err } from "../domain/result.js";
import { PROCESS_PROVIDER } from "./sessionToolPolicies.js";
import { toCallToolResult } from "./toolResult.js";

/** Register deterministic process-capture comparison and contradiction tracking. */
export const registerProcessComparisonTool = (
  server: McpServer,
  session: BinarySessionPort,
  contract: (typeof SESSION_TOOL_CONTRACTS)[6],
): void => {
  server.registerTool(
    contract.name,
    {
      description: contract.description,
      inputSchema: contract.inputSchema,
      outputSchema: contract.outputSchema,
      annotations: contract.annotations,
    },
    (input) => {
      const parsed = z
        .object({
          left_evidence_id: z.string(),
          left: processCaptureSchema,
          right_evidence_id: z.string(),
          right: processCaptureSchema,
          unknown_registry_approved: z.literal(true).optional(),
        })
        .parse(input);
      const validated = validateCaptureSources(session, parsed);
      if (!validated.ok) return toCallToolResult(validated, contract);
      const comparison = compareProcessCaptures(parsed.left, parsed.right);
      const evidence = createEvidence(undefined, PROCESS_PROVIDER, {
        predicateType: "rea.process-comparison/v1",
        operation: contract.name,
        parameters: {
          left_evidence_id: parsed.left_evidence_id,
          right_evidence_id: parsed.right_evidence_id,
          left_normalization: parsed.left.normalization,
          right_normalization: parsed.right.normalization,
        },
        result: jsonValueSchema.parse(comparison),
        confidence: "derived",
        authority: "analyst-inference",
        limitations: comparison.limitations,
        evidenceLinks: [parsed.left_evidence_id, parsed.right_evidence_id],
      });
      return toCallToolResult(
        recordDerivedEvidence(
          session,
          evidence,
          comparisonUnknownInput(parsed, comparison),
        ),
        contract,
      );
    },
  );
};

const validateCaptureSources = (
  session: BinarySessionPort,
  parsed: {
    readonly left_evidence_id: string;
    readonly left: z.infer<typeof processCaptureSchema>;
    readonly right_evidence_id: string;
    readonly right: z.infer<typeof processCaptureSchema>;
  },
) => {
  for (const [evidenceId, capture] of [
    [parsed.left_evidence_id, parsed.left],
    [parsed.right_evidence_id, parsed.right],
  ] as const) {
    const evidence = session.evidenceById(evidenceId);
    const result = processCaptureSchema.safeParse(evidence?.normalized_result);
    if (
      evidence === undefined ||
      evidence.operation !== "capture_process_scenario" ||
      evidence.predicate_type !== "rea.process-capture/v2" ||
      evidence.provider.id !== PROCESS_PROVIDER.id ||
      evidence.provider.name !== PROCESS_PROVIDER.name ||
      evidence.provider.version !== PROCESS_PROVIDER.version ||
      evidence.confidence !== "observed" ||
      evidence.authority !== "controlled-replay" ||
      !result.success ||
      canonicalJson(result.data) !== canonicalJson(capture)
    )
      return err(
        new EvidenceIntegrityError(
          "Process comparison payload does not match its source Evidence",
        ),
      );
  }
  return { ok: true as const, value: null };
};

const canonicalJson = (value: unknown): string => {
  const encoded = canonicalize(value);
  if (encoded === undefined)
    throw new TypeError("Process capture could not be canonicalized");
  return encoded;
};

const comparisonUnknownInput = (
  parsed: {
    readonly left_evidence_id: string;
    readonly right_evidence_id: string;
    readonly unknown_registry_approved?: true | undefined;
  },
  comparison: ReturnType<typeof compareProcessCaptures>,
): RecordUnknownInput | undefined => {
  if (
    parsed.unknown_registry_approved !== true ||
    comparison.status === "unchanged"
  )
    return undefined;
  const differingScopes = [
    ["terminal", comparison.terminal],
    ["exit", comparison.exit],
    ["filesystem", comparison.filesystem],
    ["protocol", comparison.protocol],
    ["process", comparison.process],
  ]
    .filter(([, status]) => status !== "unchanged")
    .map(([scope]) => scope)
    .join(", ");
  return {
    approved: true,
    question: `Process captures disagree across: ${differingScopes}`,
    severity: "high",
    domain: "process-comparison",
    supporting_evidence_ids: [parsed.left_evidence_id],
    contradicting_evidence_ids: [parsed.right_evidence_id],
    required_authority: "controlled-replay",
    required_confidence: "observed",
    required_environment: null,
    recommended_probes: [
      {
        operation: "capture_process_scenario",
        rationale:
          "Repeat both scenarios under the same controlled environment.",
      },
    ],
    relationships: [],
  };
};
