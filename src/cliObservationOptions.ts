import { javascriptRouteDeliveryOptions } from "./cli/javascriptRouteDelivery.js";
import { z } from "incur";
import { webRuntimeCommandTimeoutSchema } from "./domain/browserDeadline.js";
import {
  JAVASCRIPT_SEMANTIC_ITEM_MAXIMUM,
  JAVASCRIPT_WORKER_HEAP_MIB_MAXIMUM,
  JAVASCRIPT_WORKER_HEAP_MIB_MINIMUM,
} from "./domain/javascript/javascriptAnalysisResourceControls.js";
import { cliIntegerArgument } from "./cli/options.js";
import { javaScriptSourcePathsSchema } from "./domain/javascript/javascriptSourceSelection.js";

/** Accept an agent-selected browser observation duration without an artificial ceiling. */
export const observationDuration = (fallback: number, minimum = 0) => {
  const duration = z.number().int().min(minimum);
  // Keep argv text until its presence is checked. Incur eagerly converts a
  // ZodNumber field with Number(), which turns empty/blank selections into 0.
  const selected = z
    .union([
      duration,
      z
        .string()
        .regex(/\S/u, "Expected a nonempty observation duration")
        .pipe(z.coerce.number<string>())
        .pipe(duration),
    ])
    .default(fallback)
    .describe("Observation duration in milliseconds");
  // Incur advertises Zod's output view for CLI inputs. Publish this field's
  // input view so the lexical guard survives the SDK conversion as well.
  const { $schema: _dialect, ...inputSchema } = z.toJSONSchema(selected, {
    io: "input",
  });
  return selected.meta(inputSchema);
};

/** Shared passive browser origin options. */
export const browserScopeOptions = {
  allowedOrigins: z
    .array(z.string().min(1))
    .optional()
    .describe("Optional exact-origin filter"),
  commandTimeoutMs: webRuntimeCommandTimeoutSchema,
};

/** Keep an omitted command deadline absent so Evidence records the caller selection only. */
export const selectedCommandTimeout = (
  commandTimeoutMs: number | undefined,
): { readonly command_timeout_ms?: number } =>
  commandTimeoutMs === undefined
    ? {}
    : { command_timeout_ms: commandTimeoutMs };

export const browserPageInspectionOptions = z.object({
  ...browserScopeOptions,
  observationMs: observationDuration(500),
  includeAccessibilityText: z
    .boolean()
    .default(false)
    .describe("Include accessibility text"),
  includeConsoleText: z
    .boolean()
    .default(false)
    .describe("Include console message text"),
  includeJsonBodyShapes: z
    .boolean()
    .default(false)
    .describe("Include structural shapes of JSON response bodies"),
  includeWebsocketShapes: z
    .boolean()
    .default(false)
    .describe("Include structural shapes of WebSocket payloads"),
  includeScriptSources: z
    .boolean()
    .default(false)
    .describe("Include JavaScript source text"),
  includeStorageKeys: z
    .boolean()
    .default(false)
    .describe("Include storage key names without values"),
  includeStorageFingerprints: z
    .boolean()
    .default(false)
    .describe("Include content-derived storage fingerprints"),
});

export const electronPageInspectionOptions = z.object({
  observationMs: observationDuration(100),
  includeScriptSources: z
    .boolean()
    .default(false)
    .describe("Include JavaScript source text"),
  commandTimeoutMs: webRuntimeCommandTimeoutSchema,
});

export const javascriptApplicationOptions = z.object({
  ...javascriptRouteDeliveryOptions,
  // incur only coerces ZodNumber argv fields; domain z.int() constructs
  // ZodNumberFormat. Preserve the canonical bounds in this CLI adapter.
  maxSemanticNodes: cliIntegerArgument(1, JAVASCRIPT_SEMANTIC_ITEM_MAXIMUM)
    .optional()
    .describe(
      "Maximum retained semantic nodes across the application; defaults to 100000. Worker heap and parent result admission remain enforced.",
    ),
  maxSemanticNodesPerFile: cliIntegerArgument(
    1,
    JAVASCRIPT_SEMANTIC_ITEM_MAXIMUM,
  )
    .optional()
    .describe(
      "Maximum retained semantic nodes per source file; defaults to 20000, additionally bounded by max_semantic_nodes and memory/transfer limits.",
    ),
  maxSemanticUnknowns: cliIntegerArgument(1, JAVASCRIPT_SEMANTIC_ITEM_MAXIMUM)
    .optional()
    .describe(
      "Maximum retained semantic unknown records across the application; defaults to 100000. Omitted emission occurrences are counted by family and reason.",
    ),
  maxSemanticUnknownsPerFile: cliIntegerArgument(
    1,
    JAVASCRIPT_SEMANTIC_ITEM_MAXIMUM,
  )
    .optional()
    .describe(
      "Maximum retained semantic unknown records per source file; defaults to 20000, additionally bounded by max_semantic_unknowns and memory/transfer limits.",
    ),
  sourcePath: javaScriptSourcePathsSchema
    .optional()
    .describe(
      "Exact inventoried file path relative to the application root; repeat to select several. No implicit dependencies.",
    ),
  sourcePathsJson: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Inline JSON array or JSON file path of exact inventoried file paths relative to the application root, selected after any --source-path values. Use a file for selections that exceed the host command-line limit.",
    ),
  maxHeapMb: cliIntegerArgument(
    JAVASCRIPT_WORKER_HEAP_MIB_MINIMUM,
    JAVASCRIPT_WORKER_HEAP_MIB_MAXIMUM,
  )
    .optional()
    .describe(
      "Maximum V8 old-space heap in MiB for the isolated JavaScript source analyzer; defaults to 1024. This does not change the CLI/MCP process heap. When REA runs on Bun, which ignores V8 heap flags, Windows instead limits the analyzer's committed memory to this budget plus a 512 MiB runtime reserve; other Bun hosts enforce no limit.",
    ),
  analysisTimeoutMs: cliIntegerArgument(1, 2_147_483_647)
    .optional()
    .describe(
      "Maximum startup, analysis and transfer time per JavaScript source, in milliseconds; defaults to 300000. On timeout, return collected partial Evidence and stop the analysis.",
    ),
  artifactFormat: z
    .enum(["auto", "asar", "directory"])
    .default("auto")
    .describe("Application artifact format"),
  integrityPolicy: z
    .enum(["fail", "record-and-continue"])
    .default("fail")
    .describe("Behavior when declared application integrity does not match"),
});
