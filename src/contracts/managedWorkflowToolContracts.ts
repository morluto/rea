import { compareManagedMembersInputSchema } from "../domain/managedMemberComparison.js";
import { managedReconstructionImportInputSchema } from "../domain/managedReconstruction.js";
import { managedRuntimeCorrelationInputSchema } from "../domain/managedRuntimeCorrelation.js";
import type { ToolContract } from "./toolContracts.js";
import { managedWorkflowOutputSchemas } from "./toolOutputSchemas.js";
import {
  MANAGED_MEMBER_COMPARISON_EXAMPLE,
  MANAGED_RECONSTRUCTION_IMPORT_EXAMPLE,
  MANAGED_RUNTIME_CORRELATION_EXAMPLE,
} from "./managedWorkflowExamples.js";
import { toolContractMetadata } from "./toolEffects.js";

const managedEvidenceIdSchema = z
  .string()
  .regex(/^ev_[a-f0-9]{64}$/u)
  .describe("Session-owned inspect_managed_members Evidence ID");

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
    name: "import_managed_reconstruction",
    description:
      "Import decompiler-produced managed reconstruction against authenticated inspect_managed_members Evidence. The workflow locks each method to artifact SHA-256, MVID, metadata token, signature hash, and normalized IL hash, records the decompiler identity and options, and marks C# or pseudocode as analyst inference rather than canonical byte observation.",
    kind: "application",
    inputSchema: managedReconstructionImportInputSchema,
    outputSchema: reconstructionOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    examples: [
      {
        title: "Import a decompiler reconstruction for one managed method",
        input: MANAGED_RECONSTRUCTION_IMPORT_EXAMPLE,
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
import { z } from "zod";
