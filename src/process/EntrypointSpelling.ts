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
  // Windows only. On POSIX `//tmp/release/rea.mjs` is a local absolute path that the launcher
  // normalizes to `/tmp/release/rea.mjs`, so treating it as a share would report a mismatch for
  // the process's own launch spelling.
  process.platform === "win32" && /^[\x5C\x2F]{2}[^\x5C\x2F]/u.test(candidate);

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
  candidate.split(hostSeparator).includes("..");

/**
 * The separator this host uses.
 *
 * Backslash is a legal filename character on POSIX, so splitting on it invents components that
 * do not exist: `/tmp/release\../foreign.mjs` has no parent segment there.
 */
const hostSeparator = process.platform === "win32" ? /[\\/]/u : /\//u;

/** Whether a spelling carries a parent segment. */
const hasParentSegment = (candidate: string): boolean =>
  candidate.split(hostSeparator).includes("..");

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
  // A parent segment is normalized lexically *first*, then the result is resolved — that is the
  // composition the launcher performs. Measured on Node 24.22.1: with `a/link` pointing at
  // `b/deep` and both `a/s.mjs` and `b/s.mjs` present, `node a/link/../s.mjs` runs `a/s.mjs`
  // (lexical, not `b/s.mjs`), and when `release` is itself a symlink the normalized path still
  // follows that link.
  const normalized = hasParentSegment(candidate)
    ? resolve(candidate)
    : candidate;
  try {
    return readRealpath(normalized);
  } catch {
    return resolve(normalized);
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
export type EntrypointSpellingVerdict = "same" | "different" | "unknown";

/**
 * What two entrypoint spellings prove about each other.
 *
 * The three states exist because the callers need them apart. A boolean collapses `unknown` into
 * `same`, and the consumer turns `same` into `aligned` — so an undecidable shape would claim an
 * alignment it cannot support and suppress a restart that is actually required.
 */
export const entrypointSpellingVerdict = (
  left: string,
  right: string,
  runtime: JavaScriptRuntime["id"] = javaScriptRuntime(process.versions).id,
  readRealpath: RealpathResolver = nativeRealpath,
): EntrypointSpellingVerdict => {
  // `left` and `right` being equal does not settle it: a manager alias can be retargeted while
  // the process runs, so equality only holds if neither side selects something else.
  if (traversalSemanticsDiffer(left, runtime)) return "unknown";
  if (traversalSemanticsDiffer(right, runtime)) return "unknown";
  return selectedFile(left, readRealpath) === selectedFile(right, readRealpath)
    ? "same"
    : "different";
};

/** Whether two entrypoint spellings are not provably different. */
export const sameEntrypointSpelling = (
  left: string,
  right: string,
  runtime: JavaScriptRuntime["id"] = javaScriptRuntime(process.versions).id,
  readRealpath: RealpathResolver = nativeRealpath,
): boolean =>
  entrypointSpellingVerdict(left, right, runtime, readRealpath) !== "different";
