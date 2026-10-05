import { createHash } from "node:crypto";

import canonicalize from "canonicalize";
import { z } from "zod";

import { jsonObjectSchema, type JsonValue } from "./jsonValue.js";
import { digestSchema } from "./../domain/digests.js";

/** Concrete provider identity committed by an analysis profile. */
export const committedProviderSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
});

const unsignedAnalysisProfileSchema = z.object({
  provider: committedProviderSchema,
  parameters: jsonObjectSchema,
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
  parameters: Readonly<Record<string, JsonValue>>,
): AnalysisProfileCommitment => {
  const unsigned = unsignedAnalysisProfileSchema.parse({
    provider,
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
  left.provider.version === right.provider.version;

const profileDigest = (
  profile: z.infer<typeof unsignedAnalysisProfileSchema>,
): string => createHash("sha256").update(canonicalJson(profile)).digest("hex");

const canonicalJson = (value: JsonValue): string => {
  const encoded = canonicalize(value);
  if (encoded === undefined)
    throw new TypeError("RFC 8785 canonicalization rejected analysis profile");
  return encoded;
};
