import { isAbsolute } from "node:path";
import { z } from "zod";

import type { ToolContract } from "./toolContracts.js";
import { artifactOutputSchemas } from "./toolOutputSchemas.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import { toolContractMetadata } from "./toolEffects.js";
import { requireOutputSchema } from "./toolOutputSchemaPrimitives.js";
import { artifactInspectionLimitsSchema } from "../domain/artifactInspection.js";

const pageInput = {
  node_offset: z.number().int().min(0).default(0),
  node_limit: z.number().int().min(1).max(500).default(100),
  occurrence_offset: z.number().int().min(0).default(0),
  occurrence_limit: z.number().int().min(1).max(500).default(100),
  edge_offset: z.number().int().min(0).default(0),
  edge_limit: z.number().int().min(1).max(500).default(100),
};

const traversalLimitsInput = {
  max_entries: z.number().int().min(1).max(1_000_000).default(10_000),
  max_total_bytes: z
    .number()
    .int()
    .min(1)
    .max(Number.MAX_SAFE_INTEGER)
    .default(1_073_741_824),
  max_entry_bytes: z
    .number()
    .int()
    .min(1)
    .max(Number.MAX_SAFE_INTEGER)
    .default(268_435_456),
  max_compression_ratio: z.number().min(1).max(100_000).default(1_000),
  max_depth: z.number().int().min(0).max(100).default(20),
  max_path_bytes: z.number().int().min(1).max(65_535).default(4_096),
};

const integrityInput = {
  fail: {
    integrity_policy: z.literal("fail").default("fail"),
    integrity_continue_approved: z.literal(false).default(false),
    max_integrity_mismatches: z.number().int().min(1).max(100).default(10),
  },
  continue: {
    integrity_policy: z.literal("record-and-continue"),
    integrity_continue_approved: z.literal(true),
    max_integrity_mismatches: z.number().int().min(1).max(100).default(10),
  },
} as const;

const artifactInventoryFacts = {
  native_mount_approved: z.boolean().default(false),
  ...pageInput,
  ...traversalLimitsInput,
} as const;

/** Exact caller boundary for deterministic artifact inventory. */
export const artifactInventoryInputSchema = z.union([
  z.object({ ...artifactInventoryFacts, ...integrityInput.fail }),
  z.object({ ...artifactInventoryFacts, ...integrityInput.continue }),
]);

/** Exact caller boundary for approved artifact extraction. */
export const artifactExtractionInputSchema = z.object({
  approved: z.literal(true),
  output_root: z
    .string()
    .min(1)
    .max(4_096)
    .refine(isAbsolute, "Extraction output root must be absolute"),
  occurrence_ids: z
    .array(z.string().regex(/^occ_[a-f0-9]{64}$/u))
    .min(1)
    .max(500),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(500).default(100),
  ...traversalLimitsInput,
});

/** Bounded provider-neutral inspection using one atomic inventory substep. */
const artifactInspectionFacts = {
  native_mount_approved: z.boolean().default(false),
  ...artifactInspectionLimitsSchema.shape,
  ...traversalLimitsInput,
} as const;
export const artifactInspectionInputSchema = z.union([
  z.object({ ...artifactInspectionFacts, ...integrityInput.fail }),
  z.object({ ...artifactInspectionFacts, ...integrityInput.continue }),
]);

const exampleInputSchema = z.record(z.string(), jsonValueSchema);
const examples: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  inventory_artifact: {},
  inspect_artifact: {},
  extract_artifact: {
    approved: true,
    output_root: "/tmp/rea-extracted",
    occurrence_ids: [`occ_${"0".repeat(64)}`],
  },
};

const artifact = <Name extends string>(
  name: Name,
  description: string,
  inputSchema: z.ZodType<Readonly<Record<string, unknown>>>,
): ToolContract<Name> => {
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
  };
};

/** Artifact-graph inventory and explicitly approved safe extraction contracts. */
export const ARTIFACT_TOOL_CONTRACTS = [
  artifact(
    "inventory_artifact",
    "After open_binary binds a local archive, application package, or other artifact—or when one is already active—inventory it as a deterministic, content-addressed artifact graph. This tool accepts no path; in a target-free session open the target first. Returns bounded node and edge pages without extracting or mounting by default.",
    artifactInventoryInputSchema,
  ),
  artifact(
    "inspect_artifact",
    "After open_binary binds a local archive, application package, or other artifact—or when one is already active—inspect it through one bounded, cancellable inventory substep. This tool accepts no path; in a target-free session open the target first. Returns the full substep Evidence and its ID, observations, derived relationships, hypotheses, contradictions, unexplored branches, limitations, and format-specific next probes. Any substep failure fails the whole call.",
    artifactInspectionInputSchema,
  ),
  artifact(
    "extract_artifact",
    "Extract selected graph artifacts beneath an explicit output root. Requires approval, rejects traversal and symlink escapes, never overwrites, enforces bomb limits, and verifies cleanup.",
    artifactExtractionInputSchema,
  ),
] as const satisfies readonly ToolContract[];

/** Names of provider-neutral artifact graph operations. */
export type ArtifactToolName = (typeof ARTIFACT_TOOL_CONTRACTS)[number]["name"];
