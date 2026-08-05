import { isAbsolute, resolve } from "node:path";

import { z } from "zod";

import {
  browserEndpointSchema,
  browserOriginSchema,
} from "./browserObservation.js";

const boundedTextSchema = z.string().min(1).max(4_096);

const runtimeFileRootsSchema = z
  .array(
    z
      .string()
      .min(1)
      .max(16_384)
      .refine(isAbsolute, "Runtime file roots must be absolute paths")
      .overwrite(resolve),
  )
  .max(32)
  .overwrite((roots) => [...new Set(roots)].sort())
  .default([]);

const runtimeOriginsSchema = z
  .array(browserOriginSchema)
  .max(32)
  .overwrite((origins) => [...new Set(origins)].sort())
  .default([]);

const approvedRuntimeScope = {
  inspector_endpoint: browserEndpointSchema,
  allowed_file_roots: runtimeFileRootsSchema,
  allowed_origins: runtimeOriginsSchema,
  approved: z.literal(true),
};

const requireRuntimeScope = (
  input: {
    readonly allowed_file_roots: readonly string[];
    readonly allowed_origins: readonly string[];
  },
  context: z.RefinementCtx,
): void => {
  if (
    input.allowed_file_roots.length === 0 &&
    input.allowed_origins.length === 0
  )
    context.addIssue({
      code: "custom",
      path: ["allowed_file_roots"],
      message: "At least one exact file root or HTTP(S) origin is required",
    });
};

/** Input for listing approved Node/Electron V8 Inspector targets. */
export const listJavaScriptRuntimeTargetsInputSchema = z
  .strictObject({
    ...approvedRuntimeScope,
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(200).default(100),
  })
  .superRefine(requireRuntimeScope);
export type ListJavaScriptRuntimeTargetsInput = z.infer<
  typeof listJavaScriptRuntimeTargetsInputSchema
>;

export const javascriptRuntimeKindSchema = z.enum([
  "node",
  "electron-main",
  "electron-preload",
  "electron-renderer",
]);

export const javascriptRuntimeObservationLimitsSchema = z.strictObject({
  max_events: z.number().int().min(1).max(50_000).default(10_000),
  max_scripts: z.number().int().min(1).max(10_000).default(2_000),
  max_execution_contexts: z.number().int().min(1).max(5_000).default(1_000),
  max_location_bytes: z.number().int().min(64).max(65_536).default(16_384),
  max_total_metadata_bytes: z
    .number()
    .int()
    .min(1_024)
    .max(32 * 1_024 * 1_024)
    .default(4 * 1_024 * 1_024),
});

/** Input for one bounded, attach-only V8 Inspector observation. */
export const observeJavaScriptRuntimeInputSchema = z
  .strictObject({
    ...approvedRuntimeScope,
    target_id: z.string().trim().min(1).max(256),
    runtime_kind: javascriptRuntimeKindSchema,
    observation_ms: z.number().int().min(0).max(10_000).default(100),
    limits: javascriptRuntimeObservationLimitsSchema.default({
      max_events: 10_000,
      max_scripts: 2_000,
      max_execution_contexts: 1_000,
      max_location_bytes: 16_384,
      max_total_metadata_bytes: 4 * 1_024 * 1_024,
    }),
  })
  .superRefine(requireRuntimeScope);
export type ObserveJavaScriptRuntimeInput = z.infer<
  typeof observeJavaScriptRuntimeInputSchema
>;

export const javascriptRuntimeVersionSchema = z.strictObject({
  product: z.string().min(1).max(1_024),
  protocol_version: z.string().min(1).max(100),
  v8_version: z.string().max(1_024).nullable(),
});

export const javascriptRuntimeLocationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("file"),
    file_path: z.string().min(1).max(16_384),
    authority: z.literal("scope-fallback").optional(),
  }),
  z.strictObject({
    kind: z.literal("url"),
    origin: z.string().min(1).max(2_048),
    sanitized_url: z.string().min(1).max(65_536),
  }),
  z.strictObject({
    kind: z.literal("builtin"),
    specifier: z.string().min(1).max(4_096),
  }),
]);
export type JavaScriptRuntimeLocation = z.infer<
  typeof javascriptRuntimeLocationSchema
>;

const javascriptRuntimeTargetSchema = z.strictObject({
  target_id: z.string().min(1).max(256),
  protocol_type: z.string().min(1).max(100),
  attached: z.boolean(),
  location: javascriptRuntimeLocationSchema,
});

/** Root/origin-filtered V8 Inspector target inventory. */
export const javascriptRuntimeTargetListSchema = z.strictObject({
  schema_version: z.literal(1),
  runtime: javascriptRuntimeVersionSchema,
  targets: z.strictObject({
    items: z.array(javascriptRuntimeTargetSchema),
    offset: z.number().int().min(0),
    limit: z.number().int().min(1),
    total: z.number().int().min(0),
    next_offset: z.number().int().min(0).nullable(),
    has_more: z.boolean(),
  }),
  excluded: z.strictObject({
    outside_file_roots: z.number().int().min(0),
    outside_origins: z.number().int().min(0),
    unsupported_location: z.number().int().min(0),
    unconnectable: z.number().int().min(0),
  }),
  limitations: z.array(boundedTextSchema).max(100),
});
export type JavaScriptRuntimeTargetList = z.infer<
  typeof javascriptRuntimeTargetListSchema
>;

const javascriptRuntimeScriptSchema = z.strictObject({
  script_key: z.string().regex(/^v8_script_[a-f0-9]{64}$/u),
  location: javascriptRuntimeLocationSchema,
  execution_context_key: z.string().max(64).nullable(),
  cdp_hash: z.string().max(512).nullable(),
  length: z.number().int().min(0),
  is_module: z.boolean(),
  status: z.literal("observed-loaded"),
});

const javascriptRuntimeContextSchema = z.strictObject({
  context_key: z.string().min(1).max(64),
  state: z.enum(["created", "destroyed", "cleared"]),
  name: z.string().max(1_024).nullable(),
  origin: z.string().max(4_096).nullable(),
});

/** Deterministic passive script/context snapshot from one bounded window. */
export const javascriptRuntimeObservationSchema = z.strictObject({
  schema_version: z.literal(1),
  runtime: javascriptRuntimeVersionSchema,
  target: javascriptRuntimeTargetSchema.extend({
    runtime_kind: javascriptRuntimeKindSchema,
    runtime_kind_authority: z.literal("caller-declared-unverified"),
  }),
  capture: z.strictObject({
    observation_ms: z.number().int().min(0),
    events_observed: z.number().int().min(0),
    events_retained: z.number().int().min(0),
    events_dropped: z.number().int().min(0),
    metadata_bytes_retained: z.number().int().min(0),
    truncated: z.boolean(),
    truncation_reasons: z.array(boundedTextSchema).max(20),
  }),
  scripts: z.strictObject({
    items: z.array(javascriptRuntimeScriptSchema),
    observed_total: z.number().int().min(0),
    excluded: z.strictObject({
      outside_file_roots: z.number().int().min(0),
      outside_origins: z.number().int().min(0),
      unsupported_location: z.number().int().min(0),
      invalid_protocol_value: z.number().int().min(0),
    }),
  }),
  execution_contexts: z.array(javascriptRuntimeContextSchema),
  directly_observed: z.array(boundedTextSchema).max(20),
  unavailable_without_instrumentation: z.array(boundedTextSchema).max(20),
  unknowns: z.array(boundedTextSchema).max(100),
  limitations: z.array(boundedTextSchema).max(100),
});
export type JavaScriptRuntimeObservation = z.infer<
  typeof javascriptRuntimeObservationSchema
>;
