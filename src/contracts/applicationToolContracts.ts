import {
  applicationVersionComparisonResultSchema,
  compareApplicationVersionsInputSchema,
} from "../domain/javascriptApplicationVersionComparisonSchemas.js";
import {
  applicationFeatureTraceResultSchema,
  traceApplicationFeatureInputSchema,
} from "../domain/javascriptFeatureTraceSchemas.js";
import { evidenceEnvelopeSchema } from "../domain/evidence.js";
import type { ToolContract } from "./toolContracts.js";
import {
  JAVASCRIPT_APPLICATION_VERSION_COMPARISON_EXAMPLE,
  JAVASCRIPT_FEATURE_TRACE_EXAMPLE,
} from "./javascriptApplicationWorkflowExamples.js";

const traceOutputSchema = evidenceEnvelopeSchema
  .omit({ normalized_result: true })
  .extend({ normalized_result: applicationFeatureTraceResultSchema });
const comparisonOutputSchema = evidenceEnvelopeSchema
  .omit({ normalized_result: true })
  .extend({ normalized_result: applicationVersionComparisonResultSchema });

/** Provider-neutral graph workflow contracts shared by MCP and CLI adapters. */
export const APPLICATION_TOOL_CONTRACTS = [
  {
    name: "trace_application_feature",
    description:
      "Trace a typed literal seed through an authenticated JavaScript Application Graph with explicit direction, depth, node, edge, and path bounds. Original static, native, passive-runtime, inferred, and unknown authorities remain distinct; native addon handoffs never open a provider or execute the application.",
    kind: "application",
    inputSchema: traceApplicationFeatureInputSchema,
    outputSchema: traceOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    examples: [
      {
        title: "Trace one module seed through a retained application graph",
        input: JAVASCRIPT_FEATURE_TRACE_EXAMPLE,
      },
    ],
  },
  {
    name: "compare_application_versions",
    description:
      "Compare two authenticated JavaScript Application Graph versions using unique-only exact digest, module source digest, source-map identity, structural fingerprint, and non-module semantic-key tiers. Reports added, removed, changed, ambiguous, and unknown entities plus a bounded changed_from graph without fuzzy or module-ordinal pairing.",
    kind: "application",
    inputSchema: compareApplicationVersionsInputSchema,
    outputSchema: comparisonOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    examples: [
      {
        title: "Compare authenticated static and reconciled application graphs",
        input: JAVASCRIPT_APPLICATION_VERSION_COMPARISON_EXAMPLE,
      },
    ],
  },
] as const satisfies readonly ToolContract[];
