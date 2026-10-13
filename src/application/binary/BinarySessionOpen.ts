import type { ExecutableFormatHint } from "../../domain/dosCom.js";
import type { BinaryArchitecture } from "../../domain/binaryTargetTypes.js";
import type { AnalysisProviderSelector } from "../../contracts/providerSelection.js";
import type { AnalysisProfileCommitment } from "../../domain/analysisProfile.js";
import {
  snapshotMatchesBinding,
  snapshotMatchesTarget,
  snapshotTarget,
} from "../../domain/analysisSnapshot.js";
import type { AnalysisSnapshot } from "../../domain/analysisSnapshot.js";
import { parseBinaryTarget } from "../BinaryTargetResolver.js";
import type { BinaryTarget } from "../../domain/binaryTargetTypes.js";
import {
  EvidenceIntegrityError,
  AnalysisSnapshotMismatchError,
} from "../../domain/evidenceErrors.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { err, type Result } from "../../domain/result.js";
import type { SessionProviderRoute } from "./SessionProviderRouter.js";
import { SessionProviderRouter } from "./SessionProviderRouter.js";

export interface BinarySessionOpenOptions {
  readonly signal?: AbortSignal;
  readonly targetKind?: BinaryTarget["kind"];
  readonly formatHint?: ExecutableFormatHint;
  readonly architecture?: BinaryArchitecture;
  readonly entryPoint?: string;
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

interface ResolveSessionTargetInput {
  readonly router: SessionProviderRouter;
  readonly current: CurrentOpenBinding | undefined;
  readonly target: BinaryTarget;
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
  const { path, options } = input;
  const parsed = await parseBinaryTarget(path, {
    ...(options.targetKind === undefined
      ? {}
      : { targetKind: options.targetKind }),
    ...(options.formatHint === undefined
      ? {}
      : { formatHint: options.formatHint }),
    ...(options.architecture === undefined
      ? {}
      : { architecture: options.architecture }),
    ...(options.entryPoint === undefined
      ? {}
      : { entryPoint: options.entryPoint }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (!parsed.ok) return parsed;
  return resolveSessionTarget({ ...input, target: parsed.value });
};

/** Resolve a known target's provider route and validate snapshot binding. */
export const resolveSessionTarget = async (
  input: ResolveSessionTargetInput,
): Promise<Result<ResolvedSessionOpen, AnalysisError>> => {
  const { router, current, target, options } = input;
  const sameTarget = sameSessionTarget(current?.target, target);
  const resolvedRoute =
    sameTarget && options.providerId === undefined && current !== undefined
      ? ({ ok: true, value: current.route } as const)
      : await router.resolve(target, options.providerId, options.signal);
  if (!resolvedRoute.ok) return resolvedRoute;
  return validateResolvedSessionTarget({
    ...input,
    route: resolvedRoute.value,
  });
};

/** Revalidate a previewed route against the current session and snapshot binding. */
export const validateResolvedSessionTarget = (
  input: Omit<ResolveSessionTargetInput, "router"> & {
    readonly route: SessionProviderRoute;
  },
): Result<ResolvedSessionOpen, AnalysisError> => {
  const { current, target, route, options, stagedSnapshotMatches } = input;
  const sameTarget = sameSessionTarget(current?.target, target);
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

const sameSessionTarget = (
  current: BinaryTarget | undefined,
  target: BinaryTarget,
): boolean =>
  current !== undefined &&
  current.path === target.path &&
  // Native admission is bound to the requested path, not just its realpath.
  (current.sourcePath ?? current.path) === (target.sourcePath ?? target.path) &&
  snapshotMatchesTarget(snapshotTarget(current), target);

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
    return new AnalysisSnapshotMismatchError(
      "Analysis snapshot profile_mismatch: target, provider, or analysis profile does not match the requested binary",
    );
  if (current === undefined && !stagedSnapshotMatches(target, profile))
    return new AnalysisSnapshotMismatchError(
      "Analysis snapshot profile_mismatch: staged target, provider, or analysis profile does not match",
    );
  return undefined;
};
