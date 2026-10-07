import { chmod, mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it as test } from "vitest";

import { resolveJadxConfiguration } from "../../../src/android/JadxConfiguration.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const it = test.skipIf(process.platform === "win32");

it("rejects an explicit JAVA_HOME without an executable java binary", async () => {
  const root = await createTestTempDirectory("rea-jadx-config-");
  const jar = join(root, "jadx-headless-mcp.jar");
  const javaHome = join(root, "missing-jdk");
  await writeFile(jar, "fixture jar");

  await expect(
    resolveJadxConfiguration(
      { REA_JADX_MCP_JAR: jar, JAVA_HOME: javaHome },
      "inspect_android_package",
    ),
  ).rejects.toMatchObject({
    _tag: "AnalysisCapabilityUnavailableError",
    reason: expect.stringContaining(join(javaHome, "bin", "java")),
  });
});

it("accepts a verified explicit java binary and canonicalizes the JAR", async () => {
  const root = await createTestTempDirectory("rea-jadx-config-");
  const jar = join(root, "jadx-headless-mcp.jar");
  const javaHome = join(root, "jdk");
  const java = join(javaHome, "bin", "java");
  await mkdir(join(javaHome, "bin"), { recursive: true });
  await writeFile(jar, "fixture jar");
  await writeFile(java, "#!/bin/sh\n");
  await chmod(java, 0o700);

  await expect(
    resolveJadxConfiguration(
      { REA_JADX_MCP_JAR: jar, JAVA_HOME: javaHome },
      "inspect_android_package",
    ),
  ).resolves.toEqual({ jar: await realpath(jar), java, jvmArguments: [] });
});

it("configures heap and visible processors independently without forcing either", async () => {
  const root = await createTestTempDirectory("rea-jadx-config-");
  const jar = join(root, "engine.jar");
  await writeFile(jar, "fixture jar");
  const configuration = await resolveJadxConfiguration(
    {
      REA_JADX_MCP_JAR: jar,
      REA_JADX_HEAP_MIB: "8192",
      REA_JADX_ACTIVE_PROCESSOR_COUNT: "4",
    },
    "inspect_android_package",
  );
  expect(configuration.jvmArguments).toEqual([
    "-Xmx8192m",
    "-XX:ActiveProcessorCount=4",
  ]);
  await expect(
    resolveJadxConfiguration(
      { REA_JADX_MCP_JAR: jar, REA_JADX_ACTIVE_PROCESSOR_COUNT: "2147483648" },
      "inspect_android_package",
    ),
  ).rejects.toMatchObject({
    _tag: "AnalysisCapabilityUnavailableError",
    reason: expect.stringContaining("32-bit"),
  });
  for (const name of ["REA_JADX_HEAP_MIB", "REA_JADX_ACTIVE_PROCESSOR_COUNT"])
    for (const value of ["", "0", "-1", "1.5", "8g", " 4", "9007199254740992"])
      await expect(
        resolveJadxConfiguration(
          { REA_JADX_MCP_JAR: jar, [name]: value },
          "inspect_android_package",
        ),
      ).rejects.toMatchObject({
        _tag: "AnalysisCapabilityUnavailableError",
        reason: expect.stringContaining(name),
      });
});
