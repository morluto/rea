import { z } from "zod";

import type { ToolContract } from "./toolContracts.js";
import { managedOutputSchemas } from "./toolOutputSchemas.js";

/** Exact caller boundary for execution-free PE/CLI triage and identity. */
export const managedArtifactInputSchema = z.object({
  reference_offset: z.number().int().min(0).default(0),
  reference_limit: z.number().int().min(1).max(500).default(100),
  resource_offset: z.number().int().min(0).default(0),
  resource_limit: z.number().int().min(1).max(500).default(100),
  attribute_offset: z.number().int().min(0).default(0),
  attribute_limit: z.number().int().min(1).max(500).default(100),
  max_file_bytes: z
    .number()
    .int()
    .min(4_096)
    .max(1_073_741_824)
    .default(268_435_456),
  max_metadata_bytes: z
    .number()
    .int()
    .min(256)
    .max(268_435_456)
    .default(67_108_864),
  max_table_rows: z.number().int().min(1).max(1_000_000).default(100_000),
  max_heap_item_bytes: z
    .number()
    .int()
    .min(1)
    .max(16_777_216)
    .default(1_048_576),
});

/** Exact caller boundary for execution-free metadata/signature/IL inspection. */
export const managedMemberInputSchema = z.object({
  type_offset: z.number().int().min(0).default(0),
  type_limit: z.number().int().min(1).max(500).default(100),
  method_offset: z.number().int().min(0).default(0),
  method_limit: z.number().int().min(1).max(500).default(100),
  field_offset: z.number().int().min(0).default(0),
  field_limit: z.number().int().min(1).max(500).default(100),
  member_ref_offset: z.number().int().min(0).default(0),
  member_ref_limit: z.number().int().min(1).max(500).default(100),
  edge_offset: z.number().int().min(0).default(0),
  edge_limit: z.number().int().min(1).max(1_000).default(250),
  instruction_anchor_limit: z.number().int().min(0).max(500).default(100),
  max_file_bytes: z
    .number()
    .int()
    .min(4_096)
    .max(1_073_741_824)
    .default(268_435_456),
  max_metadata_bytes: z
    .number()
    .int()
    .min(256)
    .max(268_435_456)
    .default(67_108_864),
  max_table_rows: z.number().int().min(1).max(1_000_000).default(100_000),
  max_heap_item_bytes: z
    .number()
    .int()
    .min(1)
    .max(16_777_216)
    .default(1_048_576),
  max_method_body_bytes: z
    .number()
    .int()
    .min(1)
    .max(16_777_216)
    .default(1_048_576),
  max_method_instructions: z.number().int().min(1).max(100_000).default(10_000),
});

/** Exact caller boundary for execution-free managed/native boundary inspection. */
export const managedNativeBoundaryInputSchema = z.object({
  module_ref_offset: z.number().int().min(0).default(0),
  module_ref_limit: z.number().int().min(1).max(500).default(100),
  import_offset: z.number().int().min(0).default(0),
  import_limit: z.number().int().min(1).max(500).default(100),
  implementation_offset: z.number().int().min(0).default(0),
  implementation_limit: z.number().int().min(1).max(500).default(100),
  max_file_bytes: z
    .number()
    .int()
    .min(4_096)
    .max(1_073_741_824)
    .default(268_435_456),
  max_metadata_bytes: z
    .number()
    .int()
    .min(256)
    .max(268_435_456)
    .default(67_108_864),
  max_table_rows: z.number().int().min(1).max(1_000_000).default(100_000),
  max_heap_item_bytes: z
    .number()
    .int()
    .min(1)
    .max(16_777_216)
    .default(1_048_576),
});

const outputSchema = managedOutputSchemas.inspect_managed_artifact;
if (outputSchema === undefined)
  throw new Error("Missing managed output schema for inspect_managed_artifact");
const memberOutputSchema = managedOutputSchemas.inspect_managed_members;
if (memberOutputSchema === undefined)
  throw new Error("Missing managed output schema for inspect_managed_members");
const nativeBoundaryOutputSchema =
  managedOutputSchemas.inspect_managed_native_boundaries;
if (nativeBoundaryOutputSchema === undefined)
  throw new Error(
    "Missing managed output schema for inspect_managed_native_boundaries",
  );

/** Read-only managed artifact contracts. */
export const MANAGED_TOOL_CONTRACTS = [
  {
    name: "inspect_managed_artifact",
    description:
      "Classify the active PE/CLI artifact and inventory exact assembly/module identity, target framework evidence, references, resources, and custom attributes without loading or executing target code. Returns bounded pages and explicit partial or malformed coverage.",
    kind: "managed-provider",
    inputSchema: managedArtifactInputSchema,
    outputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    examples: [
      {
        title: "Example inspect managed artifact request",
        input: {},
      },
    ],
  },
  {
    name: "inspect_managed_members",
    description:
      "Inspect bounded PE/CLI metadata members, signatures, method body IL hashes, exception regions, call edges, and field-access anchors without loading or executing target code. Metadata tokens are reported as build-local coordinates bound to the artifact SHA-256 and MVID.",
    kind: "managed-provider",
    inputSchema: managedMemberInputSchema,
    outputSchema: memberOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    examples: [
      {
        title: "Example inspect managed members request",
        input: { method_limit: 25, edge_limit: 100 },
      },
    ],
  },
  {
    name: "inspect_managed_native_boundaries",
    description:
      "Inspect PE/CLI ModuleRef, ImplMap/PInvoke declarations, CLI native-header indicators, and non-IL method implementation flags without loading or executing target code. Results are managed declarations and degraded native-boundary observations, not verified native exports or addresses.",
    kind: "managed-provider",
    inputSchema: managedNativeBoundaryInputSchema,
    outputSchema: nativeBoundaryOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    examples: [
      {
        title: "Example inspect managed/native boundary request",
        input: { import_limit: 50, implementation_limit: 50 },
      },
    ],
  },
] as const satisfies readonly ToolContract[];

/** Names of execution-free managed static operations. */
export type ManagedToolName = (typeof MANAGED_TOOL_CONTRACTS)[number]["name"];
