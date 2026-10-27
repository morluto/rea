import { requireOutputSchema } from "../toolOutputSchemaPrimitives.js";
import { z } from "zod";
import { evidenceSchema } from "../../domain/evidence.js";
import { compareManagedMembersInputSchema } from "../../domain/managed/managedMemberComparison.js";
import { managedNativeVerificationInputSchema } from "../../domain/managed/managedNativeVerificationSchemas.js";

import { managedReconstructionImportInputSchema } from "../../domain/managed/managedReconstruction.js";
import type { ToolContract } from "../toolContractTypes.js";
import { managedWorkflowOutputSchemas } from "../toolOutputSchemaGroups.js";
import {
  MANAGED_MEMBER_COMPARISON_EXAMPLE,
  MANAGED_NATIVE_VERIFICATION_EXAMPLE,
  MANAGED_APPLICATION_GRAPH_EXAMPLE,
  MANAGED_RECONSTRUCTION_IMPORT_EXAMPLE,
} from "./managedWorkflowExamples.js";
import { toolContractMetadata } from "../toolEffects.js";

const managedApplicationGraphReferenceShape = z.strictObject({
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
      "Compare two authenticated inspect_managed_members Evidence records using unique-only tiers: exact declared type, name, and CIL/signature; exact declared type, name, and signature (decoded or not); exact declared type, name, and decoded structural method shape; then exact CIL/signature or decoded structural method shape alone, which never takes a member whose own declared type and name remain unpaired on the other side or whose declaring type is unresolved. Signatures compare type operands by name, not by build-local metadata row. Names alone are never a matching basis; a member whose signature was not decoded, or whose same-named counterpart's was not, stays unknown rather than added or removed. Matched methods also compare aligned call-site shapes and observed target declaring-type/method names; missing or unaligned call edges and target names remain unknown. These static names do not prove overload identity or runtime dispatch. Metadata tokens remain build-local coordinates bound to each artifact SHA-256 and MVID, and the tuple digest does not itself remap them.",
    kind: "application",
    inputSchema: compareManagedMembersInputSchema,
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
      "Verify managed P/Invoke/native-boundary declarations against authenticated native export or function Evidence without executing managed code or translating managed metadata tokens into native addresses. The workflow preserves declaration-only, verified, inferred, contradicted, and unresolved states; a name candidate with missing managed or native module identity remains unresolved with its candidate evidence retained.",
    kind: "application",
    inputSchema: managedNativeVerificationInputSchema,
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
    inputSchema: managedReconstructionImportInputSchema,
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
    name: "project_managed_application_graph",
    ...toolContractMetadata("project_managed_application_graph"),
    description:
      "Project authenticated managed artifact, member, and native-boundary Evidence into the provider-neutral application graph without executing managed code, loading assemblies, or translating managed metadata tokens to native addresses. The graph preserves managed static observations as managed-specific nodes linked to source Evidence, with in-module calls and field-access edges; other call and field-access sites are counted in limitations.",
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
