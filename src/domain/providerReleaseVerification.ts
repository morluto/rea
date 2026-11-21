import { z } from "zod";

/** Provider-owned verification of a reported release version, not executable authenticity. */
export const providerReleaseVerificationSchema = z
  .strictObject({
    status: z.enum(["verified", "unverified"]),
    basis: z.literal("reported_version"),
    reported_version: z.string().min(1),
    verified_version: z.string().min(1),
    explanation: z.string().min(1),
    remediation: z.string().min(1).nullable(),
  })
  .describe(
    "Provider-reported release version comparison at binding, not a fresh executable check; this does not authenticate bytes or prove target correctness. Omission means verification was not reported.",
  );

export type ProviderReleaseVerification = z.infer<
  typeof providerReleaseVerificationSchema
>;
