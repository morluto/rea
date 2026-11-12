import { realpathSync } from "node:fs";
import { resolve, win32 } from "node:path";

import {
  javaScriptRuntime,
  type JavaScriptRuntime,
} from "../domain/runtimeVersion.js";

/**
 * Whether a spelling names a network share rather than a mounted file.
 *
 * `absoluteLocalPathStringSchema` accepts a UNC spelling, so a caller can supply one. Reading
 * such a path starts SMB traffic and can block on ambient Windows authentication, while
 * `TOOL_EFFECTS.binary_session` still declares `accessesNetwork: false`. Every resolution in
 * this module therefore skips the filesystem for a share and stays lexical.
 */
export const isNetworkSharePath = (candidate: string): boolean =>
  /^[\x5C\x2F]{2}[^\x5C\x2F]/u.test(candidate);

/**
 * Whether a spelling carries a parent segment that Bun traverses differently.
 *
 * Bun follows a directory symlink before `..`, while `realpath` normalizes the parent
 * lexically. `ClientRegistrationIdentity.entrypointIdentity` already treats that shape as
 * undecidable; this predicate is the same rule, kept in one place.
 */
export const traversalSemanticsDiffer = (
  candidate: string,
  runtime: JavaScriptRuntime["id"] = javaScriptRuntime(process.versions).id,
): boolean =>
  process.platform !== "win32" &&
  runtime === "bun" &&
  candidate.split(/[\\/]/u).includes("..");

/** Whether a spelling carries a parent segment. */
const hasParentSegment = (candidate: string): boolean =>
  candidate.split(/[\\/]/u).includes("..");

/** Resolving a spelling to the file it selects; injectable so a test can observe the call. */
export type RealpathResolver = (candidate: string) => string;

const nativeRealpath: RealpathResolver = (candidate) =>
  realpathSync.native(candidate);

/**
 * The file a spelling selects, falling back to the lexical path when it cannot be read.
 *
 * A network share is compared lexically and never dereferenced. The lexical form uses Windows
 * semantics even off Windows, because `resolve` would otherwise prepend the working directory to
 * a `\\server\share` spelling on a POSIX host, where that spelling is not absolute.
 *
 * One residual stays open and is stated rather than hidden: on Windows a mapped drive letter
 * reaches a share too, and a letter cannot be classified without an I/O call of its own — the
 * same call this guard is avoiding. Since `expected_server_path` is caller input, a caller can
 * still name a mapped drive. Handling it needs a volume query with its own budget, not a wider
 * pattern here.
 *
 * `realpathSync.native` matches the launcher's own traversal, which is why
 * `entrypointIdentity` prefers it.
 */
export const selectedFile = (
  candidate: string,
  readRealpath: RealpathResolver = nativeRealpath,
): string => {
  if (isNetworkSharePath(candidate)) return win32.resolve(candidate);
  // A parent segment is normalized lexically, which is what the launcher did when it selected
  // the script. Measured on Node 24.22.1: with `a/link` pointing at `b/deep` and both `a/s.mjs`
  // and `b/s.mjs` present, `node a/link/../s.mjs` runs `a/s.mjs`, while `realpath` resolves the
  // link first and reaches `b/s.mjs`.
  if (hasParentSegment(candidate)) return resolve(candidate);
  try {
    return readRealpath(candidate);
  } catch {
    return resolve(candidate);
  }
};

/**
 * Whether two entrypoint spellings select the same file.
 *
 * A launcher records the canonical path, while a caller passes the spelling it used to start
 * REA, which can reach the same file through a symlink or a `..` segment. Returning `true`
 * means "not provably different", because the only consumer turns `false` into
 * `registration_path_mismatch` and an undecidable shape must not claim one.
 */
export const sameEntrypointSpelling = (
  left: string,
  right: string,
  runtime: JavaScriptRuntime["id"] = javaScriptRuntime(process.versions).id,
  readRealpath: RealpathResolver = nativeRealpath,
): boolean => {
  // `left` and `right` being equal does not settle it: a manager alias can be retargeted while
  // the process runs, so equality only holds if neither side selects something else. Both are
  // resolved below, which is the same cost as the unequal case.
  if (traversalSemanticsDiffer(left, runtime)) return true;
  if (traversalSemanticsDiffer(right, runtime)) return true;
  return selectedFile(left, readRealpath) === selectedFile(right, readRealpath);
};
