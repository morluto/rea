import { access, chmod, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createTestTempDirectory } from "./fixtures/temporaryDirectory.js";

import {
  ghidraHeadlessArguments,
  ghidraHeadlessCommand,
  GhidraHeadlessLauncher,
} from "../src/ghidra/GhidraLauncher.js";

const fixturePath = fileURLToPath(
  new URL(
    process.platform === "win32"
      ? "./fixtures/captureGhidraLaunch.cmd"
      : "./fixtures/captureGhidraLaunch.mjs",
    import.meta.url,
  ),
);
const roots: string[] = [];

beforeAll(async () => {
  if (process.platform !== "win32") await chmod(fixturePath, 0o755);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Ghidra headless launcher", () => {
  it("builds a bounded read-only import in deterministic order", () => {
    expect(
      ghidraHeadlessArguments({
        projectRoot: "/tmp/project",
        targetPath: "/tmp/target",
        bridgeScriptPath: "/package/bridge/ReaGhidraBridge.java",
        descriptorPath: "/tmp/session.json",
        ghidraLogPath: "/tmp/ghidra.log",
        scriptLogPath: "/tmp/script.log",
      }),
    ).toEqual([
      "/tmp/project",
      "rea-project",
      "-import",
      "/tmp/target",
      "-readOnly",
      "-deleteProject",
      "-analysisTimeoutPerFile",
      "300",
      "-max-cpu",
      "2",
      "-log",
      "/tmp/ghidra.log",
      "-scriptlog",
      "/tmp/script.log",
      "-scriptPath",
      "/package/bridge",
      "-postScript",
      "ReaGhidraBridge.java",
      "/tmp/session.json",
    ]);
  });

  it("wraps the Windows batch launcher without enabling a Node shell", () => {
    const command = ghidraHeadlessCommand({
      platform: "win32",
      analyzeHeadlessPath:
        "C:\\Program Files\\Ghidra 12.1.2\\support\\analyzeHeadless.bat",
      arguments: [
        "C:\\REA Runtime\\project",
        "rea-project",
        "-import",
        "C:\\REA Runtime\\target.exe",
      ],
      comSpec: "C:\\Windows\\System32\\cmd.exe",
    });

    expect(command).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      arguments: [
        "/d",
        "/e:on",
        "/v:off",
        "/s",
        "/c",
        '""C:\\Program Files\\Ghidra 12.1.2\\support\\analyzeHeadless.bat" "C:\\REA Runtime\\project" "rea-project" "-import" "C:\\REA Runtime\\target.exe""',
      ],
    });
  });

  it.each([
    "C:\\targets\\%TEMP%\\fixture.exe",
    "C:\\targets\\fixture & calc.exe",
    'C:\\targets\\fixture".exe',
  ])("rejects a Windows command-interpreter path: %s", (targetPath) => {
    expect(() =>
      ghidraHeadlessCommand({
        platform: "win32",
        analyzeHeadlessPath: "C:\\Ghidra\\support\\analyzeHeadless.bat",
        arguments: ["-import", targetPath],
        comSpec: "C:\\Windows\\System32\\cmd.exe",
      }),
    ).toThrow(/metacharacters/u);
  });

  it("keeps authority in a private descriptor and isolates Ghidra state", async () => {
    vi.stubEnv("GHIDRA_JAVA_OPTIONS", "-javaagent:/unapproved/agent.jar");
    vi.stubEnv("JAVA_TOOL_OPTIONS", "-Duser.home=/unapproved/home");
    vi.stubEnv("JDK_JAVA_OPTIONS", "-XX:MaxRAMPercentage=99");
    vi.stubEnv("_JAVA_OPTIONS", "-Xmx99G");
    const runtimeRoot = await createTestTempDirectory("rea-launcher-test-");
    roots.push(runtimeRoot);
    const token = "secret-token-that-must-not-leak";
    const javaHome =
      process.platform === "win32" ? "C:\\Java\\jdk-21" : "/opt/jdk-21";
    const launcher = new GhidraHeadlessLauncher({
      analyzeHeadlessPath: fixturePath,
      javaHome,
      bridgeScriptPath: "/package/bridge/ReaGhidraBridge.java",
    });
    const launched = await launcher.launch({
      runtimeRoot,
      transport: "unix-socket",
      endpointPath: join(runtimeRoot, "bridge.sock"),
      token,
      runId: "d6fcbb66-e829-4ff6-a535-0035aec63139",
      targetPath: "/tmp/fixture",
      targetSha256: "b".repeat(64),
      providerVersion: "12.1.2",
      profileDigest: "a".repeat(64),
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;
    const capturePath = join(runtimeRoot, "launch-capture.json");
    await waitFor(capturePath);
    const capture = JSON.parse(await readFile(capturePath, "utf8"));
    const encodedArguments = JSON.stringify(capture.arguments);
    const encodedEnvironment = JSON.stringify(capture.environment);
    expect(encodedArguments).not.toContain(token);
    expect(encodedEnvironment).not.toContain(token);
    expect(capture).toMatchObject({
      ...(process.platform === "win32" ? {} : { descriptor_mode: 0o600 }),
      descriptor_has_token: true,
      environment: {
        HOME: join(runtimeRoot, "home"),
        ...(process.platform === "win32"
          ? {
              USERPROFILE: join(runtimeRoot, "home"),
              TEMP: join(runtimeRoot, "tmp"),
              TMP: join(runtimeRoot, "tmp"),
            }
          : {}),
        TMPDIR: join(runtimeRoot, "tmp"),
        XDG_CACHE_HOME: join(runtimeRoot, "cache"),
        XDG_CONFIG_HOME: join(runtimeRoot, "config"),
        XDG_DATA_HOME: join(runtimeRoot, "data"),
        GHIDRA_HEADLESS_MAXMEM: "2G",
        GHIDRA_JAVA_OPTIONS: "",
        JAVA_TOOL_OPTIONS: "",
        JDK_JAVA_OPTIONS: "",
        _JAVA_OPTIONS: "",
        JAVA_HOME: javaHome,
        REA_PROCESS_RUN_ID: "d6fcbb66-e829-4ff6-a535-0035aec63139",
      },
    });
    expect(capture.environment.PATH).toMatch(
      process.platform === "win32"
        ? /^C:\\Java\\jdk-21\\bin;/u
        : /^\/opt\/jdk-21\/bin:/u,
    );
    expect(capture.environment.GHIDRA_HEADLESS_JAVA_OPTIONS).toContain(
      `-Duser.home=${join(runtimeRoot, "home")}`,
    );
    if (process.platform !== "win32")
      expect(
        (await stat(join(runtimeRoot, "ownership.json"))).mode & 0o777,
      ).toBe(0o600);

    const cleaned = await launched.value.cleanup?.();
    expect(cleaned).toMatchObject({ cleaned: true });
    await expect(access(join(runtimeRoot, "project"))).resolves.toBeUndefined();
  });
});

const waitFor = async (path: string): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
};
