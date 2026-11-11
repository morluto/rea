import { requireOutputSchema } from "./toolOutputSchemaPrimitives.js";
import { z } from "zod";

import { artifactOccurrenceSchema } from "../domain/artifactGraph.js";

import type { ToolContract } from "./toolContractTypes.js";
import { artifactOutputSchemas } from "./toolOutputSchemaGroups.js";
import { artifactIntegrityPolicySchema } from "../domain/artifactIntegrityPolicy.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import { toolContractMetadata } from "./toolEffects.js";
import { appleAssetCatalogInputSchema } from "../domain/apple/appleAssetCatalog.js";
import { dylibResolutionInputSchema } from "../domain/apple/dylibResolution.js";
import { keyedArchiveInputSchema } from "../domain/apple/keyedArchive.js";
import { absoluteLocalPathStringSchema } from "../domain/localPath.js";
import { analysisDetailSchema } from "./analysisDetail.js";
import { artifactReaderLimitsInputSchema } from "../domain/artifactReaderLimits.js";
/** Exact caller boundary for deterministic artifact inventory. */
export const artifactInventoryInputSchema = z.strictObject({
  integrity_policy: artifactIntegrityPolicySchema,
  artifact_limits: artifactReaderLimitsInputSchema
    .exactOptional()
    .describe(
      "Per-call Bun, .NET bundle, Node SEA and Godot producer admission, plus optional aggregate expanded plaintext work. Omitted fields retain existing defaults; changes apply on the next call without restart. Independent of summary/paging and MCP response limits.",
    ),
});

/** Delivery selection belongs to the adapter, not the inventory producer. */
export const artifactInspectionInputSchema =
  artifactInventoryInputSchema.extend({
    detail: analysisDetailSchema
      .unwrap()
      .optional()
      .describe(
        "Omitted or complete returns the complete inspection Evidence. summary retains that complete Evidence in this session and returns its inspect_analysis_view summary; use normalized_result.parent_evidence_id for inventory views.",
      ),
  });

/** Omitted selection preserves complete extraction of the active reader. */
export const artifactExtractionInputSchema = z.strictObject({
  artifact_limits: artifactInventoryInputSchema.shape.artifact_limits,
  integrity_policy: artifactIntegrityPolicySchema,
  output_root: absoluteLocalPathStringSchema
    .exactOptional()
    .describe(
      "Absolute destination path on the REA host. It must not exist and its parent must exist. Omit to use a fresh temporary directory. Successful output persists after the call.",
    ),
  occurrence_ids: z
    .array(artifactOccurrenceSchema.shape.occurrence_id)
    .min(1)
    .refine(
      (ids) => new Set(ids).size === ids.length,
      "Occurrence IDs must be unique",
    )
    .meta({ uniqueItems: true })
    .exactOptional()
    .describe(
      "Exact regular-file or slice occurrence IDs from the current inventory. Omit to extract all regular entries exposed by the active reader. Directories, links, the root and members inside nested archives cannot be selected.",
    ),
});

/** Provider input after the adapter has supplied the optional destination. */
export const artifactExtractionExecutionSchema =
  artifactExtractionInputSchema.extend({
    output_root: artifactExtractionInputSchema.shape.output_root.unwrap(),
  });

const exampleInputSchema = z.record(z.string(), jsonValueSchema);
const examples: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  inspect_artifact: { detail: "summary" },
  extract_artifact: {},
  decode_interface_builder: {},
  inspect_asset_catalog: { offset: 0, limit: 1000 },
  inspect_keyed_archive: { path: "Contents/Resources/Model.plist" },
  trace_dylib_resolution: {
    roots: ["Contents/MacOS/App"],
    architecture: "arm64",
  },
};

const artifact = <
  Name extends keyof typeof artifactOutputSchemas,
  Schema extends z.ZodType<Readonly<Record<string, unknown>>>,
>(
  name: Name,
  description: string,
  inputSchema: Schema,
  retainedSummary?: ToolContract["retainedSummary"],
) => {
  const outputSchema = requireOutputSchema(artifactOutputSchemas, name);
  return {
    name,
    ...toolContractMetadata(name),
    description,
    kind: "artifact-provider",
    requiresActiveTarget: true,
    ...(retainedSummary === undefined ? {} : { retainedSummary }),
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
    "Inventory the active archive, app package, firmware container or supported packaged executable without running it. Returns nested content-addressed inventory Evidence with integrity observations, unexplored branches and next probes. Default complete returns the full graph; detail summary retains it for inspect_analysis_view kind inventory using parent_evidence_id, exact paths/IDs, fields and paging. Summary changes delivery, not inventory coverage. Bun/Node SEA/Deno carriers expose stored modules/assets and recorded metadata; opaque bytecode and npm snapshots are not decoded. Local Evidence can include environment-file values and certificate bytes. Classic iNES adds file-region/reconstruction facts, not mapper execution. Integrity mismatches fail unless record-and-continue explicitly retains untrusted contradictions. Supported macOS DMGs are mounted read-only. Use extract_artifact to materialize regular contents; DMGs instead need a caller-managed read-only mount.",
    artifactInspectionInputSchema,
    { evidenceParameters: "preserve-detail" },
  ),
  artifact(
    "extract_artifact",
    "Write all or selected regular files from the active supported archive to an absent absolute output_root, or a fresh temporary directory if omitted. Use exact inventory occurrence_ids to select files. Returns IDs and actual output paths; successful files persist. Nested archives are copied, not recursively unpacked. Never overwrites; rejects traversal/symlink escapes and verifies cleanup. Full-input integrity checks still apply: mismatches fail unless record-and-continue retains explicitly untrusted contradictions. DMG extraction is unavailable; use a caller-managed read-only mount on macOS.",
    artifactExtractionInputSchema,
  ),
  artifact(
    "decode_interface_builder",
    "Decode compiled storyboard and nib archives inside the active Apple app bundle, including keyed property lists and NIBArchive object tables, into a bounded object, hierarchy, and connection graph. This is static archive parsing; unrecognized archive classes and unresolved code handlers remain explicit unknowns. A full app graph is often several megabytes; detail summary retains it and returns documents with node, edge and coverage counts, then page rows, optionally one document's, with inspect_analysis_view kind interface-builder.",
    z.strictObject({
      max_documents: z.int().min(1).max(64).default(64),
      max_objects: z.int().min(1).max(20_000).default(20_000),
      max_connections: z.int().min(1).max(40_000).default(40_000),
      detail: analysisDetailSchema
        .unwrap()
        .optional()
        .describe(
          "Omitted or complete returns the complete decoded graph Evidence. summary retains that complete Evidence in this session and returns its inspect_analysis_view summary; use normalized_result.parent_evidence_id for interface-builder pages.",
        ),
    }),
    { evidenceParameters: "omit-detail" },
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
  artifact(
    "trace_dylib_resolution",
    "Trace how dyld would resolve each Mach-O dylib load for the active Mach-O, or for every executable in the active .app bundle (the main app, XPC services, extensions, login items, helpers). Expands @executable_path, @loader_path, and @rpath through each process's LC_RPATH stack in dependents-first load order, and reports every candidate path with its outcome, the resolved image and digest, weak, re-export, upward, and lazy-load flags, including LC_LAZY_LOAD_DYLIB_INFO linkedit payloads, and derived findings such as unresolved required loads or absent earlier @rpath candidates. Pure header parsing: nothing is executed, and absolute or system paths outside the analyzed root stay undetermined. Select roots or one architecture to narrow large bundles.",
    dylibResolutionInputSchema,
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
