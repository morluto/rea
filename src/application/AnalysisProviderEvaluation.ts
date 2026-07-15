import {
  analysisProfileSchema,
  type AnalysisProfileCommitment,
} from "../domain/analysisProfile.js";
import type { BinaryTarget } from "../domain/binaryTarget.js";
import { AnalysisCancelledError } from "../domain/errors.js";
import { jsonObjectSchema, type JsonValue } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";
import type { AnalysisProviderCandidate } from "./AnalysisProvider.js";
import type { AnalysisProviderCandidateStatus } from "./AnalysisProviderRegistry.js";
import { ABORTED, waitForAbortable } from "./AbortablePromise.js";

/** Profile-resolution truth for one discovered provider candidate. */
export interface AnalysisProviderCandidateEvaluation {
  readonly candidate: AnalysisProviderCandidate;
  readonly status: AnalysisProviderCandidateStatus;
  readonly profile?: AnalysisProfileCommitment;
  readonly compatibility?: Readonly<Record<string, JsonValue>>;
}

/** Resolve and validate one provider profile without starting its client. */
export const evaluateAnalysisProviderCandidate = async (
  candidate: AnalysisProviderCandidate,
  status: AnalysisProviderCandidateStatus,
  target: BinaryTarget,
  signal: AbortSignal | undefined,
): Promise<
  Result<AnalysisProviderCandidateEvaluation, AnalysisCancelledError>
> => {
  if (signalIsAborted(signal))
    return err(new AnalysisCancelledError("open_binary"));
  let resolved: Awaited<ReturnType<typeof candidate.resolveAnalysisProfile>>;
  try {
    const resolution = await waitForAbortable(
      candidate.resolveAnalysisProfile(
        target,
        signal === undefined ? undefined : { signal },
      ),
      signal,
    );
    if (resolution === ABORTED)
      return err(new AnalysisCancelledError("open_binary"));
    resolved = resolution;
  } catch {
    return ok(
      rejectedProfile(candidate, status, "Provider profile resolution threw"),
    );
  }
  if (signalIsAborted(signal))
    return err(new AnalysisCancelledError("open_binary"));
  if (!resolved.ok && resolved.error instanceof AnalysisCancelledError)
    return err(resolved.error);
  if (!resolved.ok)
    return ok(
      rejectedProfile(candidate, status, resolved.error.message, {
        error_tag: resolved.error._tag,
      }),
    );
  try {
    if (resolved.value.profile === null)
      return ok(
        rejectedProfile(
          candidate,
          status,
          "Provider version or analysis profile could not be resolved",
        ),
      );
    const profile = analysisProfileSchema.parse(resolved.value.profile);
    const compatibility = jsonObjectSchema.parse(resolved.value.compatibility);
    const identity = candidate.identity();
    if (
      profile.provider.id !== identity.id ||
      profile.provider.name !== identity.name ||
      (identity.version !== null &&
        profile.provider.version !== identity.version)
    )
      return ok(
        rejectedProfile(
          candidate,
          status,
          "Resolved analysis profile has mismatched provider identity",
        ),
      );
    return ok({ candidate, status, profile, compatibility });
  } catch {
    return ok(
      rejectedProfile(
        candidate,
        status,
        "Provider returned an invalid analysis profile",
      ),
    );
  }
};

const signalIsAborted = (signal: AbortSignal | undefined): boolean =>
  signal?.aborted === true;

const rejectedProfile = (
  candidate: AnalysisProviderCandidate,
  status: AnalysisProviderCandidateStatus,
  reason: string,
  diagnostics: Readonly<Record<string, JsonValue>> = {},
): AnalysisProviderCandidateEvaluation => ({
  candidate,
  status: {
    ...status,
    availability: {
      status: "unavailable",
      code: "version_unresolved",
      reason,
      diagnostics: jsonObjectSchema.parse({
        ...status.availability.diagnostics,
        ...diagnostics,
      }),
    },
  },
});
