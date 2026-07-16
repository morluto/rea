import type { McpServer } from "@modelcontextprotocol/server";

import type { BinarySessionPort } from "../application/BinarySession.js";
import {
  processComparisonInputSchema,
  SESSION_TOOL_CONTRACTS,
} from "../contracts/toolContracts.js";
import { createEvidence } from "../domain/evidence.js";
import { EvidenceIntegrityError } from "../domain/errors.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import type { RecordUnknownInput } from "../domain/residualUnknown.js";
import {
  compareProcessCaptures,
  parseProcessCapture,
} from "../domain/processCapture.js";
import { recordDerivedEvidence } from "./recordDerivedEvidence.js";
import { err } from "../domain/result.js";
import { PROCESS_PROVIDER } from "./sessionToolPolicies.js";
import { toCallToolResult } from "./toolResult.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import { runDerivedOperation } from "./runDerivedOperation.js";
import { safeParseToolInput } from "./toolInputValidation.js";
import { resolveSessionEvidenceIds } from "./sessionEvidence.js";

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
      const parsedInput = safeParseToolInput(
        processComparisonInputSchema,
        input,
        contract.name,
      );
      if (!parsedInput.ok) return toCallToolResult(parsedInput, contract);
      const parsed = parsedInput.value;
      const expected = {
        operation: "capture_process_scenario",
        predicate: "rea.process-capture/v4",
      };
      const leftRecord = resolveSessionEvidenceIds(
        session,
        [parsed.left_evidence_id],
        expected,
      );
      if (!leftRecord.ok) return toCallToolResult(leftRecord, contract);
      const rightRecord = resolveSessionEvidenceIds(
        session,
        [parsed.right_evidence_id],
        expected,
      );
      if (!rightRecord.ok) return toCallToolResult(rightRecord, contract);
      let comparison: ReturnType<typeof compareProcessCaptures>;
      let leftCapture: ReturnType<typeof parseProcessCapture>;
      let rightCapture: ReturnType<typeof parseProcessCapture>;
      try {
        leftCapture = parseProcessCapture(
          leftRecord.value[0]?.normalized_result,
        );
        rightCapture = parseProcessCapture(
          rightRecord.value[0]?.normalized_result,
        );
        const computed = await runDerivedOperation(context, contract.name, () =>
          compareProcessCaptures(leftCapture, rightCapture, {
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
          left_normalization: leftCapture.normalization,
          right_normalization: rightCapture.normalization,
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
