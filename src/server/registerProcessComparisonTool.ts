import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";

import type { BinarySessionPort } from "../application/binary/BinarySessionPort.js";
import { toolContract } from "../contracts/toolContracts.js";
import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { describeValidationFailure } from "../domain/validationFailure.js";
import { EvidenceIntegrityError } from "../domain/evidenceErrors.js";
import {
  PROCESS_COMPARISON_DIMENSIONS,
  type ProcessCaptureComparison,
} from "../domain/process/processComparison.js";
import {
  compareProcessCaptureEvidence,
  type ParsedProcessCaptureEvidence,
} from "../domain/process/processComparisonEvidence.js";
import { parseProcessCaptureEvidence } from "../application/process/ProcessEvidence.js";
import type { RecordUnknownInput } from "../domain/residualUnknown.js";
import { err, type Result } from "../domain/result.js";
import { recordDerivedEvidence } from "./recordDerivedEvidence.js";
import { recordEvidenceSources } from "../application/investigation/recordEvidenceSources.js";
import { runDerivedOperation } from "./runDerivedOperation.js";
import { PROCESS_PROVIDER } from "../domain/process/processEvidenceProvider.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import { withAdmittedAnalysis } from "./analysisAdmission.js";
import { runAdmittedToolOperation } from "./admittedToolOperation.js";

/**
 * Parse one side and name the failed constraint: tampered Evidence, Evidence
 * from another workflow, or an invalid capture result.
 */
const parseCaptureSide = (
  operation: string,
  side: "left" | "right",
  value: unknown,
): Result<ParsedProcessCaptureEvidence, AnalysisError> => {
  const parsed = parseProcessCaptureEvidence(value);
  if (parsed.ok) return parsed;
  const failure = parsed.error;
  switch (failure.kind) {
    case "invalid-evidence":
      return err(
        new EvidenceIntegrityError(`${side} Evidence failed validation`, {
          cause: failure.cause,
          userMessage: `The ${side} Evidence failed validation (${describeValidationFailure(failure.cause)}). Supply unmodified capture Evidence from capture_process_scenario.`,
        }),
      );
    case "wrong-workflow":
      return err(
        new AnalysisInputError(operation, undefined, [
          {
            path: [side],
            reason: "invalid_value",
            message: `Expected process capture Evidence (operation ${failure.expected.operation}, predicate ${failure.expected.predicate}); the ${side} Evidence has operation ${failure.actual.operation} and predicate ${failure.actual.predicate}.`,
          },
        ]),
      );
    case "unsupported-provider":
      return err(
        new AnalysisInputError(operation, undefined, [
          {
            path: [side, "provider"],
            reason: "invalid_value",
            message: `The ${side} Evidence provider ${failure.provider.id} v${failure.provider.version} (${failure.provider.name}) is not the current or supported legacy ${PROCESS_PROVIDER.id} v${PROCESS_PROVIDER.version} process capture provider.`,
          },
        ]),
      );
    case "invalid-capture":
      return err(
        new EvidenceIntegrityError(
          `${side} process capture failed validation`,
          {
            cause: failure.cause,
            userMessage: `The ${side} Evidence has an invalid process capture result (${describeValidationFailure(failure.cause)}). Recreate the capture with capture_process_scenario.`,
          },
        ),
      );
  }
};

/** Register deterministic process-capture comparison and contradiction tracking. */
export const registerProcessComparisonTool = (
  server: EvidenceMcpServer,
  session: BinarySessionPort,
  contract: ReturnType<typeof toolContract<"compare_process_captures">>,
  now: () => number = Date.now,
): void => {
  const admission = withAdmittedAnalysis({ kind: "session", session });
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    async (input, context) =>
      runAdmittedToolOperation(
        server,
        admission,
        contract.name,
        context.mcpReq.signal,
        async () => {
          const left = parseCaptureSide(contract.name, "left", input.left);
          if (!left.ok) return server.delivery.toCallToolResult(left, contract);
          const right = parseCaptureSide(contract.name, "right", input.right);
          if (!right.ok)
            return server.delivery.toCallToolResult(right, contract);
          const { record: leftRecord } = left.value;
          const { record: rightRecord } = right.value;
          const computed = await runDerivedOperation(
            context,
            contract.name,
            () =>
              compareProcessCaptureEvidence(left.value, right.value, {
                ...(input.max_capture_age_ms === undefined
                  ? {}
                  : { maxCaptureAgeMs: input.max_capture_age_ms }),
                ...(input.trace_spec === undefined
                  ? {}
                  : { traceSpecification: input.trace_spec }),
                now,
              }),
          );
          if (!computed.ok)
            return server.delivery.toCallToolResult(computed, contract);
          const { comparison, evidence } = computed.value;
          const recordedSources = recordEvidenceSources(
            (evidence) => session.recordEvidence(evidence),
            [leftRecord, rightRecord],
          );
          if (!recordedSources.ok)
            return server.delivery.toCallToolResult(recordedSources, contract);
          return server.delivery.toEvidenceToolResult(
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
      ),
  );
};

const comparisonUnknownInput = (
  parsed: {
    readonly left_evidence_id: string;
    readonly right_evidence_id: string;
    readonly comparison_evidence_id: string;
  },
  comparison: ProcessCaptureComparison,
): RecordUnknownInput | undefined => {
  if (comparison.status === "unchanged") return undefined;
  const differingScopes = PROCESS_COMPARISON_DIMENSIONS.filter(
    (dimension) => comparison[dimension] !== "unchanged",
  ).join(", ");
  const contradictory =
    comparison.status === "changed" &&
    parsed.left_evidence_id !== parsed.right_evidence_id;
  // Unknown identity uses the question, not its supporting records. Bind the
  // question to this comparison so distinct capture pairs and policies coexist.
  return {
    question: `${contradictory ? "Process captures disagree" : `Process comparison is ${comparison.status}`} across: ${differingScopes} (comparison ${parsed.comparison_evidence_id})`,
    severity: "high",
    domain: "process-comparison",
    supporting_evidence_ids: contradictory
      ? [parsed.left_evidence_id]
      : [...new Set([parsed.left_evidence_id, parsed.right_evidence_id])],
    contradicting_evidence_ids: contradictory ? [parsed.right_evidence_id] : [],
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
