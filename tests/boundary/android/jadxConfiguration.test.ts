import { chmod, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it as test } from "vitest";

import {
  inspectJadxAvailability,
  resolveJadxConfiguration,
} from "../../../src/android/JadxConfiguration.js";
import { AnalysisCapabilityUnavailableError } from "../../../src/domain/analysisErrorCore.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { writeOrderedZip } from "../../fixtures/artifactEntryOrder.js";
import { writeJadxJarInventory } from "../../fixtures/android/jadxJar.js";

const it = test.skipIf(process.platform === "win32");

it("rejects malformed or unrelated engine archives with JAR-specific recovery", async () => {
  const root = await createTestTempDirectory("rea-jadx-invalid-jar-");
  const javaHome = await createFakeJdk(root);
  const jar = join(root, "engine.jar");
  for (const malformed of [true, false]) {
    if (malformed) await writeFile(jar, "not a Java archive");
    else await writeOrderedZip(jar, ["unrelated/Library.class"]);
    const environment = { REA_JADX_MCP_JAR: jar, JAVA_HOME: javaHome };
    const availability = await inspectJadxAvailability(environment);
    expect(availability).toMatchObject({
      status: "unavailable",
      reason: expect.stringContaining("REA_JADX_MCP_JAR"),
      diagnostics: { jar_path: await realpath(jar), phase: "jar-inspection" },
    });
    await expect(
      resolveJadxConfiguration(environment, "inspect_android_package"),
    ).rejects.toMatchObject({
      _tag: "AnalysisCapabilityUnavailableError",
      reason: expect.stringContaining("REA_JADX_MCP_JAR"),
    });
    expect(availability.reason).not.toContain("Select a full JDK");
  }
});

it("rejects an explicit JAVA_HOME without an executable java binary", async () => {
  const root = await createTestTempDirectory("rea-jadx-config-");
  const jar = join(root, "jadx-headless-mcp.jar");
  const javaHome = join(root, "missing-jdk");
  await writeJadxJarInventory(jar);

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

it("accepts a full JDK and canonicalizes the selected JAR", async () => {
  const root = await createTestTempDirectory("rea-jadx-config-");
  const jar = join(root, "jadx-headless-mcp.jar");
  const javaHome = await createFakeJdk(root);
  await writeJadxJarInventory(jar);

  await expect(
    resolveJadxConfiguration(
      { REA_JADX_MCP_JAR: jar, JAVA_HOME: javaHome },
      "inspect_android_package",
    ),
  ).resolves.toEqual({
    jar: await realpath(jar),
    java: join(javaHome, "bin", "java"),
    jvmArguments: [],
  });
});

it("configures heap and visible processors independently without forcing either", async () => {
  const root = await createTestTempDirectory("rea-jadx-config-");
  const jar = join(root, "engine.jar");
  const javaHome = await createFakeJdk(root);
  await writeJadxJarInventory(jar);
  const configuration = await resolveJadxConfiguration(
    {
      REA_JADX_MCP_JAR: jar,
      JAVA_HOME: javaHome,
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
      {
        REA_JADX_MCP_JAR: jar,
        JAVA_HOME: javaHome,
        REA_JADX_ACTIVE_PROCESSOR_COUNT: "2147483648",
      },
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
          {
            REA_JADX_MCP_JAR: jar,
            JAVA_HOME: javaHome,
            [name]: value,
          },
          "inspect_android_package",
        ),
      ).rejects.toMatchObject({
        _tag: "AnalysisCapabilityUnavailableError",
        reason: expect.stringContaining(name),
      });
});

it("distinguishes a runnable JRE from a missing Java executable", async () => {
  const root = await createTestTempDirectory("rea-jadx-runtime-");
  const jar = join(root, "jadx-headless-mcp.jar");
  await writeJadxJarInventory(jar);
  const jreHome = await createFakeJdk(root, false);
  await expect(
    resolveJadxConfiguration(
      { REA_JADX_MCP_JAR: jar, JAVA_HOME: jreHome },
      "inspect_android_package",
    ),
  ).rejects.toMatchObject({
    _tag: "AnalysisCapabilityUnavailableError",
    reason: expect.stringContaining("does not provide jdk.compiler"),
    userMessage: expect.stringContaining("A JRE cannot compile"),
    capturedOutput: {
      stdout: "java.base@21\n",
      stderr: "",
      truncated: false,
    },
  });

  const emptyPath = join(root, "empty-path");
  await mkdir(emptyPath);
  const availability = await inspectJadxAvailability({
    REA_JADX_MCP_JAR: jar,
    PATH: emptyPath,
  });
  expect(availability).toMatchObject({
    status: "unavailable",
    code: "runtime_missing",
    reason: expect.stringContaining("spawn java ENOENT"),
    diagnostics: {
      java_executable: "java",
      phase: "module-inspection",
      exit_code: null,
      process_error_code: "ENOENT",
    },
  });
});

it("preserves exact Java probe output and marks max-buffer capture as truncated", async () => {
  const root = await createTestTempDirectory("rea-jadx-output-");
  const jar = join(root, "jadx-headless-mcp.jar");
  const javaHome = join(root, "fake-jdk");
  const bin = join(javaHome, "bin");
  const java = join(bin, "java");
  await mkdir(bin, { recursive: true });
  await writeJadxJarInventory(jar);
  await writeFile(
    java,
    `#!/bin/sh\nexec ${process.execPath} -e 'process.stdout.write("x".repeat(2 * 1024 * 1024))'\n`,
  );
  await chmod(java, 0o700);

  const failure = await resolveJadxConfiguration(
    { REA_JADX_MCP_JAR: jar, JAVA_HOME: javaHome },
    "inspect_android_package",
  ).then(
    () => undefined,
    (cause: unknown) => cause,
  );
  expect(failure).toBeInstanceOf(AnalysisCapabilityUnavailableError);
  if (!(failure instanceof AnalysisCapabilityUnavailableError)) return;
  expect(failure.reason).toContain("exceeded the 1 MiB output budget");
  expect(failure.reason).not.toContain("Select a full JDK");
  expect(failure.capturedOutput).toMatchObject({
    stdout: expect.stringMatching(/^x/u),
    stderr: "",
    truncated: true,
  });
  expect(failure.capturedOutput?.stdout.length).toBeLessThan(2 * 1024 * 1024);
  await expect(
    inspectJadxAvailability({
      REA_JADX_MCP_JAR: jar,
      JAVA_HOME: javaHome,
    }),
  ).resolves.toMatchObject({
    status: "unavailable",
    code: "version_unresolved",
    diagnostics: {
      exit_code: null,
      process_error_code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      failure: "output_limit",
      output_truncated: true,
    },
  });
});

it("distinguishes an unreported Java version from an unsupported old version", async () => {
  const root = await createTestTempDirectory("rea-jadx-version-listing-");
  const jar = join(root, "jadx-headless-mcp.jar");
  await writeJadxJarInventory(jar);

  const unresolvedHome = await createFakeJdk(root);
  await writeFile(
    join(unresolvedHome, "bin", "java"),
    "#!/bin/sh\nprintf 'jdk.compiler@21\\n'\n",
  );
  await chmod(join(unresolvedHome, "bin", "java"), 0o700);
  await expect(
    inspectJadxAvailability({
      REA_JADX_MCP_JAR: jar,
      JAVA_HOME: unresolvedHome,
    }),
  ).resolves.toMatchObject({
    status: "unavailable",
    code: "version_unresolved",
    reason: expect.stringContaining(
      "did not report a parseable java.base version",
    ),
    diagnostics: { stdout: "jdk.compiler@21\n", java_major: null },
  });

  const oldHome = await createFakeJdk(root);
  await writeFile(
    join(oldHome, "bin", "java"),
    "#!/bin/sh\nprintf 'java.base@16\\njdk.compiler@16\\n'\n",
  );
  await chmod(join(oldHome, "bin", "java"), 0o700);
  await expect(
    resolveJadxConfiguration(
      { REA_JADX_MCP_JAR: jar, JAVA_HOME: oldHome },
      "inspect_android_package",
    ),
  ).rejects.toMatchObject({
    _tag: "AnalysisCapabilityUnavailableError",
    reason: expect.stringContaining("must be JDK 17 or newer"),
  });
});

it("cancels an in-flight Java readiness probe", async () => {
  const root = await createTestTempDirectory("rea-jadx-cancel-");
  const jar = join(root, "jadx-headless-mcp.jar");
  const { javaHome, marker } = await createHangingJdk(root);
  await writeJadxJarInventory(jar);
  const controller = new AbortController();
  const pending = inspectJadxAvailability(
    { REA_JADX_MCP_JAR: jar, JAVA_HOME: javaHome },
    controller.signal,
  );
  try {
    await expect
      .poll(
        () =>
          readFile(marker, "utf8").then(
            () => true,
            () => false,
          ),
        { timeout: 10_000 },
      )
      .toBe(true);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  } finally {
    controller.abort();
    await pending.catch(() => undefined);
  }
});

it("reports a killed Java probe as unresolved instead of missing runtime", async () => {
  const root = await createTestTempDirectory("rea-jadx-timeout-");
  const jar = join(root, "jadx-headless-mcp.jar");
  const { javaHome, java } = await createHangingJdk(root);
  await writeJadxJarInventory(jar);

  const availability = await inspectJadxAvailability({
    REA_JADX_MCP_JAR: jar,
    JAVA_HOME: javaHome,
  });
  expect(availability).toMatchObject({
    status: "unavailable",
    code: "version_unresolved",
    reason: expect.stringContaining("within 10 seconds"),
    diagnostics: {
      java_executable: java,
      failure: "probe_terminated",
      killed: true,
      deadline_ms: 10_000,
    },
  });
  expect(availability.reason).not.toContain("Select a full JDK");
});

const createHangingJdk = async (root: string) => {
  const javaHome = join(root, "fake-jdk");
  const bin = join(javaHome, "bin");
  const java = join(bin, "java");
  const marker = join(root, "java-probe-started");
  await mkdir(bin, { recursive: true });
  await writeFile(
    java,
    `#!/bin/sh\nexec ${process.execPath} -e 'require("node:fs").writeFileSync(process.argv[1], "ready"); setTimeout(() => {}, 30_000)' '${marker}'\n`,
  );
  await chmod(java, 0o700);
  return { javaHome, java, marker };
};

const createFakeJdk = async (
  root: string,
  compiler = true,
): Promise<string> => {
  const javaHome = join(root, compiler ? "fake-jdk" : "fake-jre");
  const bin = join(javaHome, "bin");
  const java = join(bin, "java");
  await mkdir(bin, { recursive: true });
  await writeFile(
    java,
    `#!/bin/sh\nprintf 'java.base@21${compiler ? "\\njdk.compiler@21" : ""}\\n'\n`,
  );
  await chmod(java, 0o700);
  return javaHome;
};
