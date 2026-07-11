import { z } from "zod";

/** Input schemas shared by MCP registration and enhanced application dispatch. */
export const enhancedInputSchemas = {
  swift_classes: z.object({ pattern: z.string().default("") }),
  get_objc_classes: z.object({ pattern: z.string().default("") }),
  get_objc_protocols: z.object({}),
  batch_decompile: z.object({
    addresses: z
      .array(z.string().describe("A Hopper address"))
      .max(20)
      .default([]),
  }),
  get_call_graph: z.object({
    address: z.string().describe("A Hopper address"),
    direction: z.enum(["forward", "backward"]).default("forward"),
    depth: z.number().int().min(1).max(5).default(2),
  }),
  analyze_swift_types: z.object({}),
  find_xrefs_to_name: z.object({ name: z.string() }),
  binary_overview: z.object({}),
} as const;

export type EnhancedToolName = keyof typeof enhancedInputSchemas;

/** Runtime parser for dispatching only the eight closed enhanced names. */
export const enhancedToolNameSchema = z.enum([
  "swift_classes",
  "get_objc_classes",
  "get_objc_protocols",
  "batch_decompile",
  "get_call_graph",
  "analyze_swift_types",
  "find_xrefs_to_name",
  "binary_overview",
]);
