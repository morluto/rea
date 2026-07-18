import type { AnalysisProviderSelector } from "../contracts/providerSelection.js";
import type { AnalysisProfileCommitment } from "../domain/analysisProfile.js";
import {
  snapshotMatchesBinding,
  snapshotMatchesTarget,
  snapshotTarget,
} from "../domain/analysisSnapshot.js";
import type { AnalysisSnapshot } from "../domain/analysisSnapshot.js";
import {
  parseBinaryTarget,
  type BinaryTarget,
} from "../domain/binaryTarget.js";
import {
  EvidenceIntegrityError,
  type AnalysisError,
} from "../domain/errors.js";
import { err, type Result } from "../domain/result.js";
import type { SessionProviderRoute } from "./SessionProviderRouter.js";
import { SessionProviderRouter } from "./SessionProviderRouter.js";

export interface BinarySessionOpenOptions {
  readonly signal?: AbortSignal;
  readonly targetKind?: BinaryTarget["kind"];
  readonly snapshot?: AnalysisSnapshot;
  readonly providerId?: AnalysisProviderSelector;
}

interface CurrentOpenBinding {
  readonly target: BinaryTarget;
  readonly profile: AnalysisProfileCommitment | null;
  readonly route: SessionProviderRoute;
}

export interface ResolvedSessionOpen {
  readonly target: BinaryTarget;
  readonly route: SessionProviderRoute;
  readonly sameTarget: boolean;
}

interface ResolveSessionOpenInput {
  readonly router: SessionProviderRouter;
  readonly current: CurrentOpenBinding | undefined;
  readonly path: string;
  readonly options: BinarySessionOpenOptions;
  readonly stagedSnapshotMatches: (
    target: BinaryTarget,
    profile: AnalysisProfileCommitment | null,
  ) => boolean;
}

/** Parse a target, resolve its provider route, and validate snapshot binding. */
export const resolveSessionOpen = async (
  input: ResolveSessionOpenInput,
): Promise<Result<ResolvedSessionOpen, AnalysisError>> => {
  const { router, current, path, options, stagedSnapshotMatches } = input;
  const parsed = await parseBinaryTarget(
    path,
    process.cwd(),
    process.arch,
    options.targetKind,
  );
  if (!parsed.ok) return parsed;
  const target = parsed.value;
  const sameTarget =
    current?.target.path === target.path &&
    snapshotMatchesTarget(snapshotTarget(current.target), target);
  const resolvedRoute =
    sameTarget && options.providerId === undefined && current !== undefined
      ? ({ ok: true, value: current.route } as const)
      : await router.resolve(target, options.providerId, options.signal);
  if (!resolvedRoute.ok) return resolvedRoute;
  const route = resolvedRoute.value;
  const snapshotError = validateSnapshot({
    snapshot: options.snapshot,
    target,
    profile: route.profile,
    current,
    stagedSnapshotMatches,
  });
  if (snapshotError !== undefined) return err(snapshotError);
  return { ok: true, value: { target, route, sameTarget } };
};

interface ValidateSnapshotInput {
  readonly snapshot: AnalysisSnapshot | undefined;
  readonly target: BinaryTarget;
  readonly profile: AnalysisProfileCommitment | null;
  readonly current: CurrentOpenBinding | undefined;
  readonly stagedSnapshotMatches: (
    target: BinaryTarget,
    profile: AnalysisProfileCommitment | null,
  ) => boolean;
}

const validateSnapshot = ({
  snapshot,
  target,
  profile,
  current,
  stagedSnapshotMatches,
}: ValidateSnapshotInput): EvidenceIntegrityError | undefined => {
  if (
    snapshot !== undefined &&
    (profile === null || !snapshotMatchesBinding(snapshot, target, profile))
  )
    return new EvidenceIntegrityError(
      "Analysis snapshot profile_mismatch: target, provider, or analysis profile does not match the requested binary",
    );
  if (current === undefined && !stagedSnapshotMatches(target, profile))
    return new EvidenceIntegrityError(
      "Analysis snapshot profile_mismatch: staged target, provider, or analysis profile does not match",
    );
  return undefined;
};
