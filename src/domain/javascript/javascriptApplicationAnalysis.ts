import { z } from "zod";

import {
  javascriptApplicationGraphSchema,
  isValidatedImmutableJavaScriptApplicationGraph,
  type JavaScriptApplicationGraph,
} from "./javascriptApplicationGraph.js";
import {
  javaScriptSemanticGraphSchema,
  isValidatedImmutableJavaScriptSemanticGraph,
  type JavaScriptSemanticGraph,
} from "./javascriptSemanticGraph.js";
import { digestSchema } from "../digests.js";
import { prefixedDigestSchema } from "../digests.js";
import { integrityContradictionSchema } from "../artifactGraph.js";
import { localPathStringSchema } from "../localPath.js";

const countSchema = z.number().int().min(0);

/** Public target-free request for static JavaScript application analysis. */
export const analyzeJavaScriptApplicationInputSchema = z.strictObject({
  input_path: localPathStringSchema,
  format: z.enum(["auto", "asar", "directory"]).default("auto"),
  integrity_policy: z.enum(["fail", "record-and-continue"]).default("fail"),
});

/** Compact counts for the high-level Electron architecture/security surface. */
const electronBoundarySummarySchema = z.strictObject({
  browser_windows: countSchema,
  explicit_web_preferences: countSchema,
  preload_entrypoints: countSchema,
  context_bridge_apis: countSchema,
  exposed_api_members: countSchema,
  ipc: z.strictObject({
    operations: countSchema,
    literal_channels: countSchema,
    dynamic_channel_operations: countSchema,
    renderer_transmissions: countSchema,
    renderer_listeners: countSchema,
    main_handlers: countSchema,
    paired_renderer_transmissions: countSchema,
    ambiguous_renderer_transmissions: countSchema,
    unpaired_literal_renderer_transmissions: countSchema,
  }),
  sender_validation_observations: countSchema,
  utility_processes: countSchema,
  resolved_utility_entrypoints: countSchema,
  native_addon_bindings: countSchema,
  resolved_native_addon_bindings: countSchema,
});

const reconstructionStatisticsSchema = z.strictObject({
  relevant_files: countSchema,
  nested_asar_containers: countSchema,
  text_bytes_read: countSchema,
  invalid_utf8_files: countSchema,
  parsed_javascript_files: countSchema,
  visited_ast_nodes: countSchema,
  findings: countSchema,
  modules: countSchema,
  parse_failures: countSchema,
});

const applicationAnalysisResultShape = z.strictObject({
  input_path: z.string().min(1),
  format: z.enum(["asar", "directory"]),
  root_artifact_sha256: digestSchema,
  inventory_manifest_id: prefixedDigestSchema("agm"),
  inventory_graph_sha256: digestSchema,
  integrity_contradictions: z.array(integrityContradictionSchema),
  graph: javascriptApplicationGraphSchema,
  summary: electronBoundarySummarySchema,
  statistics: reconstructionStatisticsSchema,
  limitations: z.array(z.string().min(1)),
  semantic_graph: javaScriptSemanticGraphSchema,
});

type BindingIssue = {
  readonly code: "custom";
  readonly path: PropertyKey[];
  readonly message: string;
};

function* checkApplicationBindingsSteps(
  result: z.infer<typeof applicationAnalysisResultShape>,
  context: { readonly addIssue: (issue: BindingIssue) => void },
): Generator<void> {
  if (result.semantic_graph.application_graph_id !== result.graph.graph_id)
    context.addIssue({
      code: "custom",
      path: ["semantic_graph", "application_graph_id"],
      message: "Semantic graph must commit the containing application graph",
    });
  if (
    result.semantic_graph.root_artifact_sha256 !== result.root_artifact_sha256
  )
    context.addIssue({
      code: "custom",
      path: ["semantic_graph", "root_artifact_sha256"],
      message: "Semantic graph must commit the containing root artifact",
    });
  const applicationNodeIds = new Set<string>();
  let examined = 0;
  try {
    for (const node of result.graph.nodes) {
      applicationNodeIds.add(node.node_id);
      if (++examined === 4096) {
        examined = 0;
        yield;
      }
    }
    for (const [nodeIndex, node] of result.semantic_graph.nodes.entries()) {
      if (++examined === 4096) {
        examined = 0;
        yield;
      }
      for (const [
        identifierIndex,
        identifier,
      ] of node.application_node_ids.entries()) {
        if (!applicationNodeIds.has(identifier))
          context.addIssue({
            code: "custom",
            path: [
              "semantic_graph",
              "nodes",
              nodeIndex,
              "application_node_ids",
              identifierIndex,
            ],
            message: "Semantic node references an absent application node",
          });
        if (++examined === 4096) {
          examined = 0;
          yield;
        }
      }
    }
  } finally {
    applicationNodeIds.clear();
  }
}

/** JavaScript application analysis with an authenticated semantic companion. */
export const javascriptApplicationAnalysisResultSchema =
  applicationAnalysisResultShape.superRefine((result, context) => {
    const steps = checkApplicationBindingsSteps(result, context);
    while (!steps.next().done) {
      // Public/imported results still receive complete synchronous validation.
    }
  });

const ownedAnalysisResultShape = applicationAnalysisResultShape.extend({
  graph: z.custom<JavaScriptApplicationGraph>(
    isValidatedImmutableJavaScriptApplicationGraph,
  ),
  semantic_graph: z.custom<JavaScriptSemanticGraph>(
    isValidatedImmutableJavaScriptSemanticGraph,
  ),
});

/** Reuse exact owned graphs while validating metadata and cross-graph bindings. */
export function* parseOwnedJavaScriptApplicationAnalysisSteps(
  input: unknown,
): Generator<void, JavaScriptApplicationAnalysisResult> {
  const prepared = ownedAnalysisResultShape.safeParse(input);
  if (!prepared.success)
    return javascriptApplicationAnalysisResultSchema.parse(input);
  const issues: BindingIssue[] = [];
  yield* checkApplicationBindingsSteps(prepared.data, {
    addIssue: (issue) => {
      issues.push(issue);
    },
  });
  if (issues.length > 0) throw new z.ZodError(issues);
  return prepared.data;
}

/** Parsed public JavaScript application analysis request. */
export type AnalyzeJavaScriptApplicationInput = z.infer<
  typeof analyzeJavaScriptApplicationInputSchema
>;

/** Validated high-level JavaScript application analysis result. */
export type JavaScriptApplicationAnalysisResult = z.infer<
  typeof javascriptApplicationAnalysisResultSchema
>;

/** Validated high-level Electron boundary counts. */
export type ElectronBoundarySummary = z.infer<
  typeof electronBoundarySummarySchema
>;
