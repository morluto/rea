import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse, relative } from "node:path";
import { onTestFinished } from "vitest";
import { normalizeTestTemporaryPrefix } from "../../scripts/lib/test-temporary-ownership.mjs";
import { removeTestWorkspace } from "../../tests/support/workspace/workspaceFixture.js";
import { ok as javaProbeOk } from "../domain/result.js";
import type { GhidraJavaObservation } from "./GhidraJavaProbe.js";
import { err } from "../domain/result.js";
import type { GhidraJavaProbeFailure } from "./GhidraJavaProbe.js";
import type { GhidraInstallationHost } from "./GhidraInstallation.js";

/** Simulated valid installation for profile tests; never starts Ghidra or Java. */
export const ghidraProfileInstallationHost: GhidraInstallationHost = {
  platform: "linux",
  architecture: "x64",
  readText: () => "application.version=12.1.4\napplication.java.min=21\n",
  executable: () => true,
  probeJava: () =>
    javaProbeOk<GhidraJavaObservation>({
      version: "21.0.11",
      major: 21,
      home: "/jdk-21",
      bits: 64,
      runtime: "jdk",
      osArch: "amd64",
      osName: "Linux",
    }),
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
    process.platform === "win32"
      ? join(process.cwd(), "build")
      : await realpath(tmpdir());
  await mkdir(root, { recursive: true });
  const owned = await realpath(
    await mkdtemp(join(root, normalizeTestTemporaryPrefix(prefix))),
  );
  return {
    path:
      process.platform === "win32"
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
