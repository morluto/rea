import { z } from "zod";

import {
  applicationCoverageSchema,
  applicationGraphEvidenceSchema,
  applicationNodeIdentitySchema,
} from "./javascriptApplicationEvidenceSchemas.js";
import { jsonValueSchema } from "./jsonValue.js";
import { prefixedDigestSchema } from "./../domain/digests.js";

const boundedTextSchema = z.string().min(1);

/** Node kinds admitted by JavaScript Application Graph. */
export const JAVASCRIPT_APPLICATION_NODE_KINDS = [
  "package",
  "installer",
  "artifact",
  "asar-entry",
  "electron-main",
  "electron-preload",
  "electron-renderer",
  "electron-utility",
  "javascript-asset",
  "javascript-chunk",
  "javascript-module",
  "source-map",
  "source-module",
  "browser-window",
  "frame",
  "target",
  "context-bridge-api",
  "ipc-channel",
  "ipc-handler",
  "worker",
  "service-worker",
  "endpoint",
  "storage",
  "native-addon",
  "native-export",
  "managed-assembly",
  "managed-module",
  "managed-type",
  "managed-method",
  "managed-field",
  "managed-pinvoke-import",
  "managed-native-implementation",
  "runtime-script-instance",
  "unknown",
] as const;

/** Provider-neutral application entity categories. */
const applicationNodeKindSchema = z.enum(JAVASCRIPT_APPLICATION_NODE_KINDS);

/** Directed relations admitted by JavaScript Application Graph. */
export const JAVASCRIPT_APPLICATION_RELATIONS = [
  "contains",
  "loads",
  "imports",
  "maps_to",
  "exposes",
  "sends",
  "invokes",
  "handles",
  "calls",
  "persists_to",
  "observed_as",
  "changed_from",
] as const;

/** Provider-neutral relation categories. */
const applicationRelationSchema = z.enum(JAVASCRIPT_APPLICATION_RELATIONS);

const applicationPropertiesSchema = z.record(
  z.string().min(1),
  jsonValueSchema,
);

/** One node observation before its semantic identifier is derived. */
const applicationNodeObservationInputSchema = z.strictObject({
  label: z.string().min(1).nullable(),
  properties: applicationPropertiesSchema,
  evidence: applicationGraphEvidenceSchema,
});

/** One immutable, evidence-bearing observation attached to an entity. */
export const applicationNodeObservationSchema =
  applicationNodeObservationInputSchema.extend({
    observation_id: prefixedDigestSchema("jag_observation"),
    identifier_strategy: z.strictObject({
      strategy: z.literal("semantic-content-sha256"),
      stability: z.literal("observation-exact"),
    }),
  });

/** One application entity before its stable identifier is derived. */
export const applicationNodeInputSchema = z.strictObject({
  kind: applicationNodeKindSchema,
  identity: applicationNodeIdentitySchema,
  observations: z.array(applicationNodeObservationInputSchema).min(1),
});

/** One stable application entity with one or more bounded observations. */
export const applicationNodeSchema = z.strictObject({
  node_id: prefixedDigestSchema("jag_node"),
  kind: applicationNodeKindSchema,
  identity: applicationNodeIdentitySchema,
  observations: z.array(applicationNodeObservationSchema).min(1),
});

/** One directed relationship before its semantic identifier is derived. */
export const applicationEdgeInputSchema = z.strictObject({
  source_node_id: prefixedDigestSchema("jag_node"),
  target_node_id: prefixedDigestSchema("jag_node"),
  relation: applicationRelationSchema,
  properties: applicationPropertiesSchema,
  evidence: applicationGraphEvidenceSchema,
});

/** One directed, evidence-bearing application relationship. */
export const applicationEdgeSchema = applicationEdgeInputSchema.extend({
  edge_id: prefixedDigestSchema("jag_edge"),
  identifier_strategy: z.strictObject({
    strategy: z.literal("semantic-content-sha256"),
    stability: z.literal("relationship-exact"),
  }),
});

/** Graph content before its top-level semantic identifier is derived. */
export const javascriptApplicationGraphInputSchema = z.strictObject({
  schema: z.literal("JavaScriptApplicationGraph"),
  root_node_ids: z.array(prefixedDigestSchema("jag_node")).min(1),
  nodes: z.array(applicationNodeSchema).min(1),
  edges: z.array(applicationEdgeSchema),
  coverage: applicationCoverageSchema,
  limitations: z.array(boundedTextSchema),
});

/** Strict stored shape for a JavaScript Application Graph. */
export const javascriptApplicationGraphRecordSchema =
  javascriptApplicationGraphInputSchema.extend({
    graph_id: prefixedDigestSchema("jag"),
  });

/** Immutable entity in a JavaScript Application Graph. */
export type ApplicationNode = z.infer<typeof applicationNodeSchema>;
/** Immutable relationship in a JavaScript Application Graph. */
export type ApplicationEdge = z.infer<typeof applicationEdgeSchema>;
/** Complete graph content before its graph identifier is derived. */
export type JavaScriptApplicationGraphInput = z.infer<
  typeof javascriptApplicationGraphInputSchema
>;
