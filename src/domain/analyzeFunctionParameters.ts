/**
 * Zod schema for the `analyze_function` tool's input parameters.
 *
 * This schema lives in the domain layer because it defines the canonical
 * shape of Evidence v2 `parameters` records for `analyze_function` evidence,
 * which is a domain concern. The contracts layer re-exports it as part of
 * the caller-visible tool input catalog.
 */
import { z } from "zod";

/** Input parameters for the `analyze_function` operation. */
export const analyzeFunctionParametersSchema = z.object({
  procedure: z.string().describe("A procedure name or address"),
  include_assembly: z.boolean().default(false),
  limit: z.number().int().min(1).max(500).default(100),
  max_pseudocode_chars: z.number().int().min(1).max(100_000).default(20_000),
  max_instructions: z.number().int().min(1).max(5_000).default(500),
  pseudocode_offset: z.number().int().min(0).default(0),
  assembly_offset: z.number().int().min(0).default(0),
  collection_offset: z
    .object({
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
});

/** Parsed `analyze_function` parameters. */
export type AnalyzeFunctionParameters = z.infer<
  typeof analyzeFunctionParametersSchema
>;
