import { realpathSync } from "node:fs";
import { resolve } from "node:path";

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

/** Resolving a spelling to the file it selects; injectable so a test can observe the call. */
export type RealpathResolver = (candidate: string) => string;

const nativeRealpath: RealpathResolver = (candidate) =>
  realpathSync.native(candidate);

/**
 * The file a spelling selects, falling back to the lexical path when it cannot be read.
 *
 * A network share is never dereferenced: reading one starts SMB traffic and can block on
 * ambient Windows authentication. `realpathSync.native` matches the launcher's own traversal
 * for everything else, which is the reason `entrypointIdentity` prefers it.
 */
export const selectedFile = (
  candidate: string,
  readRealpath: RealpathResolver = nativeRealpath,
): string => {
  if (isNetworkSharePath(candidate)) return resolve(candidate);
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
  if (left === right) return true;
  if (traversalSemanticsDiffer(left, runtime)) return true;
  if (traversalSemanticsDiffer(right, runtime)) return true;
  return selectedFile(left, readRealpath) === selectedFile(right, readRealpath);
};
