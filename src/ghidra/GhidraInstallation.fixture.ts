import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, parse, relative } from "node:path";
import { onTestFinished } from "vitest";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
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
 * test removes it when it finishes.
 */
export const simulatedInstallDirectory = async (
  prefix: string,
): Promise<string> => {
  if (process.platform !== "win32") return createTestTempDirectory(prefix);
  const root = join(process.cwd(), "build");
  await mkdir(root, { recursive: true });
  const owned = await mkdtemp(join(root, prefix));
  onTestFinished(async () => {
    await rm(owned, { recursive: true, force: true });
  });
  return `/${relative(parse(owned).root, owned).replaceAll("\\", "/")}`;
};

/** A confirmed absent Java command for installation admission fixtures. */
export const missingJavaProbe = err<GhidraJavaProbeFailure>({
  _tag: "GhidraJavaProbeFailure",
  code: "runtime_missing",
  detail: "Java command was not found",
});
