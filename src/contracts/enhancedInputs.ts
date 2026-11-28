import { z } from "zod";
import { nativeDispatchMetadataInputSchema } from "../domain/native/objcSwiftMetadata.js";
import { nativeProcedureInputSchema } from "../domain/native/nativeProcedureInput.js";
import { decompileDirectoryInputSchema } from "./decompileDirectory.js";
import { nativeValueTraceInputSchema } from "../domain/native/nativeValueTrace.js";
import { nativeInvestigationTraceLimitsSchema } from "../domain/native/nativeInvestigationGraph.js";
import { reconstructProcedureHardwareContractInputSchema } from "../domain/firmware/hardwarePeripheralReconstructionSchema.js";
const traceLiteralInputSchema = z.strictObject({
  query: z.string().min(1),
  case_sensitive: z.boolean().default(false),
});

export const DEFAULT_CALL_RELATIONSHIP_DIRECTION = "forward";
export const MAX_ENHANCED_RECORDS = 20_000;
const callRelationshipDirectionSchema = z
  .enum(["forward", "backward"])
  .default(DEFAULT_CALL_RELATIONSHIP_DIRECTION);
export type CallRelationshipDirection = z.output<
  typeof callRelationshipDirectionSchema
>;

/** Input schemas shared by MCP registration and enhanced application dispatch. */
export const enhancedInputSchemas = {
  trace_native_values: nativeValueTraceInputSchema,
  inspect_native_dispatch_metadata: nativeDispatchMetadataInputSchema,
  get_objc_classes: z.strictObject({ pattern: z.string().default("") }),
  get_objc_protocols: z.strictObject({}),
  batch_decompile: z.strictObject({
    addresses: z
      .array(z.string().describe("A provider-normalized procedure address"))
      .max(MAX_ENHANCED_RECORDS)
      .default([]),
  }),
  decompile_all: decompileDirectoryInputSchema,
  get_call_graph: z.strictObject({
    address: z
      .string()
      .describe(
        "A procedure symbol or address to resolve to its canonical entry",
      ),
    direction: callRelationshipDirectionSchema,
    max_depth: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        "Optional maximum traversal depth from the starting procedure (0 inspects only the start node). Omit to traverse the full observed graph.",
      ),
    max_nodes: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        "Optional maximum number of procedures to expand during traversal. Omit to traverse the full observed graph.",
      ),
  }),
  analyze_swift_types: z.strictObject({
    category: z
      .enum(["classes", "structs", "enums", "protocols", "extensions", "other"])
      .optional()
      .describe(
        "Limit categorized results to one Swift category; unresolved category observations remain in unclassified.",
      ),
    pattern: z
      .string()
      .optional()
      .describe(
        "Case-sensitive literal filter applied to provider procedure names and their supporting Swift manglings.",
      ),
  }),
  find_xrefs_to_name: z.strictObject({
    name: z.string(),
    limit: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        "Maximum number of xref addresses to return; omit to return the observed suffix",
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Zero-based starting xref index; defaults to 0"),
  }),
  binary_overview: z.strictObject({}),
  // Provider input excludes delivery detail, which belongs to the MCP tool contract.
  analyze_function: nativeProcedureInputSchema,
  inspect_native_api: nativeProcedureInputSchema,
  reconstruct_procedure_hardware_interactions:
    reconstructProcedureHardwareContractInputSchema,
  trace_feature: traceLiteralInputSchema,
  trace_call_path: z.strictObject({
    start: z.string().describe("A starting procedure symbol or address"),
    goal: z
      .string()
      .describe("An optional destination procedure symbol or address")
      .optional(),
    direction: callRelationshipDirectionSchema,
    max_depth: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        "Optional maximum hop depth from start to expand (0 inspects no outgoing edges; 1 checks direct neighbors). Omit to traverse the full observed graph.",
      ),
    max_nodes: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        "Optional maximum number of procedures to expand during traversal. Omit to traverse the full observed graph.",
      ),
  }),
  trace_native_ui_action: nativeInvestigationTraceLimitsSchema.extend({
    action: z
      .string()
      .min(1)
      .describe(
        "A unique compiled UI action selector, interface object ID, native symbol or exact function address",
      ),
  }),
} as const;

export type EnhancedToolName = keyof typeof enhancedInputSchemas;
