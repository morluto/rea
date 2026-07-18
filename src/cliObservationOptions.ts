import { z } from "incur";

const boundedCount = (
  subject: string,
  maximum: number,
  fallback: number,
  minimum = 1,
) =>
  z
    .number()
    .int()
    .min(minimum)
    .max(maximum)
    .default(fallback)
    .describe(`Maximum ${subject}`);

const boundedBytes = (subject: string, maximum: number, fallback: number) =>
  boundedCount(`${subject} in bytes`, maximum, fallback);

const positiveCount = (subject: string, fallback: number) =>
  z.number().int().min(1).default(fallback).describe(`Maximum ${subject}`);

const browserScopeOptions = {
  allowedOrigins: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "Exact origins to observe; defaults to REA_BROWSER_ALLOWED_ORIGINS_JSON",
    ),
  approved: z.boolean().default(false).describe("Approve passive observation"),
};

export const browserPageInspectionOptions = z.object({
  ...browserScopeOptions,
  observationMs: boundedCount(
    "observation duration in milliseconds",
    10_000,
    500,
    0,
  ),
  includeAccessibilityText: z
    .boolean()
    .default(false)
    .describe("Include bounded accessibility text"),
  includeConsoleText: z
    .boolean()
    .default(false)
    .describe("Include bounded console message text"),
  consoleTextApproved: z
    .boolean()
    .default(false)
    .describe("Approve capturing console message text"),
  includeJsonBodyShapes: z
    .boolean()
    .default(false)
    .describe("Include structural shapes of JSON response bodies"),
  jsonBodySchemaApproved: z
    .boolean()
    .default(false)
    .describe("Approve inspecting JSON response bodies for structural shapes"),
  includeWebsocketShapes: z
    .boolean()
    .default(false)
    .describe("Include structural shapes of WebSocket payloads"),
  websocketShapeApproved: z
    .boolean()
    .default(false)
    .describe("Approve inspecting WebSocket payloads for structural shapes"),
  includeScriptSources: z
    .boolean()
    .default(false)
    .describe("Include bounded JavaScript source text"),
  includeStorageKeys: z
    .boolean()
    .default(false)
    .describe("Include storage key names without values"),
  maxFrames: boundedCount("page frames", 1_000, 200),
  maxDomNodes: boundedCount("DOM nodes", 10_000, 2_000),
  maxAxNodes: boundedCount("accessibility nodes", 10_000, 2_000),
  maxAxTextFieldBytes: boundedBytes(
    "one accessibility text field",
    16 * 1_024,
    1_024,
  ),
  maxTotalAxTextBytes: boundedBytes(
    "total accessibility text",
    1_024 * 1_024,
    64 * 1_024,
  ),
  maxScripts: boundedCount("scripts", 1_000, 200),
  maxResources: boundedCount("resources", 10_000, 2_000),
  maxWorkers: boundedCount("workers", 5_000, 500),
  maxStorageKeys: boundedCount("storage keys", 10_000, 1_000),
  maxScriptSourceBytes: boundedBytes(
    "one script source",
    4 * 1_024 * 1_024,
    1_024 * 1_024,
  ),
  maxTotalScriptSourceBytes: boundedBytes(
    "total script source",
    16 * 1_024 * 1_024,
    4 * 1_024 * 1_024,
  ),
  maxNetworkEvents: boundedCount("network events", 10_000, 1_000),
  maxConsoleEvents: boundedCount("console events", 2_000, 200),
  maxConsoleTextFieldBytes: boundedBytes(
    "one console text field",
    16 * 1_024,
    1_024,
  ),
  maxTotalConsoleTextBytes: boundedBytes(
    "total console text",
    1_024 * 1_024,
    64 * 1_024,
  ),
  maxJsonBodyBytes: boundedBytes(
    "one JSON response body",
    4 * 1_024 * 1_024,
    1_024 * 1_024,
  ),
  maxTotalJsonBodyBytes: boundedBytes(
    "total JSON response bodies",
    16 * 1_024 * 1_024,
    4 * 1_024 * 1_024,
  ),
  maxJsonShapeNodes: boundedCount("JSON shape nodes", 100_000, 5_000),
  maxJsonShapeDepth: boundedCount("JSON shape depth", 100, 20),
  maxWebsocketEvents: boundedCount("WebSocket events", 5_000, 500),
  maxWebsocketShapeBytes: boundedBytes(
    "one WebSocket shape",
    1_024 * 1_024,
    64 * 1_024,
  ),
  maxTotalWebsocketShapeBytes: boundedBytes(
    "total WebSocket shapes",
    16 * 1_024 * 1_024,
    1_024 * 1_024,
  ),
});

const electronScopeOptions = {
  allowedFileRoots: z
    .array(z.string().min(1))
    .optional()
    .describe("Filesystem roots; defaults to REA_ELECTRON_FILE_ROOTS_JSON"),
  approved: z.boolean().default(false).describe("Approve passive observation"),
};

export const electronPageInspectionOptions = z.object({
  ...electronScopeOptions,
  observationMs: boundedCount(
    "observation duration in milliseconds",
    10_000,
    100,
    0,
  ),
  includeScriptSources: z
    .boolean()
    .default(false)
    .describe("Include bounded JavaScript source text"),
  sourceCaptureApproved: z
    .boolean()
    .default(false)
    .describe("Approve capturing bounded script source text"),
  maxFrames: boundedCount("page frames", 1_000, 200),
  maxDomNodes: boundedCount("DOM nodes", 10_000, 2_000),
  maxScripts: boundedCount("scripts", 2_000, 500),
  maxResources: boundedCount("resources", 10_000, 2_000),
  maxWorkers: boundedCount("workers", 5_000, 500),
  maxScriptSourceBytes: boundedBytes(
    "one captured script source",
    4 * 1_024 * 1_024,
    1_024 * 1_024,
  ),
  maxTotalScriptSourceBytes: boundedBytes(
    "total captured script source",
    16 * 1_024 * 1_024,
    4 * 1_024 * 1_024,
  ),
});

export const javascriptApplicationOptions = z.object({
  approved: z
    .boolean()
    .default(false)
    .describe("Approve reading the application artifact"),
  format: z
    .enum(["auto", "asar", "directory"])
    .default("auto")
    .describe("Application artifact format"),
  sourceMapReadApproved: z
    .boolean()
    .default(false)
    .describe(
      "Approve reading local source maps referenced by the application",
    ),
  maxEntries: positiveCount("artifact entries to inspect", 8_000),
  maxTotalArtifactBytes: positiveCount(
    "total uncompressed artifact content to inspect",
    512 * 1_024 * 1_024,
  ),
  maxArtifactEntryBytes: positiveCount(
    "uncompressed content for one artifact entry",
    128 * 1_024 * 1_024,
  ),
  maxCompressionRatio: z
    .number()
    .min(1)
    .default(1_000)
    .describe("Maximum accepted compressed-to-uncompressed expansion ratio"),
  maxDepth: positiveCount("artifact directory depth", 64),
  maxPathBytes: positiveCount("encoded artifact path length", 4_096),
  maxTextFiles: positiveCount("text files to parse", 5_000),
  maxTotalTextBytes: positiveCount(
    "total text content to parse",
    128 * 1_024 * 1_024,
  ),
  maxTextFileBytes: positiveCount(
    "size of one parsed text file",
    8 * 1_024 * 1_024,
  ),
  maxAstNodes: positiveCount("JavaScript AST nodes to parse", 2_000_000),
  maxFindings: positiveCount("static-analysis findings to return", 8_000),
  maxModules: positiveCount("application modules to project", 20_000),
  maxSourceMapSources: positiveCount(
    "original sources from source maps",
    5_000,
  ),
  maxParseMilliseconds: positiveCount(
    "JavaScript parsing time in milliseconds",
    30_000,
  ),
});
