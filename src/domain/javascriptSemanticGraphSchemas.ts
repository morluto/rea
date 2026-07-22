import { z } from "zod";

import { applicationGraphEvidenceSchema } from "./javascriptApplicationEvidenceSchemas.js";
import { isJsonWithinLimits } from "./jsonLimits.js";
import { jsonValueSchema } from "./jsonValue.js";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const boundedTextSchema = z.string().min(1).max(4_096);
const semanticNodeIdSchema = z.string().regex(/^jsrg_node_[a-f0-9]{64}$/u);
const semanticRelationIdSchema = z
  .string()
  .regex(/^jsrg_relation_[a-f0-9]{64}$/u);
const semanticUnknownIdSchema = z
  .string()
  .regex(/^jsrg_unknown_[a-f0-9]{64}$/u);

/** Semantic entity kinds admitted by JavaScript Semantic Relation Graph v1. */
export const JAVASCRIPT_SEMANTIC_NODE_KINDS = [
  "module",
  "function",
  "parameter",
  "binding",
  "expression",
  "literal",
  "property-slot",
  "call-site",
  "return-site",
  "closure-capture",
  "promise",
  "task",
  "event",
  "listener",
  "timer",
  "child-process",
  "stdio",
  "signal",
  "config-source",
  "request",
  "response",
  "boundary",
  "resource",
  "unknown-frontier",
] as const;

/** Required semantic-analysis coverage families. */
export const JAVASCRIPT_SEMANTIC_RELATION_FAMILIES = [
  "boundary",
  "call-flow",
  "child-process",
  "closure",
  "configuration",
  "data-flow",
  "event",
  "object-flow",
  "promise-ownership",
  "request",
  "resource-lifecycle",
  "timer",
] as const;

/** Directed semantic relations admitted by graph v1. */
export const JAVASCRIPT_SEMANTIC_RELATIONS = [
  "acquires",
  "aggregates",
  "aliases",
  "argument-to-parameter",
  "awaits",
  "calls",
  "cancels-timer",
  "captures",
  "chains",
  "coerces",
  "connects-stdio",
  "consumed-by",
  "constructs-request",
  "creates-promise",
  "defaults",
  "defines",
  "destructures",
  "detaches-task",
  "dispatches-candidate",
  "forwards-signal",
  "listens-error",
  "listens-exit",
  "owns",
  "overrides",
  "parses",
  "reads",
  "reads-argv",
  "reads-config",
  "reads-environment",
  "reads-property",
  "registers-listener",
  "releases",
  "removes-listener",
  "returns-task",
  "returns-to-call",
  "schedules-timer",
  "spawns",
  "spreads",
  "supplies-argv",
  "supplies-env",
  "supplies-request-field",
  "validates",
  "writes",
  "writes-property",
] as const;

/** Map each semantic relation to its coverage family. */
export const JAVASCRIPT_SEMANTIC_RELATION_FAMILY = {
  acquires: "resource-lifecycle",
  aggregates: "promise-ownership",
  aliases: "data-flow",
  "argument-to-parameter": "call-flow",
  awaits: "promise-ownership",
  calls: "call-flow",
  "cancels-timer": "timer",
  captures: "closure",
  chains: "promise-ownership",
  coerces: "boundary",
  "connects-stdio": "child-process",
  "consumed-by": "request",
  "constructs-request": "request",
  "creates-promise": "promise-ownership",
  defaults: "configuration",
  defines: "data-flow",
  destructures: "object-flow",
  "detaches-task": "promise-ownership",
  "dispatches-candidate": "event",
  "forwards-signal": "child-process",
  "listens-error": "child-process",
  "listens-exit": "child-process",
  owns: "promise-ownership",
  overrides: "configuration",
  parses: "boundary",
  reads: "data-flow",
  "reads-argv": "configuration",
  "reads-config": "configuration",
  "reads-environment": "configuration",
  "reads-property": "object-flow",
  "registers-listener": "event",
  releases: "resource-lifecycle",
  "removes-listener": "event",
  "returns-task": "promise-ownership",
  "returns-to-call": "call-flow",
  "schedules-timer": "timer",
  spawns: "child-process",
  spreads: "object-flow",
  "supplies-argv": "child-process",
  "supplies-env": "child-process",
  "supplies-request-field": "request",
  validates: "boundary",
  writes: "data-flow",
  "writes-property": "object-flow",
} as const satisfies Readonly<
  Record<
    (typeof JAVASCRIPT_SEMANTIC_RELATIONS)[number],
    (typeof JAVASCRIPT_SEMANTIC_RELATION_FAMILIES)[number]
  >
>;

const relativePathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !path.includes("\\") &&
      path.split("/").every((part) => !["", ".", ".."].includes(part)),
    "Expected a normalized relative POSIX path without traversal",
  );

const sourcePointSchema = z.strictObject({
  line: z.number().int().min(1),
  column: z.number().int().min(0),
});

const sourceRangeSchema = z
  .strictObject({ start: sourcePointSchema, end: sourcePointSchema })
  .superRefine((range, context) => {
    if (
      range.end.line < range.start.line ||
      (range.end.line === range.start.line &&
        range.end.column < range.start.column)
    )
      context.addIssue({
        code: "custom",
        path: ["end"],
        message: "Source range end must not precede its start",
      });
  });

const semanticPropertiesSchema = z
  .record(z.string().min(1).max(128), jsonValueSchema)
  .superRefine((properties, context) => {
    if (Object.keys(properties).length > 64)
      context.addIssue({
        code: "custom",
        message: "Semantic properties exceed 64 keys",
      });
    if (
      !isJsonWithinLimits(properties, {
        maxDepth: 6,
        maxNodes: 512,
        maxStringLength: 4_096,
      })
    )
      context.addIssue({
        code: "custom",
        message: "Semantic properties exceed structural limits",
      });
  });

const semanticNodeIdentitySchema = z.strictObject({
  artifact_sha256: digestSchema,
  module_path: relativePathSchema,
  source_range: sourceRangeSchema.nullable(),
  role_key: z.string().min(1).max(1_024),
});

/** One semantic entity before its canonical identifier is derived. */
export const javaScriptSemanticNodeInputSchema = z.strictObject({
  kind: z.enum(JAVASCRIPT_SEMANTIC_NODE_KINDS),
  identity: semanticNodeIdentitySchema,
  function_node_id: semanticNodeIdSchema.nullable(),
  application_node_ids: z
    .array(z.string().regex(/^jag_node_[a-f0-9]{64}$/u))
    .max(64),
  label: z.string().min(1).max(1_024).nullable(),
  properties: semanticPropertiesSchema,
  evidence: applicationGraphEvidenceSchema,
});

/** One exact, artifact-version semantic entity. */
export const javaScriptSemanticNodeSchema =
  javaScriptSemanticNodeInputSchema.extend({
    node_id: semanticNodeIdSchema,
    identifier_strategy: z.strictObject({
      strategy: z.literal("semantic-content-sha256"),
      stability: z.literal("artifact-version"),
    }),
  });

/** One directed semantic relationship before its ID is derived. */
export const javaScriptSemanticRelationInputSchema = z.strictObject({
  source_node_id: semanticNodeIdSchema,
  target_node_id: semanticNodeIdSchema,
  relation: z.enum(JAVASCRIPT_SEMANTIC_RELATIONS),
  resolution: z.enum(["resolved", "candidate"]),
  properties: semanticPropertiesSchema,
  evidence: applicationGraphEvidenceSchema,
});

/** One canonical directed semantic relationship. */
export const javaScriptSemanticRelationSchema =
  javaScriptSemanticRelationInputSchema.extend({
    relation_id: semanticRelationIdSchema,
    identifier_strategy: z.strictObject({
      strategy: z.literal("semantic-content-sha256"),
      stability: z.literal("relationship-exact"),
    }),
  });

/** Reasons semantic analysis can leave an explicit frontier. */
export const JAVASCRIPT_SEMANTIC_UNKNOWN_REASONS = [
  "ambiguous-target",
  "bound-reached",
  "dynamic-call",
  "dynamic-property",
  "eval-or-generated-code",
  "incomplete-module",
  "missing-source",
  "unsupported-syntax",
] as const;

/** One unresolved semantic frontier before its ID is derived. */
export const javaScriptSemanticUnknownInputSchema = z.strictObject({
  node_id: semanticNodeIdSchema.nullable(),
  family: z.enum(JAVASCRIPT_SEMANTIC_RELATION_FAMILIES),
  relation_kinds: z.array(z.enum(JAVASCRIPT_SEMANTIC_RELATIONS)).min(1).max(45),
  reason: z.enum(JAVASCRIPT_SEMANTIC_UNKNOWN_REASONS),
  detail: boundedTextSchema,
  candidate_node_ids: z.array(semanticNodeIdSchema).max(1_000),
  evidence: applicationGraphEvidenceSchema,
});

/** One canonical unresolved semantic frontier. */
export const javaScriptSemanticUnknownSchema =
  javaScriptSemanticUnknownInputSchema.extend({
    unknown_id: semanticUnknownIdSchema,
  });

const fingerprintComponentsSchema = z.strictObject({
  parameter_arity: z.number().int().min(0).max(10_000),
  normalized_ast_sha256: digestSchema,
  control_flow_sha256: digestSchema,
  relation_shape_sha256: digestSchema,
  literal_set_sha256: digestSchema,
  effects: z
    .array(
      z.enum([
        "async",
        "child-process",
        "event",
        "network",
        "promise",
        "resource",
        "timer",
      ]),
    )
    .max(7),
});

/** One bounded rename-resistant function fingerprint. */
export const javaScriptSemanticFingerprintInputSchema = z.strictObject({
  function_node_id: semanticNodeIdSchema,
  algorithm: z.literal("rea.javascript-semantic-function/v1"),
  status: z.enum(["complete", "partial", "unavailable"]),
  components: fingerprintComponentsSchema,
  limitations: z.array(boundedTextSchema).max(100),
  evidence: applicationGraphEvidenceSchema,
});

/** One canonical function fingerprint record. */
export const javaScriptSemanticFingerprintSchema =
  javaScriptSemanticFingerprintInputSchema.extend({
    fingerprint_id: z.string().regex(/^jsrg_fingerprint_[a-f0-9]{64}$/u),
    fingerprint_sha256: digestSchema,
  });

const familyCoverageSchema = z.strictObject({
  family: z.enum(JAVASCRIPT_SEMANTIC_RELATION_FAMILIES),
  status: z.enum(["complete", "partial", "unknown", "unsupported"]),
  retained_relations: z.number().int().min(0),
  omitted_relations: z.number().int().min(0).nullable(),
  unknown_ids: z.array(semanticUnknownIdSchema).max(100_000),
});

const graphCoverageSchema = z.strictObject({
  status: z.enum(["complete", "partial", "unknown", "unavailable"]),
  truncated: z.boolean(),
  omitted_nodes: z.number().int().min(0).nullable(),
  omitted_relations: z.number().int().min(0).nullable(),
  limits: z
    .array(
      z.strictObject({
        name: z.string().min(1).max(128),
        value: z.number().int().min(0),
        unit: z.enum(["items", "bytes", "milliseconds", "depth", "other"]),
      }),
    )
    .max(32),
  families: z.array(familyCoverageSchema).length(12),
});

/** Graph content before its top-level commitment is derived. */
export const javaScriptSemanticGraphInputSchema = z.strictObject({
  schema: z.literal("JavaScriptSemanticRelationGraph"),
  schema_version: z.literal(1),
  root_artifact_sha256: digestSchema,
  application_graph_id: z.string().regex(/^jag_[a-f0-9]{64}$/u),
  root_node_ids: z.array(semanticNodeIdSchema).min(1).max(10_000),
  nodes: z.array(javaScriptSemanticNodeSchema).min(1).max(100_000),
  relations: z.array(javaScriptSemanticRelationSchema).max(200_000),
  fingerprints: z.array(javaScriptSemanticFingerprintSchema).max(20_000),
  unknowns: z.array(javaScriptSemanticUnknownSchema).max(100_000),
  coverage: graphCoverageSchema,
  limitations: z.array(boundedTextSchema).max(1_000),
});

/** Stored JavaScript Semantic Relation Graph v1. */
export const javaScriptSemanticGraphRecordSchema =
  javaScriptSemanticGraphInputSchema.extend({
    graph_id: z.string().regex(/^jsrg_[a-f0-9]{64}$/u),
  });

/** Canonical semantic node. */
export type JavaScriptSemanticGraphNode = z.infer<
  typeof javaScriptSemanticNodeSchema
>;
/** Canonical semantic relation. */
export type JavaScriptSemanticGraphRelation = z.infer<
  typeof javaScriptSemanticRelationSchema
>;
/** Canonical unresolved semantic frontier. */
export type JavaScriptSemanticGraphUnknown = z.infer<
  typeof javaScriptSemanticUnknownSchema
>;
/** Canonical graph content before graph ID derivation. */
export type JavaScriptSemanticGraphInput = z.infer<
  typeof javaScriptSemanticGraphInputSchema
>;
