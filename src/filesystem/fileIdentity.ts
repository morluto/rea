import { lstatSync, realpathSync, statSync } from "node:fs";

import {
  javaScriptRuntime,
  type JavaScriptRuntime,
} from "../domain/runtimeVersion.js";

export type FileIdentityComparison = "same" | "different" | "unknown";

export interface FileStatIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

export interface FileIdentityHost {
  readonly platform?: NodeJS.Platform;
  readonly runtime?: JavaScriptRuntime["id"];
  readonly stat?: (path: string) => FileStatIdentity;
  readonly lstatIsSymbolicLink?: (path: string) => boolean;
  readonly realpath?: (path: string) => string;
}

export interface ResolvedFileIdentityHost {
  readonly platform: NodeJS.Platform;
  readonly runtime: JavaScriptRuntime["id"];
  readonly stat: (path: string) => FileStatIdentity;
  readonly lstatIsSymbolicLink: (path: string) => boolean;
  readonly realpath: (path: string) => string;
}

export interface FileIdentitySnapshot {
  readonly path: string;
  readonly stats: FileStatIdentity | undefined;
  readonly statError: string | undefined;
  readonly realpath: string | undefined;
  readonly isSymbolicLink: boolean;
}

export const resolveFileIdentityHost = (
  host: FileIdentityHost | undefined,
): ResolvedFileIdentityHost => ({
  platform: host?.platform ?? process.platform,
  runtime: host?.runtime ?? javaScriptRuntime(process.versions).id,
  stat: host?.stat ?? ((path) => statSync(path, { bigint: true })),
  lstatIsSymbolicLink:
    host?.lstatIsSymbolicLink ?? ((path) => lstatSync(path).isSymbolicLink()),
  realpath: host?.realpath ?? realpathSync.native,
});

const errorCode = (cause: unknown): string | undefined =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  typeof cause.code === "string"
    ? cause.code
    : undefined;

export const hasParentPathSegment = (path: string): boolean =>
  path.split("/").includes("..");

export const isMissingFileError = (code: string | undefined): boolean =>
  code === undefined || code === "ENOENT" || code === "ENOTDIR";

const isBunPosixTraversal = (
  path: string,
  host: Pick<ResolvedFileIdentityHost, "platform" | "runtime">,
): boolean =>
  host.platform !== "win32" &&
  host.runtime === "bun" &&
  hasParentPathSegment(path);

/** Inspect one path's filesystem identity once so callers share stat, realpath, and symlink facts. */
export const inspectFileIdentity = (
  path: string,
  host?: FileIdentityHost,
): FileIdentitySnapshot => {
  const resolved = resolveFileIdentityHost(host);
  let stats: FileStatIdentity | undefined;
  let statError: string | undefined;
  try {
    stats = resolved.stat(path);
  } catch (cause: unknown) {
    statError = errorCode(cause) ?? "unknown";
  }
  let realpath: string | undefined;
  try {
    realpath = resolved.realpath(path);
  } catch {
    // Missing or unreadable targets leave realpath undefined for boundary policy.
  }
  let isSymbolicLink = false;
  try {
    isSymbolicLink = resolved.lstatIsSymbolicLink(path);
  } catch {
    // Missing or unreadable lstat targets are treated as non-symlinks.
  }
  return { path, stats, statError, realpath, isSymbolicLink };
};

export const hasExistingFileIdentity = (
  snapshot: FileIdentitySnapshot,
  host?: FileIdentityHost,
): boolean => {
  if (snapshot.stats === undefined) return false;
  if (snapshot.stats.ino !== 0n) return true;
  const resolved = resolveFileIdentityHost(host);
  return (
    !isBunPosixTraversal(snapshot.path, resolved) &&
    snapshot.realpath !== undefined
  );
};

/**
 * Compare two existing files using exact bigint dev/ino first and native realpath
 * when safe. Returns undefined when either side failed to stat.
 */
export const compareExistingFileIdentities = (
  left: FileIdentitySnapshot,
  right: FileIdentitySnapshot,
  host?: FileIdentityHost,
): FileIdentityComparison | undefined => {
  if (left.stats === undefined || right.stats === undefined) return undefined;
  const bothHaveInode = left.stats.ino !== 0n && right.stats.ino !== 0n;
  if (bothHaveInode) {
    return left.stats.dev === right.stats.dev &&
      left.stats.ino === right.stats.ino
      ? "same"
      : "different";
  }
  const resolved = resolveFileIdentityHost(host);
  if (
    isBunPosixTraversal(left.path, resolved) ||
    isBunPosixTraversal(right.path, resolved)
  )
    return "unknown";
  if (left.realpath !== undefined && right.realpath !== undefined)
    return left.realpath === right.realpath ? "same" : "different";
  return "unknown";
};
