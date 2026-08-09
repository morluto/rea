import { z } from "zod";

const traceLiteralInputSchema = z.strictObject({
  query: z.string().min(1),
  case_sensitive: z.boolean().default(false),
  limit: z.number().int().min(1).max(100).default(20),
  max_operations: z.number().int().min(1).max(100).default(20),
  unknown_registry_approved: z
    .literal(true)
    .optional()
    .describe("Explicit approval to record bounded residuals durably"),
});

/** Input schemas shared by MCP registration and enhanced application dispatch. */
export const enhancedInputSchemas = {
  swift_classes: z.strictObject({ pattern: z.string().default("") }),
  get_objc_classes: z.strictObject({ pattern: z.string().default("") }),
  get_objc_protocols: z.strictObject({}),
  batch_decompile: z.strictObject({
    addresses: z
      .array(z.string().describe("A provider-normalized procedure address"))
      .max(20)
      .default([]),
  }),
  get_call_graph: z.strictObject({
    address: z.string().describe("A provider-normalized procedure address"),
    direction: z.enum(["forward", "backward"]).default("forward"),
    depth: z.number().int().min(1).max(5).default(2),
  }),
  analyze_swift_types: z.strictObject({}),
  find_xrefs_to_name: z.strictObject({ name: z.string() }),
  binary_overview: z.strictObject({
    detail: z.enum(["concise", "detailed"]).default("concise"),
    limit: z.number().int().min(1).max(50).default(10),
  }),
  analyze_function: z.strictObject({
    procedure: z.string().describe("A procedure name or address"),
    include_assembly: z.boolean().default(false),
    limit: z.number().int().min(1).max(500).default(100),
    max_pseudocode_chars: z.number().int().min(1).max(100_000).default(20_000),
    max_instructions: z.number().int().min(1).max(5_000).default(500),
    pseudocode_offset: z.number().int().min(0).default(0),
    assembly_offset: z.number().int().min(0).default(0),
    collection_offset: z
      .strictObject({
        comments: z.number().int().min(0).default(0),
        callers: z.number().int().min(0).default(0),
        callees: z.number().int().min(0).default(0),
        incoming_references: z.number().int().min(0).default(0),
        outgoing_references: z.number().int().min(0).default(0),
        referenced_strings: z.number().int().min(0).default(0),
        referenced_names: z.number().int().min(0).default(0),
        basic_blocks: z.number().int().min(0).default(0),
      })
      .default({
        comments: 0,
        callers: 0,
        callees: 0,
        incoming_references: 0,
        outgoing_references: 0,
        referenced_strings: 0,
        referenced_names: 0,
        basic_blocks: 0,
      }),
  }),
  inspect_native_api: z.strictObject({
    procedure: z.string().describe("A procedure name or address"),
    max_pseudocode_chars: z.number().int().min(1).max(100_000).default(20_000),
    max_instructions: z.number().int().min(1).max(5_000).default(500),
    unknown_registry_approved: z
      .literal(true)
      .optional()
      .describe(
        "Explicit approval to record unsupported native API branches durably",
      ),
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
    max_depth: z.number().int().min(1).max(10).default(5),
    max_nodes: z.number().int().min(1).max(500).default(100),
    max_operations: z.number().int().min(1).max(500).default(100),
    unknown_registry_approved: z
      .literal(true)
      .optional()
      .describe("Explicit approval to record bounded residuals durably"),
  }),
} as const;

export type EnhancedToolName = keyof typeof enhancedInputSchemas;

/** Runtime parser for dispatching only the closed enhanced names. */
export const enhancedToolNameSchema = z.enum([
  "swift_classes",
  "get_objc_classes",
  "get_objc_protocols",
  "batch_decompile",
  "get_call_graph",
  "analyze_swift_types",
  "find_xrefs_to_name",
  "binary_overview",
  "analyze_function",
  "inspect_native_api",
  "trace_feature",
  "find_code_for_string",
  "trace_call_path",
]);
