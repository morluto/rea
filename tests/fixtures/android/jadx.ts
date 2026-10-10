import { access, chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, onTestFinished } from "vitest";
import { AndroidAnalysisService } from "../../../src/application/android/AndroidAnalysisService.js";
import { createAndroidAnalysisProvider } from "../../../src/composition/android.js";
import { ProviderCleanupError } from "../../../src/domain/providerCleanupError.js";
import {
  ProviderProcessSupervisor,
  spawnOwnedProviderProcess,
} from "../../../src/process/ProviderProcess.js";
import { cleanupOwnedProcessGroup } from "../../../src/process/ProcessOwnership.js";
import { writeOrderedZip } from "../artifactEntryOrder.js";
import { createTestTempDirectory } from "../temporaryDirectory.js";
import { writeJadxJarInventory } from "./jadxJar.js";

const fixture = fileURLToPath(new URL("./jadx-mcp.mjs", import.meta.url));

/** Real owned subprocess running a synthetic MCP producer, with no module mocks. */
export const createJadxProtocolFixture = async (
  mode = "normal",
  cleanupFailure?: () => boolean,
) => {
  const root = await createTestTempDirectory("rea-android-boundary-");
  const apk = join(root, "fixture.apk");
  const jar = join(root, "fixture.jar");
  const javaHome = join(root, "jdk");
  const javaBin = join(javaHome, "bin");
  const java = join(javaBin, "java");
  await mkdir(javaBin, { recursive: true });
  await writeFile(
    java,
    `#!/usr/bin/env node\nif (process.argv[2] === "--list-modules") console.log("java.base@21.0.0\\njdk.compiler@21.0.0");\n`,
  );
  await chmod(java, 0o755);
  await writeOrderedZip(apk, ["AndroidManifest.xml", "classes.dex"]);
  await writeJadxJarInventory(jar);
  const launches: {
    runId: string;
    cwd: string | undefined;
    pid: number | undefined;
    arguments: readonly string[] | undefined;
    javaToolOptions: string | undefined;
    legacyJavaOptions: string | undefined;
  }[] = [];
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    JAVA_HOME: javaHome,
    REA_JADX_MCP_JAR: jar,
  };
  const provider = createAndroidAnalysisProvider(
    environment,
    async (options) => {
      const spawned = await spawnOwnedProviderProcess({
        ...options,
        command: process.execPath,
        arguments: [fixture],
        expectedCommand: process.execPath,
        env: { ...options.env, REA_FAKE_JADX_MODE: mode },
      });
      launches.push({
        runId: options.runId,
        cwd: options.cwd,
        pid: spawned.process.pid,
        arguments: options.arguments,
        javaToolOptions: options.hostEnvironment?.JAVA_TOOL_OPTIONS,
        legacyJavaOptions:
          options.env?._JAVA_OPTIONS ?? options.hostEnvironment?._JAVA_OPTIONS,
      });
      if (mode === "cleanup-failure" || cleanupFailure !== undefined) {
        onTestFinished(async () => {
          const supervisor = new ProviderProcessSupervisor({
            ...spawned,
            ownsProcessLifetime: true,
            cleanup: () => cleanupOwnedProcessGroup(spawned.ownership),
          });
          const stopped = await supervisor.stop();
          expect(stopped, JSON.stringify(stopped)).not.toMatchObject({
            status: "incomplete",
          });
          if (options.cwd !== undefined)
            await rm(options.cwd, { recursive: true, force: true });
        });
        return {
          ...spawned,
          cleanup: async () =>
            (cleanupFailure?.() ?? true)
              ? {
                  cleaned: false,
                  reason: "injected ownership verification failure",
                }
              : cleanupOwnedProcessGroup(spawned.ownership),
        };
      }
      return spawned;
    },
  );
  onTestFinished(async () => {
    try {
      await provider.close();
    } catch (cause) {
      if (
        mode !== "cleanup-failure" ||
        !(cause instanceof ProviderCleanupError) ||
        cause.providerId !== "jadx"
      )
        throw cause;
    }
  });
  return {
    service: new AndroidAnalysisService(provider),
    provider,
    apk,
    jar,
    environment,
    launches,
  };
};

/** Verify only this fixture's acquired group and workspace, without scanning unrelated host environments. */
export const verifyJadxFixtureCleanup = async (
  launches: Awaited<ReturnType<typeof createJadxProtocolFixture>>["launches"],
): Promise<void> => {
  for (const launch of launches) {
    const pid = launch.pid;
    if (pid !== undefined)
      expect(() => process.kill(-pid, 0)).toThrowError(
        expect.objectContaining({ code: "ESRCH" }),
      );
    if (launch.cwd !== undefined)
      await expect(access(launch.cwd)).rejects.toMatchObject({
        code: "ENOENT",
      });
  }
};
