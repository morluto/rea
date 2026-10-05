import { z } from "zod";
import { evidenceSchema } from "../domain/evidence.js";

import { managedReconstructionImportInputSchema } from "../domain/managedReconstruction.js";
import { managedRuntimeCorrelationInputSchema } from "../domain/managedRuntimeCorrelation.js";
import type { ToolContract } from "./toolContracts.js";
import { managedWorkflowOutputSchemas } from "./toolOutputSchemas.js";
import {
  MANAGED_MEMBER_COMPARISON_EXAMPLE,
  MANAGED_NATIVE_VERIFICATION_EXAMPLE,
  MANAGED_APPLICATION_GRAPH_EXAMPLE,
  MANAGED_RECONSTRUCTION_IMPORT_EXAMPLE,
  MANAGED_RUNTIME_CORRELATION_EXAMPLE,
} from "./managedWorkflowExamples.js";
import { toolContractMetadata } from "./toolEffects.js";
import { requireOutputSchema } from "./toolOutputSchemaPrimitives.js";

/** Inputs for comparing two managed observations carried inline. */
export const compareManagedMembersReferenceInputSchema = z
  .strictObject({
    left: evidenceSchema,
    right: evidenceSchema,
  })
  .superRefine((input, context) => {
    if (input.left.evidence_id === input.right.evidence_id)
      context.addIssue({
        code: "custom",
        path: ["right"],
        message: "Managed member Evidence must be distinct",
      });
  });

/** MCP reference for planning from one session-owned managed observation. */
export const managedRuntimeCorrelationReferenceInputSchema =
  managedRuntimeCorrelationInputSchema.extend({
    static_members: evidenceSchema,
  });

/** Inline Evidence input for importing reconstruction. */
export const managedReconstructionReferenceInputSchema =
  managedReconstructionImportInputSchema.extend({
    static_members: evidenceSchema,
  });

/** Inline Evidence inputs for managed/native verification. */
export const managedNativeVerificationReferenceInputSchema = z
  .strictObject({
    managed_boundaries: evidenceSchema,
    native_observations: z
      .array(evidenceSchema)
      .min(1)
      .describe("Native function or export Evidence records"),
  })
  .superRefine((input, context) => {
    const ids = new Set<string>([input.managed_boundaries.evidence_id]);
    for (const [index, evidence] of input.native_observations.entries()) {
      if (evidence.evidence_id === input.managed_boundaries.evidence_id)
        context.addIssue({
          code: "custom",
          path: ["native_observations", index],
          message:
            "Native observation Evidence must be distinct from managed boundary Evidence",
        });
      if (ids.has(evidence.evidence_id))
        context.addIssue({
          code: "custom",
          path: ["native_observations", index],
          message: "Native observation Evidence IDs must be unique",
        });
      ids.add(evidence.evidence_id);
    }
  });

const managedApplicationGraphReferenceFacts = {} as const;

const managedApplicationGraphReferenceShape = z.strictObject({
  ...managedApplicationGraphReferenceFacts,
  managed_artifact: evidenceSchema.optional(),
  managed_members: evidenceSchema.optional(),
  managed_native_boundaries: evidenceSchema.optional(),
});

/** Inline Evidence sources for managed application graph projection. */
export const managedApplicationGraphReferenceInputSchema = z
  .union([
    managedApplicationGraphReferenceShape.extend({
      managed_artifact: evidenceSchema,
    }),
    managedApplicationGraphReferenceShape.extend({
      managed_members: evidenceSchema,
    }),
    managedApplicationGraphReferenceShape.extend({
      managed_native_boundaries: evidenceSchema,
    }),
  ])
  .superRefine((input, context) => {
    const ids = [
      input.managed_artifact?.evidence_id,
      input.managed_members?.evidence_id,
      input.managed_native_boundaries?.evidence_id,
    ].filter((id): id is string => id !== undefined);
    if (ids.length === 0)
      context.addIssue({
        code: "custom",
        message: "Provide at least one managed Evidence source",
      });
    if (new Set(ids).size !== ids.length)
      context.addIssue({
        code: "custom",
        message: "Managed application graph Evidence IDs must be unique",
      });
  });

const comparisonOutputSchema = requireOutputSchema(
  managedWorkflowOutputSchemas,
  "compare_managed_members",
);
const runtimeOutputSchema = requireOutputSchema(
  managedWorkflowOutputSchemas,
  "plan_managed_runtime_correlation",
);
const reconstructionOutputSchema = requireOutputSchema(
  managedWorkflowOutputSchemas,
  "import_managed_reconstruction",
);
const nativeVerificationOutputSchema = requireOutputSchema(
  managedWorkflowOutputSchemas,
  "verify_managed_native_boundaries",
);
const managedApplicationGraphOutputSchema = requireOutputSchema(
  managedWorkflowOutputSchemas,
  "project_managed_application_graph",
);

/** Provider-neutral managed-code workflow contracts. */
export const MANAGED_WORKFLOW_TOOL_CONTRACTS = [
  {
    name: "compare_managed_members",
    ...toolContractMetadata("compare_managed_members"),
    description:
      "Compare two authenticated inspect_managed_members Evidence records using unique-only decoded-CIL/signature and structural method-shape tiers. Names are reported as observations but are not used as a matching basis; metadata tokens remain build-local coordinates bound to each artifact SHA-256 and MVID, and the tuple digest does not itself remap them.",
    kind: "application",
    inputSchema: compareManagedMembersReferenceInputSchema,
    outputSchema: comparisonOutputSchema,
    examples: [
      {
        title: "Compare two managed member observations",
        input: {
          left: MANAGED_MEMBER_COMPARISON_EXAMPLE.left,
          right: MANAGED_MEMBER_COMPARISON_EXAMPLE.right,
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
          managed_boundaries:
            MANAGED_NATIVE_VERIFICATION_EXAMPLE.managed_boundaries,
          native_observations:
            MANAGED_NATIVE_VERIFICATION_EXAMPLE.native_observations,
        },
      },
    ],
  },
  {
    name: "import_managed_reconstruction",
    ...toolContractMetadata("import_managed_reconstruction"),
    description:
      "Import decompiler-produced managed reconstruction against authenticated inspect_managed_members Evidence. The workflow locks each method to artifact SHA-256, MVID, metadata token, signature hash, and the limited decoded-IL tuple hash, records the decompiler identity and options, and marks C# or pseudocode as analyst inference rather than canonical byte observation.",
    kind: "application",
    inputSchema: managedReconstructionReferenceInputSchema,
    outputSchema: reconstructionOutputSchema,
    examples: [
      {
        title: "Import a decompiler reconstruction for one managed method",
        input: {
          static_members: MANAGED_RECONSTRUCTION_IMPORT_EXAMPLE.static_members,
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
      "Prepare a non-executing managed runtime-correlation plan from authenticated inspect_managed_members Evidence. Planning does not probe or launch a runtime; it records the configured executable or the default command name, locks the exact artifact SHA-256, MVID, method signature, and decoded-IL hash, and describes requested effects and bounds without claiming execution or confinement.",
    kind: "application",
    inputSchema: managedRuntimeCorrelationReferenceInputSchema,
    outputSchema: runtimeOutputSchema,
    examples: [
      {
        title: "Plan an exact-build managed runtime correlation",
        input: {
          static_members: MANAGED_RUNTIME_CORRELATION_EXAMPLE.static_members,
          method: MANAGED_RUNTIME_CORRELATION_EXAMPLE.method,
          requested_effect:
            MANAGED_RUNTIME_CORRELATION_EXAMPLE.requested_effect,
          host: MANAGED_RUNTIME_CORRELATION_EXAMPLE.host,
          bounds: MANAGED_RUNTIME_CORRELATION_EXAMPLE.bounds,
        },
      },
    ],
  },
  {
    name: "project_managed_application_graph",
    ...toolContractMetadata("project_managed_application_graph"),
    description:
      "Project authenticated managed artifact, member, and native-boundary Evidence into the provider-neutral application graph without executing managed code, loading assemblies, or translating managed metadata tokens to native addresses. The graph preserves managed static observations as managed-specific nodes linked to source Evidence.",
    kind: "application",
    inputSchema: managedApplicationGraphReferenceInputSchema,
    outputSchema: managedApplicationGraphOutputSchema,
    examples: [
      {
        title: "Project static managed observations into an application graph",
        input: {
          managed_members: MANAGED_APPLICATION_GRAPH_EXAMPLE.managed_members,
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
