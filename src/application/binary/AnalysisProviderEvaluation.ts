import {
  analysisProfileSchema,
  type AnalysisProfileCommitment,
} from "../../domain/analysisProfile.js";
import type { BinaryTarget } from "../../domain/binaryTargetTypes.js";
import {
  AnalysisCancelledError,
  AnalysisUnsupportedTargetError,
} from "../../domain/analysisErrorCore.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import { jsonObjectSchema, type JsonValue } from "../../domain/jsonValue.js";
import { err, ok, type Result } from "../../domain/result.js";
import type {
  AnalysisProviderBoundClientFactory,
  AnalysisProfileResolutionOptions,
  AnalysisProviderCandidate,
} from "../AnalysisProvider.js";
import type { AnalysisProviderCandidateStatus } from "./AnalysisProviderRegistry.js";
import { withCandidateRejections } from "./AnalysisProviderCandidateDiagnostics.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { isDoctorProviderId } from "../../domain/doctorProviderIds.js";
import {
  providerReleaseVerificationSchema,
  type ProviderReleaseVerification,
} from "../../domain/providerReleaseVerification.js";

import { analysisErrorRemediationAction } from "../../domain/analysisErrorPresentation.js";

/** Profile-resolution truth for one discovered provider candidate. */
export interface AnalysisProviderCandidateEvaluation {
  readonly candidate: AnalysisProviderCandidate;
  readonly status: AnalysisProviderCandidateStatus;
  readonly profile?: AnalysisProfileCommitment;
  readonly refreshAfterRetirement?: true;
  readonly createClient?: AnalysisProviderBoundClientFactory;
  readonly releaseVerification?: ProviderReleaseVerification;
  readonly profileError?: AnalysisError;
}

/** Resolve and validate one provider profile without starting its client. */
export const evaluateAnalysisProviderCandidate = async (
  candidate: AnalysisProviderCandidate,
  status: AnalysisProviderCandidateStatus,
  target: BinaryTarget,
  options: AnalysisProfileResolutionOptions = {},
): Promise<
  Result<AnalysisProviderCandidateEvaluation, AnalysisCancelledError>
> => {
  const { signal } = options;
  if (signalIsAborted(signal))
    return err(
      new AnalysisCancelledError("open_binary", { cause: signal?.reason }),
    );
  let resolved: Awaited<ReturnType<typeof candidate.resolveAnalysisProfile>>;
  try {
    resolved = await candidate.resolveAnalysisProfile(target, options);
  } catch (cause: unknown) {
    resolved = err(
      cause instanceof AnalysisError
        ? cause
        : new ProviderAdapterError(
            status.provider.id,
            "resolve_analysis_profile",
            {
              cause,
              diagnostics: { reason: "Provider profile resolution threw" },
            },
          ),
    );
  }
  if (!resolved.ok && resolved.error instanceof AnalysisCancelledError)
    return err(resolved.error);
  if (!resolved.ok) {
    const error = resolved.error;
    const rejection =
      error instanceof AnalysisUnsupportedTargetError
        ? {
            candidate,
            status: withCandidateRejections({
              ...status,
              targetSupport: {
                status: "unsupported" as const,
                code: "target_format_unsupported" as const,
                reason: error.reason,
                diagnostics: { path: error.path, error_tag: error._tag },
              },
            }),
          }
        : rejectedProfile(
            candidate,
            status,
            {
              reason: error.message,
              remediation: analysisErrorRemediationAction(error),
            },
            { error_tag: error._tag },
          );
    return ok({ ...rejection, profileError: error });
  }
  if (signalIsAborted(signal))
    return err(
      new AnalysisCancelledError("open_binary", { cause: signal?.reason }),
    );
  try {
    if (resolved.value.profile === null)
      return ok(
        rejectedProfile(candidate, status, {
          reason: "Provider version or analysis profile could not be resolved",
          remediation: profileRemediation(candidate),
        }),
      );
    const profile = analysisProfileSchema.parse(resolved.value.profile);
    const identity = candidate.identity();
    if (
      profile.provider.id !== identity.id ||
      profile.provider.name !== identity.name ||
      (identity.version !== null &&
        profile.provider.version !== identity.version)
    )
      return ok(
        rejectedProfile(candidate, status, {
          reason: "Resolved analysis profile has mismatched provider identity",
          remediation: profileRemediation(candidate),
        }),
      );
    const verification =
      resolved.value.releaseVerification === undefined
        ? undefined
        : providerReleaseVerificationSchema.safeParse(
            resolved.value.releaseVerification,
          );
    if (verification?.success === false)
      return ok(
        rejectedProfile(candidate, status, {
          reason: "Provider returned invalid release verification",
          remediation: profileRemediation(candidate),
        }),
      );
    return ok({
      candidate,
      status,
      profile,
      ...(verification === undefined
        ? {}
        : {
            releaseVerification: verification.data,
          }),

      ...(resolved.value.refreshAfterRetirement === undefined
        ? {}
        : { refreshAfterRetirement: resolved.value.refreshAfterRetirement }),
      ...(resolved.value.createClient === undefined
        ? {}
        : { createClient: resolved.value.createClient }),
    });
  } catch (cause: unknown) {
    void cause;
    return ok(
      rejectedProfile(candidate, status, {
        reason: "Provider returned an invalid analysis profile",
        remediation: profileRemediation(candidate),
      }),
    );
  }
};

const signalIsAborted = (signal: AbortSignal | undefined): boolean =>
  signal?.aborted === true;

/** Name doctor only for a provider whose installation it can check. */
const profileRemediation = (candidate: AnalysisProviderCandidate): string => {
  const providerId = candidate.identity().id;
  return isDoctorProviderId(providerId)
    ? `Run rea doctor --provider ${providerId} to check this provider's installation and version, then reopen the target, or select another analysis provider.`
    : `Check the ${providerId} provider's installation and version against its documented requirements, then reopen the target, or select another analysis provider.`;
};

const rejectedProfile = (
  candidate: AnalysisProviderCandidate,
  status: AnalysisProviderCandidateStatus,
  rejection: { readonly reason: string; readonly remediation: string },
  diagnostics: Readonly<Record<string, JsonValue>> = {},
): AnalysisProviderCandidateEvaluation => ({
  candidate,
  status: withCandidateRejections({
    ...status,
    availability: {
      status: "unavailable",
      code: "version_unresolved",
      ...rejection,
      diagnostics: jsonObjectSchema.parse({
        ...status.availability.diagnostics,
        ...diagnostics,
      }),
    },
  }),
});
