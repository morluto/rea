import { posix } from "node:path";

import {
  absoluteCallerPath,
  appendCallerPath,
} from "../filesystem/callerPath.js";

/** One file a POSIX launcher tries for a bare command, in search order. */
export interface PathSearchCandidate {
  /** The absolute file the launch would execute from this entry. */
  readonly path: string;
  /** An empty or relative PATH entry, which depends on the working directory. */
  readonly relativeEntry: boolean;
}

/**
 * How entries that depend on the working directory are searched: `skip` leaves
 * them out; otherwise they resolve against `workingDirectory`, or against this
 * process's directory when omitted (read only when such an entry exists).
 */
export type RelativePathEntries =
  | { readonly relativeEntries: "skip" }
  | { readonly relativeEntries: "resolve"; readonly workingDirectory?: string };

/**
 * The files `execvp` tries for a bare command (one without `/`), in PATH
 * order: an empty entry names the working directory and a relative entry
 * resolves against it. `..` is kept for the filesystem to resolve after any
 * symbolic link. Each caller decides how a candidate is probed and how a
 * failed probe is reported; this owner fixes only the search order.
 * Candidates are produced on demand: stop iterating at the first match.
 */
export function* posixPathCandidates(
  command: string,
  searchPath: string,
  selection: RelativePathEntries,
): Generator<PathSearchCandidate, void, undefined> {
  // Lazy, so an entry after the first match is never resolved: resolving a
  // relative entry reads the working directory, which may no longer exist.
  for (const directory of searchPath.split(posix.delimiter)) {
    const relativeEntry = !posix.isAbsolute(directory);
    if (relativeEntry && selection.relativeEntries === "skip") continue;
    const workingDirectory =
      selection.relativeEntries === "resolve"
        ? selection.workingDirectory
        : undefined;
    yield {
      path: absoluteCallerPath(appendCallerPath(directory, command, "linux"), {
        ...(workingDirectory === undefined ? {} : { cwd: workingDirectory }),
        platform: "linux",
      }),
      relativeEntry,
    };
  }
}
