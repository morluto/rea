import type { McpServer } from "@modelcontextprotocol/server";

import type { BinarySessionPort } from "../application/BinarySession.js";
import { compareManagedMembersEvidenceValidated } from "../application/ManagedMemberComparisonService.js";
import { verifyManagedNativeBoundariesEvidence } from "../application/ManagedNativeVerificationService.js";
import { importManagedReconstructionEvidenceValidated } from "../application/ManagedReconstructionService.js";
import {
  planManagedRuntimeCorrelationEvidenceValidated,
  type ManagedRuntimeCorrelationDependencies,
} from "../application/ManagedRuntimeCorrelationService.js";
import {
  compareManagedMembersReferenceInputSchema,
  managedNativeVerificationReferenceInputSchema,
  managedReconstructionReferenceInputSchema,
  managedRuntimeCorrelationReferenceInputSchema,
  MANAGED_WORKFLOW_TOOL_CONTRACTS,
} from "../contracts/managedWorkflowToolContracts.js";
import { managedMemberComparisonResultSchema } from "../domain/managedMemberComparison.js";
import { managedNativeVerificationResultSchema } from "../domain/managedNativeVerification.js";
import type { Evidence } from "../domain/evidence.js";
import type { EvidenceIntegrityError } from "../domain/errors.js";
import type { Result } from "../domain/result.js";
import type { Logger } from "../logger.js";
import { logToolExecution } from "./toolLogging.js";
import { toCallToolResult } from "./toolResult.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import { safeParseToolInput } from "./toolInputValidation.js";
import { resolveSessionEvidenceIds } from "./sessionEvidence.js";

interface ManagedWorkflowToolRegistration {
  readonly logger: Logger;
  readonly recordEvidence: BinarySessionPort["recordEvidence"] | undefined;
  readonly recordEvidenceWithUnknown:
    | BinarySessionPort["recordEvidenceWithUnknown"]
    | undefined;
  readonly runtime: ManagedRuntimeCorrelationDependencies;
  readonly session: BinarySessionPort;
}

/** Register provider-neutral managed-code workflows. */
export const registerManagedWorkflowTools = (
  server: McpServer,
  options: ManagedWorkflowToolRegistration,
): void => {
  const compareContract = contract("compare_managed_members");
  const nativeVerificationContract = contract(
    "verify_managed_native_boundaries",
  );
  const reconstructionContract = contract("import_managed_reconstruction");
  const runtimeContract = contract("plan_managed_runtime_correlation");
  server.registerTool(
    compareContract.name,
    toolRegistrationOptions(compareContract),
    async (input) => {
      const parsedInput = safeParseToolInput(
        compareManagedMembersReferenceInputSchema,
        input,
        compareContract.name,
      );
      if (!parsedInput.ok)
        return toCallToolResult(parsedInput, compareContract);
      const resolved = resolveManagedEvidence(options.session, [
        parsedInput.value.left_evidence_id,
        parsedInput.value.right_evidence_id,
      ]);
      if (!resolved.ok) return toCallToolResult(resolved, compareContract);
      const [left, right] = resolved.value;
      if (left === undefined || right === undefined)
        throw new TypeError("Managed comparison Evidence resolution failed");
      const {
        left_evidence_id: _leftEvidenceId,
        right_evidence_id: _rightEvidenceId,
        ...referencedInput
      } = parsedInput.value;
      const parsed = { ...referencedInput, left, right };
      const result = await logToolExecution(
        options.logger,
        compareContract.name,
        () => Promise.resolve(compareManagedMembersEvidenceValidated(parsed)),
      );
      if (!result.ok) return toCallToolResult(result, compareContract);
      const recorded = recordSources(options.recordEvidence, [
        parsed.left,
        parsed.right,
      ]);
      if (!recorded.ok) return toCallToolResult(recorded, compareContract);
      const comparison = managedMemberComparisonResultSchema.parse(
        result.value.normalized_result,
      );
      const unknown = comparison.summary.unknown > 0;
      const output =
        parsed.unknown_registry_approved === true && unknown
          ? options.recordEvidenceWithUnknown?.(result.value, {
              approved: true,
              question:
                "Which managed members remain unmatched or ambiguous across these versions?",
              severity: "medium",
              domain: "managed-member-comparison",
              supporting_evidence_ids: [result.value.evidence_id],
              contradicting_evidence_ids: [],
              required_authority: "shipped-artifact",
              required_confidence: "observed",
              required_environment: null,
              recommended_probes: [
                {
                  operation: "inspect_managed_members",
                  rationale:
                    "Repeat static member inspection with complete pages and method bodies.",
                },
              ],
              relationships: [],
            })
          : options.recordEvidence?.(result.value);
      if (output !== undefined && !output.ok)
        return toCallToolResult(output, compareContract);
      return toCallToolResult(
        { ok: true, value: result.value },
        compareContract,
        {
          evidenceResourcesAvailable: output !== undefined,
        },
      );
    },
  );
  server.registerTool(
    nativeVerificationContract.name,
    toolRegistrationOptions(nativeVerificationContract),
    async (input) => {
      const parsedInput = safeParseToolInput(
        managedNativeVerificationReferenceInputSchema,
        input,
        nativeVerificationContract.name,
      );
      if (!parsedInput.ok)
        return toCallToolResult(parsedInput, nativeVerificationContract);
      const managedBoundaries = resolveManagedBoundaryEvidence(
        options.session,
        parsedInput.value.managed_boundaries_evidence_id,
      );
      if (!managedBoundaries.ok)
        return toCallToolResult(managedBoundaries, nativeVerificationContract);
      const nativeObservations = resolveNativeEvidence(
        options.session,
        parsedInput.value.native_observation_evidence_ids,
      );
      if (!nativeObservations.ok)
        return toCallToolResult(nativeObservations, nativeVerificationContract);
      const managedBoundary = managedBoundaries.value[0];
      if (managedBoundary === undefined)
        throw new TypeError("Managed boundary Evidence resolution failed");
      const {
        managed_boundaries_evidence_id: _managedBoundariesEvidenceId,
        native_observation_evidence_ids: _nativeObservationEvidenceIds,
        ...referencedInput
      } = parsedInput.value;
      const parsed = {
        ...referencedInput,
        managed_boundaries: managedBoundary,
        native_observations: nativeObservations.value,
      };
      const result = await logToolExecution(
        options.logger,
        nativeVerificationContract.name,
        () => Promise.resolve(verifyManagedNativeBoundariesEvidence(parsed)),
      );
      if (!result.ok)
        return toCallToolResult(result, nativeVerificationContract);
      const recordedSources = recordSources(options.recordEvidence, [
        parsed.managed_boundaries,
        ...parsed.native_observations,
      ]);
      if (!recordedSources.ok)
        return toCallToolResult(recordedSources, nativeVerificationContract);
      const verification = managedNativeVerificationResultSchema.parse(
        result.value.normalized_result,
      );
      const unknown =
        verification.summary.unresolved > 0 ||
        verification.summary.contradicted > 0 ||
        verification.summary.native_body_unresolved > 0;
      const output =
        parsed.unknown_registry_approved === true && unknown
          ? options.recordEvidenceWithUnknown?.(result.value, {
              approved: true,
              question:
                "Which managed/native boundaries remain unresolved or contradicted by the supplied native Evidence?",
              severity: "medium",
              domain: "managed-native-verification",
              supporting_evidence_ids: [result.value.evidence_id],
              contradicting_evidence_ids: [],
              required_authority: "shipped-artifact",
              required_confidence: "observed",
              required_environment: null,
              recommended_probes: [
                {
                  operation: "inspect_managed_native_boundaries",
                  rationale:
                    "Repeat managed boundary inspection with complete ModuleRef, ImplMap, and native implementation pages.",
                },
                {
                  operation: "analyze_function",
                  rationale:
                    "Analyze the provider-resolved native function candidate for the declared export.",
                },
              ],
              relationships: [],
            })
          : options.recordEvidence?.(result.value);
      if (output !== undefined && !output.ok)
        return toCallToolResult(output, nativeVerificationContract);
      return toCallToolResult(result, nativeVerificationContract, {
        evidenceResourcesAvailable: output !== undefined,
      });
    },
  );
  server.registerTool(
    reconstructionContract.name,
    toolRegistrationOptions(reconstructionContract),
    async (input) => {
      const parsedInput = safeParseToolInput(
        managedReconstructionReferenceInputSchema,
        input,
        reconstructionContract.name,
      );
      if (!parsedInput.ok)
        return toCallToolResult(parsedInput, reconstructionContract);
      const resolved = resolveManagedEvidence(options.session, [
        parsedInput.value.static_members_evidence_id,
      ]);
      if (!resolved.ok)
        return toCallToolResult(resolved, reconstructionContract);
      const staticMembers = resolved.value[0];
      if (staticMembers === undefined)
        throw new TypeError(
          "Managed reconstruction Evidence resolution failed",
        );
      const {
        static_members_evidence_id: _staticMembersEvidenceId,
        ...referencedInput
      } = parsedInput.value;
      const parsed = { ...referencedInput, static_members: staticMembers };
      const result = await logToolExecution(
        options.logger,
        reconstructionContract.name,
        () =>
          Promise.resolve(importManagedReconstructionEvidenceValidated(parsed)),
      );
      if (!result.ok) return toCallToolResult(result, reconstructionContract);
      const recordedSource = options.recordEvidence?.(parsed.static_members);
      if (recordedSource !== undefined && !recordedSource.ok)
        return toCallToolResult(recordedSource, reconstructionContract);
      const recorded = options.recordEvidence?.(result.value);
      if (recorded !== undefined && !recorded.ok)
        return toCallToolResult(recorded, reconstructionContract);
      return toCallToolResult(result, reconstructionContract, {
        evidenceResourcesAvailable: recorded !== undefined,
      });
    },
  );
  server.registerTool(
    runtimeContract.name,
    toolRegistrationOptions(runtimeContract),
    async (input) => {
      const parsedInput = safeParseToolInput(
        managedRuntimeCorrelationReferenceInputSchema,
        input,
        runtimeContract.name,
      );
      if (!parsedInput.ok)
        return toCallToolResult(parsedInput, runtimeContract);
      const resolved = resolveManagedEvidence(options.session, [
        parsedInput.value.static_members_evidence_id,
      ]);
      if (!resolved.ok) return toCallToolResult(resolved, runtimeContract);
      const staticMembers = resolved.value[0];
      if (staticMembers === undefined)
        throw new TypeError("Managed runtime Evidence resolution failed");
      const {
        static_members_evidence_id: _staticMembersEvidenceId,
        ...referencedInput
      } = parsedInput.value;
      const parsed = { ...referencedInput, static_members: staticMembers };
      const result = await logToolExecution(
        options.logger,
        runtimeContract.name,
        () =>
          planManagedRuntimeCorrelationEvidenceValidated(
            options.runtime,
            parsed,
          ),
      );
      if (!result.ok) return toCallToolResult(result, runtimeContract);
      const recordedSource = options.recordEvidence?.(parsed.static_members);
      if (recordedSource !== undefined && !recordedSource.ok)
        return toCallToolResult(recordedSource, runtimeContract);
      const recorded = options.recordEvidence?.(result.value);
      if (recorded !== undefined && !recorded.ok)
        return toCallToolResult(recorded, runtimeContract);
      return toCallToolResult(result, runtimeContract, {
        evidenceResourcesAvailable: recorded !== undefined,
      });
    },
  );
};

const contract = (
  name: (typeof MANAGED_WORKFLOW_TOOL_CONTRACTS)[number]["name"],
) => {
  const found = MANAGED_WORKFLOW_TOOL_CONTRACTS.find(
    (candidate) => candidate.name === name,
  );
  if (found === undefined) throw new Error(`Missing ${name} contract`);
  return found;
};

const resolveManagedEvidence = (
  session: BinarySessionPort,
  evidenceIds: readonly string[],
): Result<Evidence[], EvidenceIntegrityError> =>
  resolveSessionEvidenceIds(session, evidenceIds, {
    operation: "inspect_managed_members",
    predicate: "rea.analysis/v2",
  });

const resolveManagedBoundaryEvidence = (
  session: BinarySessionPort,
  evidenceId: string,
): Result<Evidence[], EvidenceIntegrityError> =>
  resolveSessionEvidenceIds(session, [evidenceId], {
    operation: "inspect_managed_native_boundaries",
    predicate: "rea.analysis/v2",
  });

const resolveNativeEvidence = (
  session: BinarySessionPort,
  evidenceIds: readonly string[],
): Result<Evidence[], EvidenceIntegrityError> => {
  const records: Evidence[] = [];
  for (const evidenceId of evidenceIds) {
    const operation = session.evidenceById(evidenceId)?.operation;
    const expectedOperation =
      operation === "inspect_macho" || operation === "analyze_function"
        ? operation
        : "inspect_macho or analyze_function";
    const resolved = resolveSessionEvidenceIds(session, [evidenceId], {
      operation: expectedOperation,
      predicate: "rea.analysis/v2",
    });
    if (!resolved.ok) return resolved;
    records.push(...resolved.value);
  }
  return { ok: true, value: records };
};

const recordSources = (
  recordEvidence: ManagedWorkflowToolRegistration["recordEvidence"],
  sources: readonly Evidence[],
) => {
  for (const source of sources) {
    const recorded = recordEvidence?.(source);
    if (recorded !== undefined && !recorded.ok) return recorded;
  }
  return { ok: true as const, value: null };
};
