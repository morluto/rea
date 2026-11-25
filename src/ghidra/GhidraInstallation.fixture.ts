import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { HOST_PLATFORM } from "../platform/HostPlatform.js";
import { tmpdir } from "node:os";
import { join, parse, relative } from "node:path";
import { onTestFinished } from "vitest";
import { normalizeTestTemporaryPrefix } from "../../scripts/lib/test-temporary-ownership.mjs";
import { removeTestWorkspace } from "../../tests/support/workspace/workspaceFixture.js";
import { ok as javaProbeOk, err } from "../domain/result.js";
import type {
  GhidraJavaObservation,
  GhidraJavaProbeFailure,
} from "./GhidraJavaProbe.js";
import type { GhidraInstallationHost } from "./GhidraInstallation.js";
import {
  SUPPORTED_GHIDRA_JAVA_MAJOR,
  SUPPORTED_GHIDRA_VERSION,
} from "./GhidraReleasePolicy.js";

/** Properties text for an install at the verified release and its declared JDK floor. */
export const verifiedGhidraApplicationProperties = `application.version=${SUPPORTED_GHIDRA_VERSION}\napplication.java.min=${String(SUPPORTED_GHIDRA_JAVA_MAJOR)}\n`;

/** JDK observation that satisfies the verified install's declared minimum. */
export const verifiedGhidraJavaObservation = (
  home = "/jdk-25",
): GhidraJavaObservation => ({
  version: `${String(SUPPORTED_GHIDRA_JAVA_MAJOR)}.0.1`,
  major: SUPPORTED_GHIDRA_JAVA_MAJOR,
  home,
  bits: 64,
  runtime: "jdk",
  osArch: "amd64",
  osName: "Linux",
});

/** Simulated valid installation for profile tests; never starts Ghidra or Java. */
export const ghidraProfileInstallationHost: GhidraInstallationHost = {
  platform: "linux",
  architecture: "x64",
  readText: () => verifiedGhidraApplicationProperties,
  executable: () => true,
  probeJava: () => javaProbeOk(verifiedGhidraJavaObservation()),
};

/**
 * A temporary installation directory the simulated Linux host accepts as
 * absolute. On Windows it is made under the working directory and spelled as a
 * POSIX path on that drive; other hosts get an ordinary test directory. The
 * caller owns and disposes the native directory.
 */
export const createSimulatedInstallDirectory = async (
  prefix: string,
): Promise<{
  readonly path: string;
  readonly dispose: () => Promise<void>;
}> => {
  const root =
    HOST_PLATFORM.platform === "win32"
      ? join(process.cwd(), "build")
      : await realpath(tmpdir());
  await mkdir(root, { recursive: true });
  const owned = await realpath(
    await mkdtemp(join(root, normalizeTestTemporaryPrefix(prefix))),
  );
  return {
    path:
      HOST_PLATFORM.platform === "win32"
        ? `/${relative(parse(owned).root, owned).replaceAll("\\", "/")}`
        : owned,
    dispose: () => removeTestWorkspace(owned),
  };
};

/** Own the simulated directory for a single test. */
export const simulatedInstallDirectory = async (
  prefix: string,
): Promise<string> => {
  const directory = await createSimulatedInstallDirectory(prefix);
  onTestFinished(directory.dispose);
  return directory.path;
};

/** A confirmed absent Java command for installation admission fixtures. */
export const missingJavaProbe = err<GhidraJavaProbeFailure>({
  _tag: "GhidraJavaProbeFailure",
  code: "runtime_missing",
  detail: "Java command was not found",
});

/** Simulated host with no Ghidra installation or Java runtime. */
export const unavailableGhidraInstallationHost: GhidraInstallationHost = {
  platform: "linux",
  architecture: "x64",
  readText: () => undefined,
  executable: () => false,
  probeJava: () => missingJavaProbe,
};
