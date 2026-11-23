import { compareUnicodeCodePoints } from "../domain/unicodeCodePointOrder.js";
import { err, ok } from "../domain/result.js";
import {
  ArtifactReaderFailure,
  type ArtifactResourceScope,
} from "../resources/index.js";
import {
  prefetchDirectoryValidations,
  settleDirectoryAdmissions,
  traverseDirectory,
} from "./ReferenceSourceReaderEntries.js";
import type {
  ReferenceSourceReaderOptions,
  ReferenceSourceRead,
  ReferenceSourceResult,
} from "./ReferenceSourceReaderTypes.js";
import {
  isAborted,
  noFollowOpenSupported,
  prepareRoot,
} from "./ReferenceSourceReaderValidate.js";
import { cancelled } from "./ReferenceSourceReaderErrors.js";
import type { TraversalState } from "./ReferenceSourceReaderTraversal.js";
import { referenceSourceResourceFailure } from "./ReferenceSourceFailureBuilders.js";
import { reconcileUnobservedSymlinkTargets } from "./ReferenceSourceSymlinkTargets.js";

const PATH_RACE_LIMITATION =
  "Path identity is revalidated around operations; Node lacks portable descriptor-relative openat traversal, so a syscall-boundary pathname race remains.";

/** Read a source tree without intentionally following symbolic links. */
export const readReferenceSource = async (
  root: string,
  resources: ArtifactResourceScope,
  options: ReferenceSourceReaderOptions = {},
): Promise<ReferenceSourceResult<ReferenceSourceRead>> => {
  let result: ReferenceSourceResult<ReferenceSourceRead>;
  try {
    result = await resources.run(() => readSource(root, resources, options));
  } catch (cause: unknown) {
    if (!(cause instanceof ArtifactReaderFailure)) throw cause;
    result = err(referenceSourceResourceFailure(cause));
  }
  if (
    !result.ok &&
    result.error.code !== "cancelled" &&
    options.signal?.aborted
  )
    return err({
      ...result.error,
      secondaryCancellation: { cause: options.signal.reason },
    });
  return result;
};

const readSource = async (
  root: string,
  resources: ArtifactResourceScope,
  options: ReferenceSourceReaderOptions,
): Promise<ReferenceSourceResult<ReferenceSourceRead>> => {
  if (!noFollowOpenSupported())
    return err({
      tag: "reference-source-reader",
      code: "unsupported",
      message: "Safe no-follow file opens are unavailable",
    });
  const prepared = await prepareRoot(root, options.signal);
  if (!prepared.ok) return prepared;
  const { canonicalRoot, rootIdentity } = prepared.value;
  const state: TraversalState = {
    resources,
    root: canonicalRoot,
    rootIdentity,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.shouldExclude === undefined
      ? {}
      : { shouldExclude: options.shouldExclude }),
    ...(options.beforeDirectory === undefined
      ? {}
      : { beforeDirectory: options.beforeDirectory }),
    entries: [],
    exclusions: [],
    pending: [{ path: canonicalRoot }],
    settling: [],
    openingLookups: 0,
    bytesRead: 0,
  };
  const traversal = await traverse(state);
  if (
    !isAborted(state.signal) &&
    (traversal.ok || traversal.error.code !== "cancelled")
  )
    reconcileUnobservedSymlinkTargets(
      state.entries,
      state.exclusions,
      state.signal,
      state.rootFailure,
    );
  state.entries.sort((left, right) =>
    compareUnicodeCodePoints(left.path, right.path),
  );
  const read: ReferenceSourceRead = {
    root: canonicalRoot,
    ...(state.rootFailure === undefined
      ? {}
      : { rootFailure: state.rootFailure }),
    entries: state.entries,
    bytesRead: state.bytesRead,
    limitations: [PATH_RACE_LIMITATION],
  };
  if (traversal.ok && state.rootFailure?.code === "io")
    return err({
      tag: "reference-source-reader",
      code: "io",
      message: state.rootFailure.message,
      ...(state.rootFailureCause === undefined
        ? {}
        : { cause: state.rootFailureCause.value }),
      partial: read,
    });
  return traversal.ok ? ok(read) : err({ ...traversal.error, partial: read });
};

const traverse = async (
  state: TraversalState,
): Promise<ReferenceSourceResult<undefined>> => {
  try {
    while (state.pending.length > 0) {
      if (isAborted(state.signal)) {
        await settleDirectoryAdmissions(state);
        return err(cancelled(state.signal));
      }
      prefetchDirectoryValidations(state);
      const current = state.pending.pop();
      if (current === undefined) break;
      const result = await traverseDirectory(state, current);
      if (!result.ok) {
        await settleDirectoryAdmissions(state);
        return result;
      }
    }
    await settleDirectoryAdmissions(state);
    return isAborted(state.signal)
      ? err(cancelled(state.signal))
      : ok(undefined);
  } finally {
    // No observation started ahead of its turn outlives the read.
    await Promise.allSettled([
      ...state.settling,
      ...state.pending.flatMap(({ validation }) => validation ?? []),
    ]);
  }
};
