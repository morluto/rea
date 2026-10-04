import { z } from "zod";

import type { ToolContract } from "./toolContracts.js";
import { artifactOutputSchemas } from "./toolOutputSchemas.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import { toolContractMetadata } from "./toolEffects.js";
import { requireOutputSchema } from "./toolOutputSchemaPrimitives.js";
import { appleAssetCatalogInputSchema } from "../domain/appleAssetCatalog.js";
import { keyedArchiveInputSchema } from "../domain/keyedArchive.js";
const integrityInput = {
  fail: {
    integrity_policy: z.literal("fail").default("fail"),
    integrity_continue_approved: z.literal(false).default(false),
  },
  continue: {
    integrity_policy: z.literal("record-and-continue"),
    integrity_continue_approved: z.literal(true),
  },
} as const;

const artifactInventoryFacts = {
  native_mount_approved: z.boolean().default(false),
} as const;

/** Exact caller boundary for deterministic artifact inventory. */
export const artifactInventoryInputSchema = z.union([
  z.object({ ...artifactInventoryFacts, ...integrityInput.fail }),
  z.object({ ...artifactInventoryFacts, ...integrityInput.continue }),
]);

/** Extraction needs no selector: it materializes every regular child file. */
export const artifactExtractionInputSchema = z.strictObject({});

/** Provider input after the local permission boundary chooses its destination. */
export const artifactExtractionExecutionSchema = z.strictObject({
  output_root: z.string().min(1),
});

const exampleInputSchema = z.record(z.string(), jsonValueSchema);
const examples: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  inspect_artifact: {},
  extract_artifact: {},
  decode_interface_builder: {},
  inspect_asset_catalog: { offset: 0, limit: 1000 },
  inspect_keyed_archive: { path: "Contents/Resources/Model.plist" },
};

const artifact = <
  Name extends string,
  Schema extends z.ZodType<Readonly<Record<string, unknown>>>,
>(
  name: Name,
  description: string,
  inputSchema: Schema,
) => {
  const outputSchema = requireOutputSchema(artifactOutputSchemas, name);
  return {
    name,
    ...toolContractMetadata(name),
    description,
    kind: "artifact-provider",
    inputSchema,
    outputSchema,
    examples: [
      {
        title: `Example ${name.replaceAll("_", " ")} request`,
        input: exampleInputSchema.parse(examples[name] ?? {}),
      },
    ],
  } satisfies ToolContract<Name, Schema, typeof outputSchema>;
};

/** Artifact-graph inventory and safe extraction contracts. */
export const ARTIFACT_TOOL_CONTRACTS = [
  artifact(
    "inspect_artifact",
    "Inspect an active archive or application package in one call. Returns the complete content-addressed artifact graph, source Evidence, observations, relationships, integrity contradictions, hypotheses, unexplored branches, limitations, and next probes inline. It does not extract files; use extract_artifact to materialize its regular contents.",
    artifactInventoryInputSchema,
  ),
  artifact(
    "extract_artifact",
    "Extract all regular files from the active archive or application package into a fresh temporary directory chosen by REA. The result includes its location. Rejects traversal and symlink escapes, never overwrites, enforces archive integrity checks, and verifies cleanup.",
    artifactExtractionInputSchema,
  ),
  artifact(
    "decode_interface_builder",
    "Decode compiled storyboard and nib archives inside the active Apple app bundle, including keyed property lists and NIBArchive object tables, into a bounded object, hierarchy, and connection graph. This is static archive parsing; unrecognized archive classes and unresolved code handlers remain explicit unknowns.",
    z.strictObject({
      max_documents: z.number().int().min(1).max(64).default(64),
      max_objects: z.number().int().min(1).max(20_000).default(20_000),
      max_connections: z.number().int().min(1).max(40_000).default(40_000),
    }),
  ),
  artifact(
    "inspect_keyed_archive",
    "Inspect one Foundation NSKeyedArchiver plist in the active app bundle as original object-table nodes, class descriptors, named roots, and UID edges. Preserves shared and cyclic references without instantiating classes. The path is relative to the bundle; root selection and object pagination preserve original identities.",
    keyedArchiveInputSchema,
  ),
  artifact(
    "inspect_asset_catalog",
    "Inspect compiled Assets.car metadata in an active Apple app bundle. Returns stable paginated catalog and rendition records with raw assetutil metadata and catalog digests; rendition bytes are not extracted.",
    appleAssetCatalogInputSchema,
  ),
] as const satisfies readonly ToolContract[];

/** Provider operations; inventory remains an internal primitive of inspection. */
export const ARTIFACT_ANALYSIS_OPERATIONS = [
  "inventory_artifact",
  ...ARTIFACT_TOOL_CONTRACTS.map(({ name }) => name),
] as const;

/** Provider-level operations including the inventory primitive used internally. */
export type ArtifactAnalysisOperation =
  (typeof ARTIFACT_ANALYSIS_OPERATIONS)[number];
