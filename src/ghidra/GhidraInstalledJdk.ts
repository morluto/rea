import { constants } from "node:fs";
import { access, opendir, realpath, stat } from "node:fs/promises";
import { posix } from "node:path";
import { cancelledBy } from "../domain/analysisErrorCore.js";
import { analysisErrorWithCleanupDependencies } from "../domain/analysisErrorCleanup.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { OwnedDirectoryHandle } from "../filesystem/OwnedDirectoryHandle.js";
import { readStableFileBytes } from "../filesystem/readStableFileBytes.js";
import {
  ArtifactFileCleanupFailure,
  ArtifactResourceScope,
  bindArtifactFileCleanup,
  withArtifactRegularFile,
} from "../resources/index.js";
import { classifyProviderFailure } from "../providers/classifyProviderFailure.js";
import { ghidraFileDialect } from "./GhidraFileArtifacts.js";
import type { GhidraInstallationFileOptions } from "./GhidraInstallationProperties.js";
import {
  ghidraJavaMajorAccepted,
  type GhidraJavaRequirement,
} from "./GhidraInstallationPolicy.js";
import { ghidraJavaMajor } from "./GhidraJavaProbe.js";

const MAX_LOCATION_CANDIDATES = 128;
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
): Promise<{
  readonly candidates: readonly JdkCandidate[];
  readonly truncated: boolean;
}> => {
  if (requirement.unresolved !== null)
    return { candidates: [], truncated: false };
  const selected =
    selectedHome !== null && posix.isAbsolute(selectedHome)
      ? await realpath(selectedHome).catch(() => undefined)
      : undefined;
  const seen = new Set<string>();
  if (selected !== undefined) seen.add(selected);
  const candidates: JdkCandidate[] = [];
  let truncated = false;
  for (const location of locations) {
    const listed = await options.resourceOwner.run(() =>
      listJdkHomes(location, options),
    );
    truncated ||= listed.truncated;
    for (const home of listed.homes) {
      assertDiscoveryActive(options.signal);
      const candidate = await readJdkCandidate(
        home,
        seen,
        requirement,
        options,
      );
      if (candidate === undefined) continue;
      candidates.push(candidate);
      if (candidates.length >= MAX_SUGGESTIONS)
        return { candidates, truncated: true };
    }
  }
  return { candidates, truncated };
};

const assertDiscoveryActive = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) throw cancelledBy("ghidra:doctor", signal);
};

const listJdkHomes = async (
  { root, javaHome }: JdkLocation,
  { signal, resourceOwner }: GhidraInstallationFileOptions,
): Promise<{
  readonly homes: readonly string[];
  readonly truncated: boolean;
}> => {
  assertDiscoveryActive(signal);
  const handle = await opendir(root).catch(() => undefined);
  if (handle === undefined) return { homes: [], truncated: false };
  const directory = new OwnedDirectoryHandle(handle);
  const resources = new ArtifactResourceScope();
  const homes: string[] = [];
  let truncated = false;
  let outcome: { kind: "completed" } | { kind: "failed"; cause: unknown };
  try {
    for (;;) {
      assertDiscoveryActive(signal);
      const entry = await directory.handle.read();
      if (entry === null) break;
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const home = javaHome(entry.name);
      if (home === undefined) continue;
      if (homes.length === MAX_LOCATION_CANDIDATES) {
        truncated = true;
        break;
      }
      homes.push(home);
    }
    outcome = { kind: "completed" };
  } catch (cause: unknown) {
    outcome = { kind: "failed", cause };
  }
  const close = await resources.release({
    kind: "directory-handle",
    resource: root,
    handle: directory,
  });
  if (close.kind === "failed") {
    resourceOwner.retain(resources, root);
    throw resources.cleanupFailure(outcome, [close]);
  }
  if (outcome.kind === "failed") throw outcome.cause;
  assertDiscoveryActive(signal);
  return { homes, truncated };
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
    if (cause instanceof ArtifactFileCleanupFailure)
      throw classifyProviderFailure(cause, {
        ...ghidraFileDialect("doctor", { path: cause.fileCleanupFailure.path }),
        readCleanup: (read, primary) => {
          const cleanup = new ProviderCleanupError(
            "ghidra",
            read.cleanup.resources,
            { phase: "jdk-release-discovery" },
            {
              operation: "doctor",
              cause:
                read instanceof ArtifactFileCleanupFailure
                  ? read.fileCleanupFailure.cleanupCause
                  : read,
              cleanup: read.cleanup,
            },
          );
          bindArtifactFileCleanup(read, cleanup);
          return primary === undefined
            ? cleanup
            : analysisErrorWithCleanupDependencies(primary, cleanup, "doctor");
        },
      });
    if (options.signal?.aborted)
      throw cancelledBy("ghidra:doctor", options.signal);
    return undefined;
  }
};
