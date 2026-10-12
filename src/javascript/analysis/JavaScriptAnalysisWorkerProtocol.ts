import { z } from "zod";
import { jsonValueSchema } from "../../domain/jsonValue.js";
import { digestSchema } from "../../domain/digests.js";
import {
  JAVASCRIPT_ANALYSIS_RESOURCE_DEFAULTS,
  JAVASCRIPT_SEMANTIC_NODE_MAXIMUM,
} from "../../domain/javascript/javascriptAnalysisResourceControls.js";
import { javaScriptAnalysisTransferDescriptorSchema } from "./JavaScriptAnalysisTransfer.js";

/** Independent worker execution budget; source length is not an admission rule. */
export const JAVASCRIPT_ANALYSIS_WORKER_DEFAULTS = {
  ...JAVASCRIPT_ANALYSIS_RESOURCE_DEFAULTS,
  checkpointBytes: 8 * 1024 * 1024,
  protocolBytes: 64 * 1024,
} as const;

/** Caller-selected artifact identity, separate from the decoded source-text digest. */
export const javaScriptWorkerRequestSchema = z.strictObject({
  id: z.uuid(),
  node_budget: z.number().int().min(0).max(JAVASCRIPT_SEMANTIC_NODE_MAXIMUM),
  text_sha256: digestSchema,
  file: z.strictObject({
    path: z.string(),
    sha256: digestSchema,
    container_sha256: digestSchema,
    bytes: z.number().int().nonnegative(),
    inventory_artifact_id: z.string(),
    kind: z.literal("javascript"),
    unpacked: z.boolean(),
  }),
});

/** Parent admission after validated static observations have been retained. */
export const javaScriptWorkerAdmissionSchema = z.strictObject({
  id: z.uuid(),
  semantic_result_budget_bytes: z.number().int().nonnegative(),
});

const identity = { id: z.uuid() };

/** Control frames never contain AST, full IR, graph rows or source text. */
export const javaScriptWorkerMessageSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("ready"),
    // Null when the worker runtime (Bun) does not enforce V8 heap flags.
    heap_limit_bytes: z.number().int().positive().nullable(),
  }),
  z.strictObject({
    kind: z.literal("phase"),
    ...identity,
    phase: z.enum(["parse", "static", "semantic", "projection", "transfer"]),
  }),
  z.strictObject({
    kind: z.literal("static"),
    ...identity,
    bytes: z.number().int().nonnegative(),
    sha256: digestSchema,
  }),
  z.strictObject({
    kind: z.literal("complete"),
    ...identity,
    descriptor: javaScriptAnalysisTransferDescriptorSchema.nullable(),
  }),
  z.strictObject({
    kind: z.literal("failure"),
    ...identity,
    reason: z.enum(["resource", "output", "io"]),
    resource: z.enum(["memory", "cpu", "file-size", "transport"]).nullable(),
    limits: z.record(z.string(), jsonValueSchema).nullable(),
    message: z.string(),
  }),
]);

/** One decoded control frame from the independently owned worker. */
export type JavaScriptWorkerMessage = z.output<
  typeof javaScriptWorkerMessageSchema
>;
