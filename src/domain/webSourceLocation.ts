import { z } from "zod";
import { digestSchema } from "./digests.js";
import { exportedWebScriptSchema } from "./webScriptExport.js";
import {
  capturedWebManifestIdentitySchema,
  selectedWebScriptInputSchema,
  webArtifactFileSchema,
} from "./webScriptArtifacts.js";

/** JavaScript source-map positions use UTF-16 columns and one-based lines. */
export const webSourcePositionSchema = z.strictObject({
  line: z.number().int().min(1),
  column: z.number().int().min(0),
});

/** Trace one explicit generated position through an explicitly paired local map. */
export const webSourceLocationInputSchema = selectedWebScriptInputSchema.extend(
  {
    source_map: z.strictObject({
      path: z
        .string()
        .min(1)
        .describe("Absolute local source-map path; no fetch"),
      url: z
        .string()
        .min(1)
        .describe(
          "Explicit source-map URL context used to resolve original source names",
        ),
    }),
    generated_position: webSourcePositionSchema,
  },
);
export type WebSourceLocationInput = z.output<
  typeof webSourceLocationInputSchema
>;

const originalContentSchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("embedded"),
    text: z.string(),
    utf8_sha256: digestSchema,
    utf8_bytes: z.number().int().min(0),
    representation: z.literal("UTF-8 encoding of decoded sourcesContent text"),
  }),
  z.strictObject({
    state: z.literal("unavailable"),
    reason: z.literal("sourcesContent-not-retained"),
  }),
]);

/** Keep every matching segment, including anonymous mappings and duplicate URLs. */
export const webSourceMapMatchSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("generated-only") }),
  z.strictObject({
    state: z.literal("mapped"),
    flattened_source_index: z.number().int().min(0),
    section_path: z.array(z.number().int().min(0)),
    source_index: z.number().int().min(0),
    reported_source: z.string().nullable(),
    reported_source_root: z.string().nullable(),
    resolved_url: z.string().nullable(),
    ignored: z.boolean(),
    content: originalContentSchema,
    original_position: webSourcePositionSchema.extend({
      offset: z.number().int().min(0).nullable(),
      content_position: z.enum([
        "verified-in-embedded-text",
        "outside-embedded-text",
        "content-unavailable",
      ]),
    }),
    name: z.string().nullable(),
  }),
]);

/** Codec observations; map association and deployment authenticity remain selected context. */
export const webSourceMapReportSchema = z.strictObject({
  source_map_sha256: digestSchema,
  url_context: z.string().min(1),
  engine: z.strictObject({ id: z.string().min(1), version: z.string().min(1) }),
  runtime: z.strictObject({
    id: z.string().min(1),
    version: z.string().min(1),
    v8_heap_limit_bytes: z.number().int().min(1),
  }),
  format: z.enum(["regular", "indexed"]),
  reported_file: z.string().nullable(),
  lookup: z.strictObject({
    requested: webSourcePositionSchema,
    matched_generated_position: webSourcePositionSchema.nullable(),
    semantics: z.literal(
      "greatest generated position <= requested, across lines; all equal-position segments",
    ),
    location_units: z.literal("one-based lines; zero-based UTF-16 columns"),
  }),
  matches: z.array(webSourceMapMatchSchema),
  diagnostics: z.array(z.string()),
});

/** Bounds for complete source-map evidence and upstream decoded layouts. */
export const WEB_SOURCE_MAP_LIMITS = {
  mapBytes: 4 * 1024 * 1024,
  outputBytes: 32 * 1024 * 1024,
  decodedRows: 262144,
  decodedSegments: 262144,
  decodedRecords: 262144,
  sectionDepth: 64,
  decodeTimeoutMs: 20000,
} as const;
export type WebSourceMapReport = z.output<typeof webSourceMapReportSchema>;

/** Selected capture/map byte identities and complete point attribution inline. */
export const webSourceLocationResultSchema = webSourceMapReportSchema.extend({
  manifest: capturedWebManifestIdentitySchema,
  source: webArtifactFileSchema.extend({
    script_index: z.number().int().min(0),
    script: exportedWebScriptSchema,
  }),
  source_map: webArtifactFileSchema.extend({
    url: z.string().min(1),
    association: z.literal("caller-selected"),
  }),
  generated_offset: z.number().int().min(0),
  source_authenticity: z.literal("unknown"),
  execution: z.literal("unknown"),
  limitations: z.array(z.string()),
});
