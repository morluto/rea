import { isAbsolute, resolve } from "node:path";

import { z } from "zod";

import { evidenceSchema } from "./evidence.js";
import {
  compareCodePoints,
  javascriptApplicationGraphSchema,
} from "./javascriptApplicationGraph.js";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const evidenceIdSchema = z.string().regex(/^ev_[a-f0-9]{64}$/u);
const nodeIdSchema = z.string().regex(/^jag_node_[a-f0-9]{64}$/u);
const boundedTextSchema = z.string().min(1).max(4_096);
const safePrefixSchema = z
  .string()
  .max(4_096)
  .refine(
    (value) =>
      value === "" ||
      (!value.startsWith("/") &&
        !value.includes("\\") &&
        value.split("/").every((part) => !["", ".", ".."].includes(part))),
    "Artifact prefix must be empty or a safe relative POSIX path",
  );

const runtimeFileMappingSchema = z.strictObject({
  kind: z.literal("file-root"),
  root: z
    .string()
    .min(1)
    .max(16_384)
    .refine(isAbsolute, "Runtime file mapping root must be absolute")
    .overwrite((value) => resolve(value)),
  artifact_prefix: safePrefixSchema.default(""),
});

const runtimeUrlMappingSchema = z.strictObject({
  kind: z.literal("url-prefix"),
  prefix: z
    .string()
    .min(1)
    .max(16_384)
    .refine(
      (value) => normalizeRuntimeUrlPrefix(value) !== null,
      "Runtime URL prefix must be HTTP(S) without credentials, query, or fragment",
    )
    .overwrite((value) => normalizeRuntimeUrlPrefix(value) ?? value),
  artifact_prefix: safePrefixSchema.default(""),
});

const normalizeRuntimeUrlPrefix = (value: string): string | null => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  )
    return null;
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.href;
};

/** Caller-declared translation from an authorized runtime location to a layer. */
const runtimeLocationMappingSchema = z.discriminatedUnion("kind", [
  runtimeFileMappingSchema,
  runtimeUrlMappingSchema,
]);
type RuntimeLocationMapping = z.infer<typeof runtimeLocationMappingSchema>;

const staticLayerSchema = z.strictObject({
  role: z.enum(["application", "cache", "assets"]),
  analysis: evidenceSchema,
  runtime_mappings: z
    .array(runtimeLocationMappingSchema)
    .max(32)
    .overwrite(normalizeRuntimeMappings)
    .default([]),
});

function normalizeRuntimeMappings(
  mappings: RuntimeLocationMapping[],
): RuntimeLocationMapping[] {
  return [
    ...new Map(
      mappings.map((mapping) => [runtimeMappingKey(mapping), mapping]),
    ).values(),
  ].sort((left, right) =>
    compareCodePoints(runtimeMappingKey(left), runtimeMappingKey(right)),
  );
}

function runtimeMappingKey(mapping: RuntimeLocationMapping): string {
  return mapping.kind === "file-root"
    ? `file-root\0${mapping.root}\0${mapping.artifact_prefix}`
    : `url-prefix\0${mapping.prefix}\0${mapping.artifact_prefix}`;
}

const reconciliationLimitsSchema = z.strictObject({
  max_runtime_entities: z.number().int().min(1).max(50_000).default(10_000),
  max_reconciliation_items: z.number().int().min(1).max(50_000).default(20_000),
  max_static_load_states: z.number().int().min(1).max(50_000).default(20_000),
});

/** Evidence-backed static layers and passive captures to reconcile. */
export const reconcileJavaScriptRuntimeInputSchema = z
  .strictObject({
    static_layers: z.array(staticLayerSchema).min(1).max(8),
    runtime_observations: z.array(evidenceSchema).min(1).max(32),
    limits: reconciliationLimitsSchema.default({
      max_runtime_entities: 10_000,
      max_reconciliation_items: 20_000,
      max_static_load_states: 20_000,
    }),
  })
  .superRefine((input, context) => {
    if (
      input.static_layers.filter(({ role }) => role === "application")
        .length !== 1
    )
      context.addIssue({
        code: "custom",
        path: ["static_layers"],
        message: "Exactly one application static layer is required",
      });
    const staticIds = input.static_layers.map(
      ({ analysis }) => analysis.evidence_id,
    );
    if (new Set(staticIds).size !== staticIds.length)
      context.addIssue({
        code: "custom",
        path: ["static_layers"],
        message: "Static layer Evidence must be unique",
      });
    const runtimeIds = input.runtime_observations.map(
      ({ evidence_id: id }) => id,
    );
    if (new Set(runtimeIds).size !== runtimeIds.length)
      context.addIssue({
        code: "custom",
        path: ["runtime_observations"],
        message: "Runtime observation Evidence must be unique",
      });
    if (input.limits.max_runtime_entities < input.runtime_observations.length)
      context.addIssue({
        code: "custom",
        path: ["limits", "max_runtime_entities"],
        message: "Runtime entity limit must retain one target per observation",
      });
  });

const layerSummarySchema = z.strictObject({
  layer_id: z.string().regex(/^jrl_[a-f0-9]{64}$/u),
  role: z.enum(["application", "cache", "assets"]),
  evidence_id: evidenceIdSchema,
  graph_id: z.string().regex(/^jag_[a-f0-9]{64}$/u),
  root_artifact_sha256: digestSchema,
  input_path: z.string().min(1).max(16_384),
  format: z.enum(["asar", "directory"]),
  runtime_mappings: z.array(runtimeLocationMappingSchema).max(32),
});

const captureSummarySchema = z.strictObject({
  evidence_id: evidenceIdSchema,
  capture_sha256: digestSchema,
  kind: z.enum(["browser", "electron"]),
  target_node_id: nodeIdSchema,
  target_key: boundedTextSchema,
  target_location: boundedTextSchema,
  frames: z.number().int().min(0),
  scripts: z.number().int().min(0),
  workers: z.number().int().min(0),
  scripts_complete_within_scope: z.boolean(),
});

const reconciliationReasonSchema = z.enum([
  "content-and-location-match",
  "unique-content-match",
  "unique-location-match",
  "ambiguous-static-candidates",
  "captured-content-disagrees-with-static-location",
  "no-static-content-match",
  "no-authorized-location-mapping",
  "runtime-frame-unattributed",
  "static-or-runtime-coverage-incomplete",
  "reconciliation-limit-reached",
]);

const reconciliationItemSchema = z.strictObject({
  reconciliation_id: z.string().regex(/^jrr_item_[a-f0-9]{64}$/u),
  entity_kind: z.enum(["target", "frame", "script", "worker"]),
  runtime_evidence_id: evidenceIdSchema,
  runtime_node_id: nodeIdSchema,
  static_layer_id: z
    .string()
    .regex(/^jrl_[a-f0-9]{64}$/u)
    .nullable(),
  static_node_id: nodeIdSchema.nullable(),
  status: z.enum(["matched", "ambiguous", "unmatched", "unknown"]),
  basis: z.enum([
    "content-and-location",
    "content-sha256",
    "module-source-sha256",
    "artifact-path",
    "operator-file-mapping",
    "operator-url-mapping",
    "none",
  ]),
  confidence: z.enum(["exact", "high", "medium", "low", "unknown"]),
  reason: reconciliationReasonSchema,
  candidate_static_count: z.number().int().min(0).max(800_000),
  candidate_static_nodes: z
    .array(
      z.strictObject({
        static_layer_id: z.string().regex(/^jrl_[a-f0-9]{64}$/u),
        static_node_id: nodeIdSchema,
      }),
    )
    .max(1_000),
});

const staticLoadStateSchema = z.strictObject({
  static_layer_id: z.string().regex(/^jrl_[a-f0-9]{64}$/u),
  static_node_id: nodeIdSchema,
  kind: z.enum(["javascript-asset", "javascript-chunk", "javascript-module"]),
  status: z.enum([
    "loaded",
    "resident-in-loaded-asset",
    "not-observed-in-capture",
    "unknown",
  ]),
  runtime_node_ids: z.array(nodeIdSchema).max(10_000),
  reason: z.enum([
    "runtime-script-correspondence",
    "containing-asset-was-loaded",
    "not-observed-in-bounded-capture",
    "layer-outside-runtime-scope",
    "static-or-runtime-coverage-incomplete",
  ]),
});

/** Deterministic static/passive-runtime reconciliation with a combined JAG. */
export const javascriptRuntimeReconciliationResultSchema = z.strictObject({
  schema_version: z.literal(1),
  reconciliation_id: z.string().regex(/^jrr_[a-f0-9]{64}$/u),
  static_layers: z.array(layerSummarySchema).min(1).max(8),
  runtime_captures: z.array(captureSummarySchema).min(1).max(32),
  graph: javascriptApplicationGraphSchema,
  summary: z.strictObject({
    runtime_targets: z.number().int().min(0),
    runtime_frames: z.number().int().min(0),
    runtime_scripts: z.number().int().min(0),
    runtime_workers: z.number().int().min(0),
    matched: z.number().int().min(0),
    ambiguous: z.number().int().min(0),
    unmatched: z.number().int().min(0),
    unknown: z.number().int().min(0),
    static_loaded: z.number().int().min(0),
    static_resident: z.number().int().min(0),
    static_not_observed: z.number().int().min(0),
    static_unknown: z.number().int().min(0),
  }),
  reconciliations: z.array(reconciliationItemSchema).max(50_000),
  static_load_states: z.array(staticLoadStateSchema).max(50_000),
  source_map_authority: z.strictObject({
    used_for_primary_matching: z.literal(false),
    static_layers_with_read_approval: z.number().int().min(0),
    runtime_script_declarations: z.number().int().min(0),
    limitation: boundedTextSchema,
  }),
  coverage: z.strictObject({
    status: z.enum(["complete-within-inputs", "partial", "truncated"]),
    truncated: z.boolean(),
    omitted_runtime_entities: z.number().int().min(0),
    omitted_reconciliation_items: z.number().int().min(0),
    omitted_static_load_states: z.number().int().min(0),
    omitted_graph_items: z.number().int().min(0),
  }),
  evidence_links: z.array(evidenceIdSchema).min(2).max(40),
  limitations: z.array(boundedTextSchema).max(1_000),
});

export type ReconcileJavaScriptRuntimeInput = z.infer<
  typeof reconcileJavaScriptRuntimeInputSchema
>;
export type JavaScriptRuntimeReconciliationResult = z.infer<
  typeof javascriptRuntimeReconciliationResultSchema
>;
export type JavaScriptRuntimeReconciliationItem = z.infer<
  typeof reconciliationItemSchema
>;
export type JavaScriptStaticLoadState = z.infer<typeof staticLoadStateSchema>;
