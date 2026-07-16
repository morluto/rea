import {
  applicationVersionComparisonResultSchema,
  compareApplicationVersionsInputSchema,
} from "../domain/javascriptApplicationVersionComparisonSchemas.js";
import {
  applicationFeatureTraceResultSchema,
  traceApplicationFeatureInputSchema,
} from "../domain/javascriptFeatureTraceSchemas.js";
import { evidenceEnvelopeSchema } from "../domain/evidence.js";
import {
  controlledReplayInputSchema,
  controlledReplayOutputSchema,
} from "../domain/javascriptReplay.js";
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
  {
    name: "run_controlled_replay",
    description:
      "Plan or execute a content-bound extracted-module JavaScript replay inside the Linux Bubblewrap, seccomp, and cgroup boundary. Execution requires approved: true and the exact plan digest. Supports deterministic boundary cases and optional left/right differential comparison; observations have controlled-replay authority and do not claim real application runtime behavior.",
    kind: "application",
    inputSchema: controlledReplayInputSchema,
    outputSchema: controlledReplayOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    examples: [
      {
        title: "Plan one extracted ESM parser replay",
        input: {
          mode: "plan",
          left: {
            modules: [
              {
                alias: "parser",
                path: "/approved/parser.mjs",
                format: "esm",
                role: "module",
                dependencies: {},
              },
            ],
            entry_alias: "parser",
            entry_export: "default",
          },
          cases: [{ case_id: "empty", arguments: [""] }],
          determinism: {
            clock_iso: "2000-01-01T00:00:00.000Z",
            random_seed: 0,
            locale: "en-US",
            timezone: "UTC",
            platform: "linux",
          },
          limits: {
            wall_time_ms: 3000,
            memory_bytes: 134217728,
            tasks: 8,
            cpu_quota_percent: 50,
            tmpfs_bytes: 16777216,
            module_bytes: 4194304,
            input_bytes: 262144,
            protocol_bytes: 16777216,
            output_bytes: 524288,
            stderr_bytes: 32768,
            result_depth: 16,
            result_nodes: 10000,
          },
          approved: false,
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
