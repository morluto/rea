import { createHash } from "node:crypto";

import canonicalize from "canonicalize";
import { z } from "zod";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const stableIdSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9._:/-]{0,199}$/u);

const runtimeIdentitySchema = z.strictObject({
  family: z.string().trim().min(1).max(100),
  provider_id: stableIdSchema,
  executable_path: z.string().min(1).max(4_096),
  executable_sha256: digestSchema,
  version: z.string().trim().min(1).max(500),
  profile_sha256: digestSchema,
});

const artifactIdentitySchema = z.strictObject({
  path: z.string().min(1).max(4_096),
  sha256: digestSchema,
  byte_length: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});

const callableIdentitySchema = z.strictObject({
  callable_id: stableIdSchema,
  module_id: stableIdSchema,
  export_name: z.string().min(1).max(1_000),
  semantic_evidence_id: z
    .string()
    .regex(/^ev_[a-f0-9]{64}$/u)
    .nullable(),
  selector_sha256: digestSchema,
});

export const runtimeCharacterizationPlanSchema = z.strictObject({
  schema_version: z.literal(1),
  plan_sha256: digestSchema,
  preparation_sha256: digestSchema,
  artifact: artifactIdentitySchema,
  runtime: runtimeIdentitySchema,
  callable: callableIdentitySchema,
  working_directory: z.string().min(1).max(4_096),
  isolated_home: z.string().min(1).max(4_096),
  expected_effect: z.enum(["pure", "bounded-effects", "observation-only"]),
  allowed_boundaries: z.array(stableIdSchema).max(1_000),
  limits: z.strictObject({
    max_calls: z.number().int().min(1).max(10_000),
    max_processes: z.number().int().min(0).max(1_000),
    max_files: z.number().int().min(0).max(100_000),
    max_bytes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    max_handles: z.number().int().min(0).max(100_000),
    timeout_ms: z.number().int().min(1).max(300_000),
    idle_timeout_ms: z.number().int().min(1).max(300_000),
  }),
  determinism: z.strictObject({
    clock: z.enum(["fixed", "real"]),
    randomness: z.enum(["seeded", "system"]),
    identifiers: z.enum(["deterministic", "runtime"]),
    seed: z.number().int().min(0).max(0xffff_ffff),
  }),
  authority: z.strictObject({
    preparation_approved: z.literal(true),
    execution_approved: z.literal(false),
    network: z.enum(["none", "loopback"]),
    provider_owned_process_only: z.literal(true),
  }),
});

export type RuntimeCharacterizationPlan = z.infer<
  typeof runtimeCharacterizationPlanSchema
>;

/** Commit a provider-neutral preparation plan; execution requires a later approval. */
export const createRuntimeCharacterizationPlan = (
  input: Omit<z.input<typeof runtimeCharacterizationPlanSchema>, "plan_sha256">,
): RuntimeCharacterizationPlan => {
  const parsed = runtimeCharacterizationPlanSchema
    .omit({ plan_sha256: true })
    .parse(input);
  return runtimeCharacterizationPlanSchema.parse({
    ...parsed,
    plan_sha256: digest(parsed),
  });
};

/** Parse a characterization plan and reject altered commitments. */
export const parseRuntimeCharacterizationPlan = (
  input: unknown,
): RuntimeCharacterizationPlan => {
  const parsed = runtimeCharacterizationPlanSchema.parse(input);
  const { plan_sha256: planSha256, ...semantic } = parsed;
  if (planSha256 !== digest(semantic))
    throw new TypeError("Runtime characterization plan digest is invalid");
  return parsed;
};

const digest = (value: unknown): string => {
  const encoded = canonicalize(value);
  if (encoded === undefined)
    throw new TypeError("Runtime characterization plan is not canonical JSON");
  return createHash("sha256").update(encoded).digest("hex");
};
