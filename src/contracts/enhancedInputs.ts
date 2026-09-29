import { z } from "zod";
import {
  nativeInvestigationEdgeSchema,
  nativeInvestigationGraphSchema,
  nativeInvestigationNodeSchema,
} from "../domain/nativeInvestigationGraph.js";
import {
  nativeDispatchMetadataResultSchema,
  objcSwiftMetadataSchema,
} from "../domain/objcSwiftMetadata.js";

const traceGraphInputSchema = nativeInvestigationGraphSchema.extend({
  nodes: z.array(nativeInvestigationNodeSchema).max(2_000),
  edges: z.array(nativeInvestigationEdgeSchema).max(5_000),
  coverage: z
    .array(
      z.object({
        facet: z.string().min(1),
        status: z.enum(["complete", "partial", "unsupported", "not_requested"]),
        reason: z.string().nullable(),
        examined: z.number().int().nonnegative(),
        omitted: z.number().int().nonnegative(),
      }),
    )
    .max(256),
});

const traceLiteralInputSchema = z.strictObject({
  query: z.string().min(1),
  case_sensitive: z.boolean().default(false),
});

/** Input schemas shared by MCP registration and enhanced application dispatch. */
export const enhancedInputSchemas = {
  inspect_native_dispatch_metadata: z.strictObject({
    max_records: z.number().int().min(1).max(20_000).default(5_000),
  }),
  get_objc_classes: z.strictObject({ pattern: z.string().default("") }),
  get_objc_protocols: z.strictObject({}),
  batch_decompile: z.strictObject({
    addresses: z
      .array(z.string().describe("A provider-normalized procedure address"))
      .default([]),
  }),
  get_call_graph: z.strictObject({
    address: z.string().describe("A provider-normalized procedure address"),
    direction: z.enum(["forward", "backward"]).default("forward"),
  }),
  analyze_swift_types: z.strictObject({
    category: z
      .enum(["classes", "structs", "enums", "protocols", "extensions", "other"])
      .optional()
      .describe("Limit results to one Swift symbol category."),
    pattern: z
      .string()
      .optional()
      .describe(
        "Case-sensitive literal filter applied to mangled symbol names.",
      ),
  }),
  find_xrefs_to_name: z.strictObject({ name: z.string() }),
  binary_overview: z.strictObject({}),
  analyze_function: z.strictObject({
    procedure: z.string().describe("A procedure name or address"),
  }),
  inspect_native_api: z.strictObject({
    procedure: z.string().describe("A procedure name or address"),
  }),
  trace_feature: traceLiteralInputSchema,
  find_code_for_string: traceLiteralInputSchema,
  trace_call_path: z.strictObject({
    start: z.string().describe("A provider-normalized procedure address"),
    goal: z
      .string()
      .describe("An optional provider-normalized destination address")
      .optional(),
    direction: z.enum(["forward", "backward"]).default("forward"),
  }),
  trace_native_investigation: z.strictObject({
    graph: traceGraphInputSchema,
    metadata: z
      .strictObject({
        target_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
        provider: nativeDispatchMetadataResultSchema.shape.provider,
        analysis_profile_digest: z.string().min(1).nullable(),
        result: objcSwiftMetadataSchema,
      })
      .optional(),
    start: z.string().min(1),
    direction: z.enum(["forward", "backward"]).default("forward"),
    max_depth: z.number().int().min(0).max(32).default(8),
    max_nodes: z.number().int().min(1).max(2_000).default(250),
    max_edges: z.number().int().min(1).max(5_000).default(500),
  }),
} as const;

export type EnhancedToolName = keyof typeof enhancedInputSchemas;
