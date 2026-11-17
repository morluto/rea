import { posix } from "node:path";

import { createReferenceSourcePathLookup } from "../domain/referenceSourcePathIdentity.js";
import type { TraversalState } from "./ReferenceSourceReaderTraversal.js";
import type {
  ReferenceSourceEntry,
  ReferenceSourceRootFailure,
} from "./ReferenceSourceReaderTypes.js";
import { isAborted } from "./ReferenceSourceReaderValidate.js";

/**
 * Resolve internal link observations against the completed reader inventory.
 * If the closest containing directory failed before enumeration completed,
 * the target remains unknown; a broader failed ancestor cannot override a
 * successfully enumerated directory or a recorded exclusion.
 */
export const reconcileUnobservedSymlinkTargets = (
  entries: ReferenceSourceEntry[],
  exclusions: TraversalState["exclusions"] = [],
  signal?: AbortSignal,
  rootFailure?: ReferenceSourceRootFailure,
): void => {
  const failedDirectories = new Map(
    entries.flatMap((entry) =>
      entry.status === "failed" &&
      entry.kind === "directory" &&
      entry.code !== "cancelled"
        ? [[entry.path, entry] as const]
        : [],
    ),
  );
  if (
    (failedDirectories.size === 0 && rootFailure === undefined) ||
    isAborted(signal)
  )
    return;
  const directoryEntries = entries.filter(
    (entry) => entry.kind === "directory",
  );
  const directoryPaths = createReferenceSourcePathLookup(
    directoryEntries.map(({ path }) => path),
  );
  const observedPaths = createReferenceSourcePathLookup(
    entries.map(({ path }) => path),
  );
  const excludedPaths = createReferenceSourcePathLookup(
    exclusions.map(({ path }) => path),
  );
  for (const [index, entry] of entries.entries()) {
    if (isAborted(signal)) return;
    if (
      entry.status !== "read" ||
      entry.kind !== "symlink" ||
      entry.targetState !== "internal" ||
      observedPaths.resolve(entry.target) !== undefined ||
      excludedPaths.resolve(entry.target) !== undefined
    )
      continue;
    const ancestor = nearestFailedAncestor(
      entry.target,
      directoryPaths,
      failedDirectories,
      excludedPaths,
      signal,
      rootFailure,
    );
    if (ancestor === undefined) continue;
    entries[index] = {
      status: "failed",
      kind: "symlink",
      path: entry.path,
      code: ancestor.code,
      message: `Symbolic link target ${JSON.stringify(entry.target)} was not inventoried because directory ${JSON.stringify(ancestor.path)} could not be enumerated: ${ancestor.message}`,
    };
  }
};

const nearestFailedAncestor = (
  target: string,
  directoryPaths: ReturnType<typeof createReferenceSourcePathLookup>,
  failedDirectories: ReadonlyMap<
    string,
    Extract<ReferenceSourceEntry, { status: "failed" }>
  >,
  excludedPaths: ReturnType<typeof createReferenceSourcePathLookup>,
  signal: AbortSignal | undefined,
  rootFailure: ReferenceSourceRootFailure | undefined,
): (ReferenceSourceRootFailure & { readonly path: string }) | undefined => {
  for (
    let candidate = posix.dirname(target);
    candidate !== "." && candidate !== "/";
    candidate = posix.dirname(candidate)
  ) {
    if (isAborted(signal)) return undefined;
    if (excludedPaths.resolve(candidate) !== undefined) return undefined;
    const observedDirectory = directoryPaths.resolve(candidate);
    if (observedDirectory !== undefined)
      return failedDirectories.get(observedDirectory);
  }
  if (isAborted(signal)) return undefined;
  if (excludedPaths.resolve(".") !== undefined) return undefined;
  return rootFailure === undefined ? undefined : { path: ".", ...rootFailure };
};
