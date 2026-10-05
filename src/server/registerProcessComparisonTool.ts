import type { McpServer } from "@modelcontextprotocol/server";

import type { BinarySessionPort } from "../application/BinarySession.js";
import { toolContract } from "../contracts/toolContracts.js";
import { EvidenceIntegrityError } from "../domain/evidenceErrors.js";
import {
  createEvidence,
  parseEvidence,
  type Evidence,
  type EvidenceLocation,
} from "../domain/evidence.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import {
  compareProcessCaptures,
  parseProcessCapture,
} from "../domain/processCapture.js";
import type { RecordUnknownInput } from "../domain/residualUnknown.js";
import { err } from "../domain/result.js";
import { recordDerivedEvidence } from "./recordDerivedEvidence.js";
import { recordSessionEvidenceSources } from "./sessionEvidence.js";
import { runDerivedOperation } from "./runDerivedOperation.js";
import { PROCESS_PROVIDER } from "./sessionToolPolicies.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import { toCallToolResult } from "./toolResult.js";

const PROCESS_CAPTURE_EVIDENCE = {
  operation: "capture_process_scenario",
  predicate: "rea.process-capture",
} as const;

const sourceLocations = (
  left: readonly EvidenceLocation[] | undefined,
  right: readonly EvidenceLocation[] | undefined,
): readonly EvidenceLocation[] => [...(left ?? []), ...(right ?? [])];

/** Register deterministic process-capture comparison and contradiction tracking. */
export const registerProcessComparisonTool = (
  server: McpServer,
  session: BinarySessionPort,
  contract: ReturnType<typeof toolContract<"compare_process_captures">>,
  now: () => number = Date.now,
): void => {
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    async (input, context) => {
      let leftRecord: Evidence;
      let rightRecord: Evidence;
      try {
        leftRecord = parseEvidence(input.left);
        rightRecord = parseEvidence(input.right);
        if (
          leftRecord.operation !== PROCESS_CAPTURE_EVIDENCE.operation ||
          rightRecord.operation !== PROCESS_CAPTURE_EVIDENCE.operation ||
          leftRecord.predicate_type !== PROCESS_CAPTURE_EVIDENCE.predicate ||
          rightRecord.predicate_type !== PROCESS_CAPTURE_EVIDENCE.predicate
        )
          throw new TypeError("Expected process capture Evidence");
      } catch (cause: unknown) {
        return toCallToolResult(
          err(
            new EvidenceIntegrityError(
              cause instanceof Error ? cause.message : "Invalid Evidence",
            ),
          ),
          contract,
        );
      }
      let comparison: ReturnType<typeof compareProcessCaptures>;
      let leftCapture: ReturnType<typeof parseProcessCapture>;
      let rightCapture: ReturnType<typeof parseProcessCapture>;
      try {
        leftCapture = parseProcessCapture(leftRecord.normalized_result);
        rightCapture = parseProcessCapture(rightRecord.normalized_result);
        const computed = await runDerivedOperation(context, contract.name, () =>
          compareProcessCaptures(leftCapture, rightCapture, {
            ...(input.max_capture_age_ms === undefined
              ? {}
              : { maxCaptureAgeMs: input.max_capture_age_ms }),
            ...(input.trace_spec === undefined
              ? {}
              : { traceSpecification: input.trace_spec }),
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
                : "Invalid process capture",
            ),
          ),
          contract,
        );
      }
      const evidence = createEvidence(undefined, PROCESS_PROVIDER, {
        predicateType: "rea.process-comparison",
        operation: contract.name,
        parameters: {
          left_evidence_id: leftRecord.evidence_id,
          right_evidence_id: rightRecord.evidence_id,
          left_normalization: leftCapture.normalization,
          right_normalization: rightCapture.normalization,
          ...(input.trace_spec === undefined
            ? {}
            : { trace_spec: jsonValueSchema.parse(input.trace_spec) }),
        },
        result: jsonValueSchema.parse(comparison),
        confidence: "derived",
        authority: "analyst-inference",
        limitations: comparison.limitations,
        locations: sourceLocations(leftRecord.locations, rightRecord.locations),
        evidenceLinks: [leftRecord.evidence_id, rightRecord.evidence_id],
      });
      const recordedSources = recordSessionEvidenceSources(
        (evidence) => session.recordEvidence(evidence),
        [leftRecord, rightRecord],
      );
      if (!recordedSources.ok)
        return toCallToolResult(recordedSources, contract);
      return toCallToolResult(
        recordDerivedEvidence(
          session,
          evidence,
          comparisonUnknownInput(
            {
              left_evidence_id: leftRecord.evidence_id,
              right_evidence_id: rightRecord.evidence_id,
            },
            comparison,
          ),
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
  },
  comparison: ReturnType<typeof compareProcessCaptures>,
): RecordUnknownInput | undefined => {
  if (comparison.status === "unchanged") return undefined;
  const differingScopes = [
    ["terminal", comparison.terminal],
    ["interaction", comparison.interaction],
    ["exit", comparison.exit],
    ["filesystem", comparison.filesystem],
    ["process", comparison.process],
  ]
    .filter(([, status]) => status !== "unchanged")
    .map(([scope]) => scope)
    .join(", ");
  return {
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
