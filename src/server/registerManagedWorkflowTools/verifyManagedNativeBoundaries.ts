import type { EvidenceMcpServer } from "../EvidenceMcpServer.js";
import { runAdmittedToolOperation } from "../admittedToolOperation.js";
import { recordSessionEvidenceSources } from "../sessionEvidence.js";

import { verifyManagedNativeBoundariesEvidence } from "../../application/managed/ManagedNativeVerificationService.js";
import { managedNativeVerificationResultSchema } from "../../domain/managed/managedNativeVerificationSchemas.js";
import { logToolExecution } from "../toolLogging.js";
import { toolRegistrationOptions } from "../toolRegistrationOptions.js";
import { managedWorkflowContract } from "./contract.js";
import {
  resolveManagedBoundaryEvidence,
  resolveNativeEvidence,
} from "./evidence.js";
import type { ManagedWorkflowToolRegistration } from "./types.js";

const nativeVerificationContract = managedWorkflowContract(
  "verify_managed_native_boundaries",
);

/** Register the managed/native boundary verification workflow tool. */
export const registerVerifyManagedNativeBoundaries = (
  server: EvidenceMcpServer,
  options: ManagedWorkflowToolRegistration,
): void => {
  server.registerTool(
    nativeVerificationContract.name,
    toolRegistrationOptions(nativeVerificationContract),
    async (input, context) =>
      runAdmittedToolOperation(
        server,
        options.withAdmittedAnalysis,
        nativeVerificationContract.name,
        context.mcpReq.signal,
        async () => {
          const managedBoundaries = resolveManagedBoundaryEvidence(
            input.managed_boundaries,
          );
          if (!managedBoundaries.ok)
            return server.delivery.toCallToolResult(
              managedBoundaries,
              nativeVerificationContract,
            );
          const nativeObservations = resolveNativeEvidence(
            input.native_observations,
          );
          if (!nativeObservations.ok)
            return server.delivery.toCallToolResult(
              nativeObservations,
              nativeVerificationContract,
            );
          const managedBoundary = managedBoundaries.value[0];
          if (managedBoundary === undefined)
            throw new TypeError("Managed boundary Evidence resolution failed");
          const parsed = {
            ...input,
            managed_boundaries: managedBoundary,
            native_observations: nativeObservations.value,
          };
          const result = await logToolExecution(
            options.logger,
            nativeVerificationContract.name,
            () =>
              Promise.resolve(verifyManagedNativeBoundariesEvidence(parsed)),
          );
          if (!result.ok)
            return server.delivery.toCallToolResult(
              result,
              nativeVerificationContract,
            );
          const recordedSources = recordSessionEvidenceSources(
            options.recordEvidence,
            [parsed.managed_boundaries, ...parsed.native_observations],
          );
          if (!recordedSources.ok)
            return server.delivery.toCallToolResult(
              recordedSources,
              nativeVerificationContract,
            );
          const verification = managedNativeVerificationResultSchema.parse(
            result.value.normalized_result,
          );
          const unknown =
            verification.summary.unresolved > 0 ||
            verification.summary.contradicted > 0 ||
            verification.summary.native_body_unresolved > 0;
          const output = unknown
            ? options.recordEvidenceWithUnknown?.(result.value, {
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
                      "Review the inspection Evidence coverage and limit diagnostics; this operation has no page override, so unresolved declarations must remain unknown.",
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
          return server.delivery.toEvidenceToolResult(
            result.value,
            nativeVerificationContract,
            output,
          );
        },
      ),
  );
};
