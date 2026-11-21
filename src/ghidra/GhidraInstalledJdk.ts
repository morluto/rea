import { constants } from "node:fs";
import { access, opendir, realpath, stat } from "node:fs/promises";
import { posix } from "node:path";
import { cancelledBy } from "../domain/analysisErrorCore.js";
import { readStableFileBytes } from "../filesystem/readStableFileBytes.js";
import {
  ArtifactFileCleanupFailure,
  withArtifactRegularFile,
} from "../resources/index.js";
import type { GhidraInstallationFileOptions } from "./GhidraInstallationProperties.js";
import {
  ghidraJavaMajorAccepted,
  type GhidraJavaRequirement,
} from "./GhidraInstallationPolicy.js";
import { ghidraJavaMajor } from "./GhidraJavaProbe.js";

const MAX_DIRECTORY_ENTRIES = 128;
const MAX_RELEASE_BYTES = 64 * 1024;
const MAX_SUGGESTIONS = 5;

export const ghidraHomebrewPrefixes = (architecture: NodeJS.Architecture) =>
  architecture === "arm64"
    ? ["/opt/homebrew", "/usr/local"]
    : ["/usr/local", "/opt/homebrew"];

export const ghidraHomebrewJavaHome = (opt: string, formula: string): string =>
  posix.join(opt, formula, "libexec/openjdk.jdk/Contents/Home");

interface JdkLocation {
  readonly root: string;
  readonly javaHome: (entry: string) => string | undefined;
}

export const ghidraJdkLocations = (
  platform: NodeJS.Platform,
  architecture: NodeJS.Architecture,
  home: string | undefined,
): readonly JdkLocation[] => {
  if (platform === "linux")
    return [
      {
        root: "/usr/lib/jvm",
        javaHome: (entry) => posix.join("/usr/lib/jvm", entry),
      },
    ];
  if (platform !== "darwin") return [];
  const libraries = ["/Library/Java/JavaVirtualMachines"];
  if (home !== undefined && posix.isAbsolute(home))
    libraries.push(posix.join(home, "Library/Java/JavaVirtualMachines"));
  return [
    ...libraries.map((root) => ({
      root,
      javaHome: (entry: string) =>
        entry.endsWith(".jdk")
          ? posix.join(root, entry, "Contents/Home")
          : undefined,
    })),
    ...ghidraHomebrewPrefixes(architecture).map((prefix) => {
      const root = posix.join(prefix, "opt");
      return {
        root,
        javaHome: (entry: string) =>
          /^openjdk(?:@[1-9][0-9]*)?$/u.test(entry)
            ? ghidraHomebrewJavaHome(root, entry)
            : undefined,
      };
    }),
  ];
};

/** Doctor hints based on installed files. Candidate JVMs are never started. */
export const findGhidraInstalledJdks = async (
  locations: readonly JdkLocation[],
  requirement: GhidraJavaRequirement,
  selectedHome: string | null,
  options: GhidraInstallationFileOptions,
): Promise<readonly { readonly home: string; readonly version: string }[]> => {
  if (requirement.unresolved !== null) return [];
  const selected =
    selectedHome !== null && posix.isAbsolute(selectedHome)
      ? await realpath(selectedHome).catch(() => undefined)
      : undefined;
  const seen = new Set<string>();
  if (selected !== undefined) seen.add(selected);
  const candidates: JdkCandidate[] = [];
  for (const { root, javaHome } of locations) {
    if (options.signal?.aborted)
      throw cancelledBy("ghidra:doctor", options.signal);
    const directory = await opendir(root).catch(() => undefined);
    if (directory === undefined) continue;
    let entries = 0;
    for await (const entry of directory) {
      if (options.signal?.aborted)
        throw cancelledBy("ghidra:doctor", options.signal);
      if (++entries > MAX_DIRECTORY_ENTRIES) break;
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const home = javaHome(entry.name);
      if (home === undefined) continue;
      const candidate = await readJdkCandidate(
        home,
        seen,
        requirement,
        options,
      );
      if (candidate === undefined) continue;
      candidates.push(candidate);
      if (candidates.length >= MAX_SUGGESTIONS) return candidates;
    }
  }
  return candidates;
};

interface JdkCandidate {
  readonly home: string;
  readonly version: string;
}

const readJdkCandidate = async (
  home: string,
  seen: Set<string>,
  requirement: GhidraJavaRequirement,
  options: GhidraInstallationFileOptions,
): Promise<JdkCandidate | undefined> => {
  const resolved = await realpath(home).catch(() => undefined);
  if (resolved === undefined || seen.has(resolved)) return undefined;
  seen.add(resolved);
  const version = await jdkVersion(home, options);
  if (version === undefined) return undefined;
  const major = ghidraJavaMajor(version);
  return major !== undefined && ghidraJavaMajorAccepted(major, requirement)
    ? { home, version }
    : undefined;
};

const jdkVersion = async (
  home: string,
  options: GhidraInstallationFileOptions,
): Promise<string | undefined> => {
  try {
    for (const name of ["java", "javac"]) {
      const path = posix.join(home, "bin", name);
      await access(path, constants.X_OK);
      if (!(await stat(path)).isFile()) return undefined;
    }
    const path = posix.join(home, "release");
    const text = await options.resourceOwner.run(() =>
      withArtifactRegularFile(
        path,
        {
          retain: (resource) =>
            options.resourceOwner.retain(
              { close: () => resource.lease.release() },
              resource.resource,
            ),
        },
        options.signal,
        async ({ handle }) =>
          (
            await readStableFileBytes(handle, path, MAX_RELEASE_BYTES, {
              symlinks: "follow",
              ...(options.signal === undefined
                ? {}
                : { signal: options.signal }),
            })
          ).toString("utf8"),
        "follow",
      ),
    );
    const versions = [...text.matchAll(/^JAVA_VERSION="([^"\r\n]+)"\r?$/gmu)];
    return versions.length === 1 ? versions[0]?.[1] : undefined;
  } catch (cause: unknown) {
    if (cause instanceof ArtifactFileCleanupFailure) throw cause;
    if (options.signal?.aborted)
      throw cancelledBy("ghidra:doctor", options.signal);
    return undefined;
  }
};
