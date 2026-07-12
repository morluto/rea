import { err, ok } from "../domain/result.js";
import { traverseDirectory } from "./ReferenceSourceReaderEntries.js";
import { compareNames } from "./ReferenceSourceReaderPaths.js";
import {
  type ReferenceSourceLimits,
  type ReferenceSourceReaderOptions,
  type ReferenceSourceRead,
  type ReferenceSourceResult,
  type TraversalState,
} from "./ReferenceSourceReaderTypes.js";
import {
  isAborted,
  noFollowOpenSupported,
  prepareRoot,
} from "./ReferenceSourceReaderValidate.js";

export type {
  ReferenceSourceEntry,
  ReferenceSourceLimits,
  ReferenceSourceRead,
  ReferenceSourceReaderOptions,
} from "./ReferenceSourceReaderTypes.js";

const DEFAULT_LIMITS: ReferenceSourceLimits = {
  maxBytes: 16 * 1024 * 1024,
  maxEntries: 10_000,
  maxDepth: 32,
  maxPathBytes: 4_096,
};
const PATH_RACE_LIMITATION =
  "Path identity is revalidated around operations; Node lacks portable descriptor-relative openat traversal, so a syscall-boundary pathname race remains.";

/** Read a bounded source tree without intentionally following symbolic links. */
export const readReferenceSource = async (
  root: string,
  limits: ReferenceSourceLimits = DEFAULT_LIMITS,
  options: ReferenceSourceReaderOptions = {},
): Promise<ReferenceSourceResult<ReferenceSourceRead>> => {
  if (!noFollowOpenSupported())
    return err({
      tag: "reference-source-reader",
      code: "unsupported",
      message: "Safe no-follow file opens are unavailable",
    });
  const prepared = await prepareRoot(root, limits, options.signal);
  if (!prepared.ok) return prepared;
  const { canonicalRoot, rootIdentity } = prepared.value;
  const state: TraversalState = {
    root: canonicalRoot,
    rootIdentity,
    limits,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.shouldExclude === undefined
      ? {}
      : { shouldExclude: options.shouldExclude }),
    entries: [],
    pending: [{ path: canonicalRoot, depth: 0 }],
    bytesRead: 0,
    filesSeen: 0,
    truncated: false,
    stopped: false,
  };
  const traversal = await traverse(state);
  if (!traversal.ok) return traversal;
  state.entries.sort((left, right) => compareNames(left.path, right.path));
  return ok({
    root: canonicalRoot,
    entries: state.entries,
    bytesRead: state.bytesRead,
    truncated: state.truncated,
    limitations: [
      PATH_RACE_LIMITATION,
      ...(state.stopped
        ? ["Traversal stopped because the entry limit was reached."]
        : []),
    ],
  });
};

const traverse = async (
  state: TraversalState,
): Promise<ReferenceSourceResult<undefined>> => {
  while (state.pending.length > 0 && !state.stopped) {
    if (isAborted(state.signal))
      return err({
        tag: "reference-source-reader",
        code: "cancelled",
        message: "Reference source traversal cancelled",
      });
    const current = state.pending.pop();
    if (current === undefined) break;
    const result = await traverseDirectory(state, current);
    if (!result.ok) return result;
  }
  return ok(undefined);
};
