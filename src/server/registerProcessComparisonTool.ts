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
  parseProcessCapture,
} from "../domain/processCapture.js";
import { recordDerivedEvidence } from "./recordDerivedEvidence.js";
import { err } from "../domain/result.js";
import { PROCESS_PROVIDER } from "./sessionToolPolicies.js";
import { toCallToolResult } from "./toolResult.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import { runDerivedOperation } from "./runDerivedOperation.js";

/** Register deterministic process-capture comparison and contradiction tracking. */
export const registerProcessComparisonTool = (
  server: McpServer,
  session: BinarySessionPort,
  contract: (typeof SESSION_TOOL_CONTRACTS)[6],
  now: () => number = Date.now,
): void => {
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    async (input, context) => {
      const parsed = z
        .object({
          left_evidence_id: z.string(),
          left: processCaptureSchema,
          right_evidence_id: z.string(),
          right: processCaptureSchema,
          max_capture_age_ms: z.number().int().nonnegative().optional(),
          unknown_registry_approved: z.literal(true).optional(),
        })
        .parse(input);
      const validated = validateCaptureSources(session, parsed);
      if (!validated.ok) return toCallToolResult(validated, contract);
      let comparison: ReturnType<typeof compareProcessCaptures>;
      try {
        const computed = await runDerivedOperation(context, contract.name, () =>
          compareProcessCaptures(parsed.left, parsed.right, {
            ...(parsed.max_capture_age_ms === undefined
              ? {}
              : { maxCaptureAgeMs: parsed.max_capture_age_ms }),
            now,
          }),
        );
        if (!computed.ok) return toCallToolResult(computed, contract);
        comparison = computed.value;
      } catch (cause: unknown) {
        return toCallToolResult(
          err(
            new EvidenceIntegrityError(
              cause instanceof Error
                ? cause.message
                : "Invalid Process Capture v4",
            ),
          ),
          contract,
        );
      }
      const evidence = createEvidence(undefined, PROCESS_PROVIDER, {
        predicateType: "rea.process-comparison/v3",
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
    let evidenceCapture: z.infer<typeof processCaptureSchema> | undefined;
    try {
      evidenceCapture = parseProcessCapture(evidence?.normalized_result);
    } catch {
      evidenceCapture = undefined;
    }
    if (
      evidence === undefined ||
      evidence.operation !== "capture_process_scenario" ||
      evidence.predicate_type !== "rea.process-capture/v4" ||
      evidence.provider.id !== PROCESS_PROVIDER.id ||
      evidence.provider.name !== PROCESS_PROVIDER.name ||
      evidence.provider.version !== PROCESS_PROVIDER.version ||
      evidence.confidence !== "observed" ||
      evidence.authority !== "controlled-replay" ||
      evidenceCapture === undefined ||
      canonicalize(evidenceCapture) !== canonicalize(capture)
    )
      return err(
        new EvidenceIntegrityError(
          "Process comparison payload does not match its source Evidence",
        ),
      );
  }
  return { ok: true as const, value: null };
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
    ["interaction", comparison.interaction],
    ["exit", comparison.exit],
    ["filesystem", comparison.filesystem],
    ["protocol", comparison.protocol],
    ["process", comparison.process],
    ["shim", comparison.shim],
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
