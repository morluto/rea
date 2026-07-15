import { createHash } from "node:crypto";

import canonicalize from "canonicalize";
import { z } from "zod";

import { isJsonWithinLimits } from "./jsonLimits.js";
import { jsonObjectSchema, type JsonValue } from "./jsonValue.js";

const PROFILE_MAX_BYTES = 64 * 1024;
const PROFILE_JSON_LIMITS = Object.freeze({
  maxDepth: 16,
  maxStringLength: 16 * 1024,
  maxNodes: 4_096,
});
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);

/** Concrete provider identity committed by an analysis profile. */
export const committedProviderSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
});

const boundedParametersSchema = jsonObjectSchema.superRefine(
  (parameters, context) => {
    if (!isJsonWithinLimits(parameters, PROFILE_JSON_LIMITS)) {
      context.addIssue({
        code: "custom",
        message: "Analysis profile parameters exceed structural limits",
      });
      return;
    }
    if (
      Buffer.byteLength(canonicalJson(parameters), "utf8") > PROFILE_MAX_BYTES
    )
      context.addIssue({
        code: "custom",
        message: "Analysis profile parameters exceed the byte limit",
      });
  },
);

const unsignedAnalysisProfileSchema = z.object({
  schema_version: z.literal(1),
  provider: committedProviderSchema,
  provider_profile_schema_version: z.number().int().min(1),
  parameters: boundedParametersSchema,
});

/** Canonical, provider-neutral commitment to analysis-affecting semantics. */
export const analysisProfileSchema = unsignedAnalysisProfileSchema
  .extend({ digest: digestSchema })
  .superRefine((profile, context) => {
    const { digest: _digest, ...unsigned } = profile;
    if (profileDigest(unsigned) !== profile.digest)
      context.addIssue({
        code: "custom",
        path: ["digest"],
        message: "Analysis profile digest does not match its parameters",
      });
  });

export type CommittedProviderIdentity = z.infer<typeof committedProviderSchema>;
export type AnalysisProfileCommitment = z.infer<typeof analysisProfileSchema>;

/** Create a validated RFC 8785 profile commitment at a provider boundary. */
export const createAnalysisProfile = (
  provider: CommittedProviderIdentity,
  providerProfileSchemaVersion: number,
  parameters: Readonly<Record<string, JsonValue>>,
): AnalysisProfileCommitment => {
  const unsigned = unsignedAnalysisProfileSchema.parse({
    schema_version: 1,
    provider,
    provider_profile_schema_version: providerProfileSchemaVersion,
    parameters,
  });
  return analysisProfileSchema.parse({
    ...unsigned,
    digest: profileDigest(unsigned),
  });
};

/** Compare two already-validated commitments without interpreting parameters. */
export const analysisProfilesEqual = (
  left: AnalysisProfileCommitment,
  right: AnalysisProfileCommitment,
): boolean =>
  left.digest === right.digest &&
  left.provider.id === right.provider.id &&
  left.provider.name === right.provider.name &&
  left.provider.version === right.provider.version &&
  left.schema_version === right.schema_version &&
  left.provider_profile_schema_version ===
    right.provider_profile_schema_version;

const profileDigest = (
  profile: z.infer<typeof unsignedAnalysisProfileSchema>,
): string => createHash("sha256").update(canonicalJson(profile)).digest("hex");

const canonicalJson = (value: JsonValue): string => {
  const encoded = canonicalize(value);
  if (encoded === undefined)
    throw new TypeError("RFC 8785 canonicalization rejected analysis profile");
  return encoded;
};
