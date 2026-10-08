import type { McpServer } from "@modelcontextprotocol/server";

import type { BinarySessionPort } from "../application/binary/BinarySession.js";
import { toolContract } from "../contracts/toolContracts.js";
import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import { type AnalysisError } from "../domain/analysisErrorBase.js";
import { describeValidationFailure } from "../domain/evidenceBundle.js";
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
  type ProcessCapture,
} from "../domain/process/processCapture.js";
import type { RecordUnknownInput } from "../domain/residualUnknown.js";
import { err, ok, type Result } from "../domain/result.js";
import { recordDerivedEvidence } from "./recordDerivedEvidence.js";
import { recordSessionEvidenceSources } from "./sessionEvidence.js";
import { runDerivedOperation } from "./runDerivedOperation.js";
import { PROCESS_PROVIDER } from "./sessionToolPolicies.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import { toCallToolResult, toEvidenceToolResult } from "./toolResult.js";

const PROCESS_CAPTURE_EVIDENCE = {
  operation: "capture_process_scenario",
  predicate: "rea.process-capture",
} as const;

const sourceLocations = (
  left: readonly EvidenceLocation[] | undefined,
  right: readonly EvidenceLocation[] | undefined,
): readonly EvidenceLocation[] => [...(left ?? []), ...(right ?? [])];

/**
 * Parse one side and name the failed constraint: tampered Evidence, Evidence
 * from another workflow, or an invalid capture result.
 */
const parseCaptureSide = (
  operation: string,
  side: "left" | "right",
  value: unknown,
): Result<
  { readonly record: Evidence; readonly capture: ProcessCapture },
  AnalysisError
> => {
  let record: Evidence;
  try {
    record = parseEvidence(value);
  } catch (cause: unknown) {
    return err(
      new EvidenceIntegrityError(`${side} Evidence failed validation`, {
        cause,
        userMessage: `The ${side} Evidence failed validation (${describeValidationFailure(cause)}). Supply unmodified capture Evidence from capture_process_scenario.`,
      }),
    );
  }
  if (
    record.operation !== PROCESS_CAPTURE_EVIDENCE.operation ||
    record.predicate_type !== PROCESS_CAPTURE_EVIDENCE.predicate
  )
    return err(
      new AnalysisInputError(operation, undefined, [
        {
          path: [side],
          reason: "invalid_value",
          message: `Expected process capture Evidence (operation ${PROCESS_CAPTURE_EVIDENCE.operation}, predicate ${PROCESS_CAPTURE_EVIDENCE.predicate}); the ${side} Evidence has operation ${record.operation} and predicate ${record.predicate_type}.`,
        },
      ]),
    );
  try {
    return ok({
      record,
      capture: parseProcessCapture(record.normalized_result),
    });
  } catch (cause: unknown) {
    return err(
      new EvidenceIntegrityError(`${side} process capture failed validation`, {
        cause,
        userMessage: `The ${side} Evidence has an invalid process capture result (${describeValidationFailure(cause)}). Recreate the capture with capture_process_scenario.`,
      }),
    );
  }
};

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
      const left = parseCaptureSide(contract.name, "left", input.left);
      if (!left.ok) return toCallToolResult(left, contract);
      const right = parseCaptureSide(contract.name, "right", input.right);
      if (!right.ok) return toCallToolResult(right, contract);
      const { record: leftRecord, capture: leftCapture } = left.value;
      const { record: rightRecord, capture: rightCapture } = right.value;
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
      const comparison = computed.value;
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
      return toEvidenceToolResult(
        evidence,
        contract,
        recordDerivedEvidence(
          session,
          evidence,
          comparisonUnknownInput(
            {
              left_evidence_id: leftRecord.evidence_id,
              right_evidence_id: rightRecord.evidence_id,
              comparison_evidence_id: evidence.evidence_id,
            },
            comparison,
          ),
        ),
      );
    },
  );
};

const comparisonUnknownInput = (
  parsed: {
    readonly left_evidence_id: string;
    readonly right_evidence_id: string;
    readonly comparison_evidence_id: string;
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
  // Unknown identity uses the question, not its supporting records. Bind the
  // question to this comparison so distinct capture pairs and policies coexist.
  return {
    question: `Process captures disagree across: ${differingScopes} (comparison ${parsed.comparison_evidence_id})`,
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
