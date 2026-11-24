import { z } from "zod";
import { functionFacetAvailabilitySchema } from "../../native/functionDossier.js";
import { summaryViewResultBase } from "../analysisViewBase.js";

/** Rows observed for one facet, or null when the provider declared that facet unavailable. */
const declaredFacetCountSchema = z
  .number()
  .int()
  .nonnegative()
  .nullable()
  .describe(
    "Observed rows; null when facet_availability declares the facet unavailable, so no rows is not evidence of none.",
  );

/** Rows of an optional dossier record, or null when the dossier omitted it. */
const recordedFacetCountSchema = z
  .number()
  .int()
  .nonnegative()
  .nullable()
  .describe(
    "Observed rows; null when the dossier did not record the facet (the native facet view reports it not recorded), so no rows is not evidence of none.",
  );

/** Rows of one value-flow facet, or null when value flow is unavailable. */
const valueFlowFacetCountSchema = z
  .number()
  .int()
  .nonnegative()
  .nullable()
  .describe(
    "Observed rows; null when value_flow.available is false because native_value_flow was not recorded or the provider declared it unavailable (unknowns names which), so no rows is not evidence of none.",
  );

/** Compact analyze_function dossier; the complete dossier stays retained for facet paging. */
const nativeFunctionSummarySchema = z.strictObject({
  procedure: z.strictObject({
    name: z.string(),
    address: z.string(),
  }),
  pseudocode: z.strictObject({
    available: z
      .boolean()
      .describe(
        "Provider facet_availability for pseudocode when declared; otherwise whether decompiled text is present. The flag is authoritative over raw length.",
      ),
    code_units: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "Pseudocode length in UTF-16 code units, the unit inspect_analysis_view pages pseudocode by.",
      ),
  }),
  value_flow: z.strictObject({
    available: z.boolean(),
    truncated: z
      .boolean()
      .nullable()
      .describe(
        "Whether the provider truncated available value-flow; null when value-flow is unavailable (see available).",
      ),
  }),
  facet_availability: functionFacetAvailabilitySchema
    .nullable()
    .describe(
      "The provider's declared availability per facet, or null when it declared none. Unavailable facets name their reason here and in unknowns.",
    ),
  counts: z.strictObject({
    assembly: declaredFacetCountSchema,
    basic_blocks: declaredFacetCountSchema,
    comments: declaredFacetCountSchema,
    callers: declaredFacetCountSchema,
    callees: declaredFacetCountSchema,
    incoming_references: declaredFacetCountSchema,
    outgoing_references: declaredFacetCountSchema,
    unresolved_calls: recordedFacetCountSchema,
    referenced_strings: declaredFacetCountSchema,
    referenced_names: declaredFacetCountSchema,
    swift_string_literals: recordedFacetCountSchema,
    swift_string_literal_omissions: recordedFacetCountSchema,
    prototype_conflicts: recordedFacetCountSchema.optional(),
    value_flow_operations: valueFlowFacetCountSchema,
    value_flow_def_use: valueFlowFacetCountSchema,
    value_flow_effects: valueFlowFacetCountSchema,
    value_flow_parameters: valueFlowFacetCountSchema,
    value_flow_parameter_uses: valueFlowFacetCountSchema,
  }),
  limitation_count: z.number().int().nonnegative(),
});

/** Compact analyze_function summary that retains the complete native dossier Evidence. */
export const nativeFunctionSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  parent_operation: z.literal("analyze_function"),
  procedure_address: z.string().nullable(),
  summary: nativeFunctionSummarySchema,
});
