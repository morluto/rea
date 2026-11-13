import { requireOutputSchema } from "../toolOutputSchemaPrimitives.js";
import { z } from "zod";

import type { ToolContract } from "../toolContractTypes.js";
import { managedOutputSchemas } from "../toolOutputSchemaGroups.js";
import { toolContractMetadata } from "../toolEffects.js";
import { absoluteLocalPathStringSchema } from "../../domain/localPath.js";
import { analysisDetailSchema } from "../analysisDetail.js";
import { managedInspectionBudgetShape } from "../../domain/managed/managedInspectionLimits.js";

/** Exact caller boundary for execution-free PE/CLI triage and identity. */
export const managedTargetInputSchema = z.strictObject({
  ...managedInspectionBudgetShape,
  path: absoluteLocalPathStringSchema
    .describe(
      "Explicit absolute managed PE/CLI path; omit to reuse the previously selected managed target",
    )
    .optional(),
});

/** Delivery selection belongs to artifact and member inspection, not native queries. */
export const managedArtifactInputSchema = managedTargetInputSchema.extend({
  detail: analysisDetailSchema,
});

/** Member inspection may select declaring types before members are decoded. */
export const managedMembersInputSchema = managedArtifactInputSchema.extend({
  type_names: z
    .array(
      z
        .string()
        .min(1)
        .describe(
          "Exact declaring-type full_name: namespace-qualified for top-level types (System.Threading.Monitor); nested types report their bare name, so it selects every nested type of that name",
        ),
    )
    .min(1)
    .refine((names) => new Set(names).size === names.length, {
      message: "type_names must not repeat a name",
    })
    .meta({ uniqueItems: true })
    .describe(
      "Inspect only the fields, methods, call edges, and field accesses declared by these exact type full names, and the user strings their method bodies load; omit to inspect every type. Unmatched names are reported in selection.unmatched_type_names.",
    )
    .optional(),
});

const outputSchema = requireOutputSchema(
  managedOutputSchemas,
  "inspect_managed_artifact",
);
const memberOutputSchema = requireOutputSchema(
  managedOutputSchemas,
  "inspect_managed_members",
);
const nativeBoundaryOutputSchema = requireOutputSchema(
  managedOutputSchemas,
  "inspect_managed_native_boundaries",
);

/** Read-only managed artifact contracts. */
export const MANAGED_TOOL_CONTRACTS = [
  {
    name: "inspect_managed_artifact",
    retainedSummary: { evidenceParameters: "omit-detail" },
    ...toolContractMetadata("inspect_managed_artifact"),
    description:
      "Inspect PE/CLI identity, classification and metadata inventories from an explicit path or selected managed target without loading or executing code. Default complete returns all producer facts; detail summary retains them and returns identity, assembly/MVID, frameworks, coverage and counts. Page references/resources/attributes with inspect_analysis_view kind managed and normalized_result.parent_evidence_id. Counts cover returned rows; partial, malformed and unavailable metadata stay explicit. Tokens are build-local. Use inspect_managed_members for methods, signatures and CIL anchors.",
    kind: "managed-provider",
    inputSchema: managedArtifactInputSchema,
    outputSchema,
    examples: [
      {
        title: "Example inspect managed artifact request",
        input: { path: "/tmp/Example.dll" },
      },
      {
        title:
          "Inspect identity and coverage without unrelated metadata inventories",
        input: { path: "/tmp/Example.dll", detail: "summary" },
      },
    ],
  },
  {
    name: "inspect_managed_members",
    retainedSummary: { evidenceParameters: "omit-detail" },
    ...toolContractMetadata("inspect_managed_members"),
    description:
      "Inspect PE/CLI types, members, signatures, CIL hashes/instruction tuples, exception regions, static calls, field accesses and loaded #US strings without executing code. type_names selects exact declaring types and their body literals; assembly-wide member_refs/exported_types are still included. Tokens remain local to artifact SHA-256/MVID; tuple hashes do not resolve them or fully commit control flow. Default complete returns collections; detail summary retains them for inspect_analysis_view kind managed-members using parent_evidence_id. Page types/exported_types/fields/methods/member_refs/call_edges/field_accesses/user_strings; exact names/declaring_types and fields narrow supported rows. Omit body to avoid IL anchors. Unmatched names and incomplete coverage stay explicit.",
    kind: "managed-provider",
    inputSchema: managedMembersInputSchema,
    outputSchema: memberOutputSchema,
    examples: [
      {
        title: "Example inspect managed members request",
        input: {},
      },
      {
        title: "Example inspect selected managed types request",
        input: {
          path: "/tmp/mscorlib.dll",
          type_names: ["System.Threading.Monitor"],
        },
      },
      {
        title: "Summarize selected managed types and retain their members",
        input: {
          path: "/tmp/mscorlib.dll",
          type_names: ["System.Threading.Monitor"],
          detail: "summary",
        },
      },
    ],
  },
  {
    name: "inspect_managed_native_boundaries",
    ...toolContractMetadata("inspect_managed_native_boundaries"),
    description:
      "Inspect PE/CLI ModuleRef, ImplMap/PInvoke declarations, CLI native-header indicators, and non-IL method implementation flags without loading or executing target code. Results are managed declarations and degraded native-boundary observations, not verified native exports or addresses.",
    kind: "managed-provider",
    inputSchema: managedTargetInputSchema,
    outputSchema: nativeBoundaryOutputSchema,
    examples: [
      {
        title: "Example inspect managed/native boundary request",
        input: {},
      },
    ],
  },
] as const satisfies readonly ToolContract[];

/** Names of execution-free managed static operations. */
export type ManagedToolName = (typeof MANAGED_TOOL_CONTRACTS)[number]["name"];

/** Parse whether an analysis operation belongs to the managed static tools. */
export const isManagedToolName = (name: string): name is ManagedToolName =>
  MANAGED_TOOL_CONTRACTS.some((contract) => contract.name === name);
