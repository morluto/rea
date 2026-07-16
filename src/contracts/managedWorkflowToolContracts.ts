import { z } from "zod";

import { compareManagedMembersInputSchema } from "../domain/managedMemberComparison.js";
import { managedNativeVerificationInputSchema } from "../domain/managedNativeVerification.js";
import { managedReconstructionImportInputSchema } from "../domain/managedReconstruction.js";
import { managedRuntimeCorrelationInputSchema } from "../domain/managedRuntimeCorrelation.js";
import type { ToolContract } from "./toolContracts.js";
import { managedWorkflowOutputSchemas } from "./toolOutputSchemas.js";
import {
  MANAGED_MEMBER_COMPARISON_EXAMPLE,
  MANAGED_NATIVE_VERIFICATION_EXAMPLE,
  MANAGED_RECONSTRUCTION_IMPORT_EXAMPLE,
  MANAGED_RUNTIME_CORRELATION_EXAMPLE,
} from "./managedWorkflowExamples.js";
import { toolContractMetadata } from "./toolEffects.js";

const evidenceIdSchema = z.string().regex(/^ev_[a-f0-9]{64}$/u);
const managedEvidenceIdSchema = evidenceIdSchema.describe(
  "Session-owned inspect_managed_members Evidence ID",
);
const managedBoundaryEvidenceIdSchema = evidenceIdSchema.describe(
  "Session-owned inspect_managed_native_boundaries Evidence ID",
);
const nativeObservationEvidenceIdSchema = evidenceIdSchema.describe(
  "Session-owned inspect_macho or analyze_function Evidence ID",
);

/** MCP references for comparing two session-owned managed observations. */
export const compareManagedMembersReferenceInputSchema = z
  .strictObject({
    left_evidence_id: managedEvidenceIdSchema,
    right_evidence_id: managedEvidenceIdSchema,
    limits: compareManagedMembersInputSchema.shape.limits,
    unknown_registry_approved:
      compareManagedMembersInputSchema.shape.unknown_registry_approved,
  })
  .superRefine((input, context) => {
    if (input.left_evidence_id === input.right_evidence_id)
      context.addIssue({
        code: "custom",
        path: ["right_evidence_id"],
        message: "Managed member Evidence must be distinct",
      });
  });

/** MCP reference for planning from one session-owned managed observation. */
export const managedRuntimeCorrelationReferenceInputSchema =
  managedRuntimeCorrelationInputSchema
    .omit({ static_members: true })
    .extend({ static_members_evidence_id: managedEvidenceIdSchema });

/** MCP reference for importing reconstruction against session Evidence. */
export const managedReconstructionReferenceInputSchema =
  managedReconstructionImportInputSchema
    .omit({ static_members: true })
    .extend({ static_members_evidence_id: managedEvidenceIdSchema });

/** MCP references for managed/native verification from session Evidence. */
export const managedNativeVerificationReferenceInputSchema = z
  .strictObject({
    managed_boundaries_evidence_id: managedBoundaryEvidenceIdSchema,
    native_observation_evidence_ids: z
      .array(nativeObservationEvidenceIdSchema)
      .min(1)
      .max(50)
      .describe("Unique session-owned native observation Evidence IDs"),
    limits: managedNativeVerificationInputSchema.shape.limits,
    unknown_registry_approved:
      managedNativeVerificationInputSchema.shape.unknown_registry_approved,
  })
  .superRefine((input, context) => {
    const ids = new Set<string>();
    for (const [
      index,
      evidenceId,
    ] of input.native_observation_evidence_ids.entries()) {
      if (evidenceId === input.managed_boundaries_evidence_id)
        context.addIssue({
          code: "custom",
          path: ["native_observation_evidence_ids", index],
          message:
            "Native observation Evidence must be distinct from managed boundary Evidence",
        });
      if (ids.has(evidenceId))
        context.addIssue({
          code: "custom",
          path: ["native_observation_evidence_ids", index],
          message: "Native observation Evidence IDs must be unique",
        });
      ids.add(evidenceId);
    }
  });

const comparisonOutputSchema =
  managedWorkflowOutputSchemas.compare_managed_members;
if (comparisonOutputSchema === undefined)
  throw new Error(
    "Missing managed workflow output schema for compare_managed_members",
  );
const runtimeOutputSchema =
  managedWorkflowOutputSchemas.plan_managed_runtime_correlation;
if (runtimeOutputSchema === undefined)
  throw new Error(
    "Missing managed workflow output schema for plan_managed_runtime_correlation",
  );
const reconstructionOutputSchema =
  managedWorkflowOutputSchemas.import_managed_reconstruction;
if (reconstructionOutputSchema === undefined)
  throw new Error(
    "Missing managed workflow output schema for import_managed_reconstruction",
  );
const nativeVerificationOutputSchema =
  managedWorkflowOutputSchemas.verify_managed_native_boundaries;
if (nativeVerificationOutputSchema === undefined)
  throw new Error(
    "Missing managed workflow output schema for verify_managed_native_boundaries",
  );

/** Provider-neutral managed-code workflow contracts. */
export const MANAGED_WORKFLOW_TOOL_CONTRACTS = [
  {
    name: "compare_managed_members",
    ...toolContractMetadata("compare_managed_members"),
    description:
      "Compare two authenticated inspect_managed_members Evidence records using unique-only CIL/signature and structural method-shape tiers. Names are reported as observations but are not used as a matching basis; metadata tokens are remapped as build-local coordinates bound to each artifact SHA-256 and MVID.",
    kind: "application",
    inputSchema: compareManagedMembersReferenceInputSchema,
    outputSchema: comparisonOutputSchema,
    examples: [
      {
        title: "Compare two managed member observations",
        input: {
          left_evidence_id: MANAGED_MEMBER_COMPARISON_EXAMPLE.left.evidence_id,
          right_evidence_id:
            MANAGED_MEMBER_COMPARISON_EXAMPLE.right.evidence_id,
          limits: MANAGED_MEMBER_COMPARISON_EXAMPLE.limits,
        },
      },
    ],
  },
  {
    name: "verify_managed_native_boundaries",
    ...toolContractMetadata("verify_managed_native_boundaries"),
    description:
      "Verify managed P/Invoke/native-boundary declarations against authenticated native export or function Evidence without executing managed code or translating managed metadata tokens into native addresses. The workflow preserves declaration-only, verified, inferred, contradicted, and unresolved states.",
    kind: "application",
    inputSchema: managedNativeVerificationReferenceInputSchema,
    outputSchema: nativeVerificationOutputSchema,
    examples: [
      {
        title: "Verify a managed P/Invoke declaration against native Evidence",
        input: {
          managed_boundaries_evidence_id:
            MANAGED_NATIVE_VERIFICATION_EXAMPLE.managed_boundaries.evidence_id,
          native_observation_evidence_ids:
            MANAGED_NATIVE_VERIFICATION_EXAMPLE.native_observations.map(
              ({ evidence_id: evidenceId }) => evidenceId,
            ),
          limits: MANAGED_NATIVE_VERIFICATION_EXAMPLE.limits,
        },
      },
    ],
  },
  {
    name: "import_managed_reconstruction",
    ...toolContractMetadata("import_managed_reconstruction"),
    description:
      "Import decompiler-produced managed reconstruction against authenticated inspect_managed_members Evidence. The workflow locks each method to artifact SHA-256, MVID, metadata token, signature hash, and normalized IL hash, records the decompiler identity and options, and marks C# or pseudocode as analyst inference rather than canonical byte observation.",
    kind: "application",
    inputSchema: managedReconstructionReferenceInputSchema,
    outputSchema: reconstructionOutputSchema,
    examples: [
      {
        title: "Import a decompiler reconstruction for one managed method",
        input: {
          static_members_evidence_id:
            MANAGED_RECONSTRUCTION_IMPORT_EXAMPLE.static_members.evidence_id,
          decompiler: MANAGED_RECONSTRUCTION_IMPORT_EXAMPLE.decompiler,
          methods: MANAGED_RECONSTRUCTION_IMPORT_EXAMPLE.methods,
          notes: MANAGED_RECONSTRUCTION_IMPORT_EXAMPLE.notes,
        },
      },
    ],
  },
  {
    name: "plan_managed_runtime_correlation",
    ...toolContractMetadata("plan_managed_runtime_correlation"),
    description:
      "Prepare a separately authorized managed runtime-correlation admission plan from authenticated inspect_managed_members Evidence. The operation is default-disabled, requires the managed_runtime permission ceiling and grant, locks the exact artifact SHA-256, MVID, method signature, and normalized IL shape, distinguishes attach/load/debugger/reflection/instrumentation effects, and records that no target code was executed.",
    kind: "application",
    inputSchema: managedRuntimeCorrelationReferenceInputSchema,
    outputSchema: runtimeOutputSchema,
    examples: [
      {
        title: "Plan an exact-build managed runtime correlation",
        input: {
          static_members_evidence_id:
            MANAGED_RUNTIME_CORRELATION_EXAMPLE.static_members.evidence_id,
          method: MANAGED_RUNTIME_CORRELATION_EXAMPLE.method,
          requested_effect:
            MANAGED_RUNTIME_CORRELATION_EXAMPLE.requested_effect,
          host: MANAGED_RUNTIME_CORRELATION_EXAMPLE.host,
          bounds: MANAGED_RUNTIME_CORRELATION_EXAMPLE.bounds,
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
