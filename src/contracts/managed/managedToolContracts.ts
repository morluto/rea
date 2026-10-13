import { z } from "zod";
import { isAbsolute } from "node:path";

import type { ToolContract } from "../toolContractTypes.js";
import { managedOutputSchemas } from "../toolOutputSchemaGroups.js";
import { toolContractMetadata } from "../toolEffects.js";
import { requireOutputSchema } from "../toolOutputSchemaPrimitives.js";
import { localPathStringSchema } from "../../domain/localPath.js";
import { analysisDetailSchema } from "../analysisDetail.js";

/** Exact caller boundary for execution-free PE/CLI triage and identity. */
export const managedTargetInputSchema = z.strictObject({
  path: localPathStringSchema
    .refine(isAbsolute, {
      message:
        "path must be an absolute local filesystem path (for example /tmp/Example.dll or C:\\Example.dll)",
    })
    .describe(
      "Explicit absolute managed PE/CLI path; omit to reuse the previously selected managed target",
    )
    .optional(),
});

/** Delivery selection belongs only to artifact inspection, not member/native queries. */
export const managedArtifactInputSchema = managedTargetInputSchema.extend({
  detail: analysisDetailSchema.unwrap().optional(),
});

/** Member inspection may select declaring types before members are decoded. */
export const managedMembersInputSchema = managedTargetInputSchema.extend({
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
      "Inspect only the fields, methods, call edges, and field accesses declared by these exact type full names; omit to inspect every type. Unmatched names are reported in selection.unmatched_type_names.",
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
    ...toolContractMetadata("inspect_managed_artifact"),
    description:
      'Inspect an explicit PE/CLI path, or the selected managed target, without loading or executing target code. Omitted or complete detail returns complete metadata inventories with original coverage. Select detail: "summary" on the first call for complete identity, PE/CLI, classification with its evidence, module/MVID, assembly, frameworks, returned-collection counts, coverage/issues and limitations. It retains complete Evidence and returns a distinct linked inspect_analysis_view summary. Page original references/resources/attributes with view kind managed and normalized_result.parent_evidence_id. Counts cover producer-returned rows; partial, unavailable or malformed metadata remains explicit and tokens remain build-local.',
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
    ...toolContractMetadata("inspect_managed_members"),
    description:
      "Inspect PE/CLI metadata members, signatures, raw CIL hashes, decoded-instruction-tuple hashes, separately reported exception regions, call edges, and field-access anchors without loading or executing target code. Select type_names to decode only the members of those exact declaring types, which keeps large assemblies such as a base class library within the representation budget. Metadata tokens are reported as build-local coordinates bound to the artifact SHA-256 and MVID; the tuple hash does not resolve them or fully commit control flow.",
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
