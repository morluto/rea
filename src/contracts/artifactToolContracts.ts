import { z } from "zod";

import type { ToolContract } from "./toolContracts.js";
import { artifactOutputSchemas } from "./toolOutputSchemas.js";
import { jsonValueSchema } from "../domain/jsonValue.js";

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

/** Exact caller boundary for deterministic artifact inventory. */
export const artifactInventoryInputSchema = z.object({
  native_mount_approved: z.boolean().default(false),
  ...pageInput,
  ...traversalLimitsInput,
});

/** Exact caller boundary for approved artifact extraction. */
export const artifactExtractionInputSchema = z.object({
  approved: z.literal(true),
  output_root: z.string().min(1).max(4_096),
  occurrence_ids: z
    .array(z.string().regex(/^occ_[a-f0-9]{64}$/u))
    .min(1)
    .max(500),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(500).default(100),
  ...traversalLimitsInput,
});

const exampleInputSchema = z.record(z.string(), jsonValueSchema);
const examples: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  inventory_artifact: {},
  extract_artifact: {
    approved: true,
    output_root: "/tmp/rea-extracted",
    occurrence_ids: [`occ_${"0".repeat(64)}`],
  },
};

const artifact = <Name extends string>(
  name: Name,
  description: string,
  inputSchema: z.ZodObject,
  mutatesFilesystem: boolean,
): ToolContract<Name> => {
  const outputSchema = artifactOutputSchemas[name];
  if (outputSchema === undefined)
    throw new Error(`Missing artifact output schema for ${name}`);
  return {
    name,
    description,
    kind: "artifact-provider",
    inputSchema,
    outputSchema,
    annotations: {
      readOnlyHint: !mutatesFilesystem,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
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
    "Inventory the active application or package as a deterministic, content-addressed artifact graph. Returns bounded node and edge pages without extracting or mounting by default.",
    artifactInventoryInputSchema,
    false,
  ),
  artifact(
    "extract_artifact",
    "Extract selected graph artifacts beneath an explicit output root. Requires approval, rejects traversal and symlink escapes, never overwrites, enforces bomb limits, and verifies cleanup.",
    artifactExtractionInputSchema,
    true,
  ),
] as const satisfies readonly ToolContract[];

/** Names of provider-neutral artifact graph operations. */
export type ArtifactToolName = (typeof ARTIFACT_TOOL_CONTRACTS)[number]["name"];
