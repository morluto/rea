import { access, chmod, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";
import { createGhidraTestRuntime } from "../../../fixtures/ghidraRuntime.js";
import type { PrivateRuntimeRoot } from "../../../../src/process/PrivateRuntimeRoot.js";

import {
  ghidraHeadlessArguments,
  ghidraHeadlessCommand,
  GhidraHeadlessLauncher,
} from "../../../../src/ghidra/GhidraLauncher.js";

const fixturePath = fileURLToPath(
  new URL(
    process.platform === "win32"
      ? "../../../fixtures/captureGhidraLaunch.cmd"
      : "../../../fixtures/captureGhidraLaunch.mjs",
    import.meta.url,
  ),
);
const runtimes: PrivateRuntimeRoot[] = [];

const launchCaptureSchema = z.object({
  arguments: z.array(z.string()),
  environment: z.record(z.string(), z.string()),
  descriptor_mode: z.number().int(),
  descriptor_has_token: z.boolean(),
});

const expectOptions = (
  arguments_: readonly string[],
  options: readonly (readonly [string, string])[],
): void => {
  for (const [flag, value] of options) {
    const index = arguments_.indexOf(flag);
    expect(index, flag).toBeGreaterThanOrEqual(0);
    expect(arguments_[index + 1], flag).toBe(value);
  }
};

const expectIsolatedEnvironment = (
  environment: Record<string, string>,
  runtimeRoot: string,
  javaHome: string,
) => {
  expect(environment).toMatchObject({
    HOME: join(runtimeRoot, "home"),
    ...(process.platform === "win32"
      ? {
          USERPROFILE: join(runtimeRoot, "home"),
          APPDATA: join(runtimeRoot, "config"),
          LOCALAPPDATA: join(runtimeRoot, "cache"),
          TEMP: join(runtimeRoot, "tmp"),
          TMP: join(runtimeRoot, "tmp"),
        }
      : {}),
    TMPDIR: join(runtimeRoot, "tmp"),
    XDG_CACHE_HOME: join(runtimeRoot, "cache"),
    XDG_CONFIG_HOME: join(runtimeRoot, "config"),
    XDG_DATA_HOME: join(runtimeRoot, "data"),
    GHIDRA_JAVA_OPTIONS: "",
    JAVA_TOOL_OPTIONS: "",
    JDK_JAVA_OPTIONS:
      process.platform === "win32"
        ? `"-Duser.home=${join(runtimeRoot, "home")}" "-Djava.io.tmpdir=${join(runtimeRoot, "tmp")}" "-XX:-UsePerfData"`
        : "",
    _JAVA_OPTIONS: "",
    JAVA_HOME: javaHome,
    REA_PROCESS_RUN_ID: "d6fcbb66-e829-4ff6-a535-0035aec63139",
  });
  expect(environment.PATH).toBe(
    `${join(javaHome, "bin")}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
  );
};

beforeAll(async () => {
  if (process.platform !== "win32") await chmod(fixturePath, 0o755);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
});

describe("Ghidra COM loader", () => {
  it("loads explicit COM at its PSP-relative entry before auto-analysis", () => {
    const arguments_ = ghidraHeadlessArguments({
      projectRoot: "/tmp/project",
      targetPath: "/tmp/target.com",
      bridgeScriptPath: "/package/bridge/ReaGhidraBridge.java",
      descriptorPath: "/tmp/session.json",
      ghidraLogPath: "/tmp/ghidra.log",
      scriptLogPath: "/tmp/script.log",
      dosCom: true,
    });
    expectOptions(arguments_, [
      ["-loader", "BinaryLoader"],
      ["-loader-baseAddr", "1000:0100"],
      ["-processor", "x86:LE:16:Real Mode"],
      ["-cspec", "default"],
    ]);
    const prepare = arguments_.indexOf("-preScript");
    expect(arguments_[prepare + 1]).toBe(
      join("/package/bridge", "ReaGhidraPrepareCom.java"),
    );
    expect(prepare).toBeLessThan(arguments_.indexOf("-postScript"));
    expect(arguments_).toContain("-readOnly");
    expect(arguments_).toContain("-deleteProject");
  });
});

describe("Ghidra existing-project launcher", () => {
  it("processes one exact existing Program from an isolated project copy", () => {
    const arguments_ = ghidraHeadlessArguments({
      projectRoot: "/tmp/project",
      targetPath: "/source/Firmware.gpr",
      bridgeScriptPath: "/package/bridge/ReaGhidraBridge.java",
      descriptorPath: "/tmp/session.json",
      ghidraLogPath: "/tmp/ghidra.log",
      scriptLogPath: "/tmp/script.log",
      existingProject: {
        markerPath: "/source/Firmware.gpr",
        storagePath: "/source/Firmware.rep",
        projectName: "Firmware",
        documentPath: "/folder/program.bin",
      },
    });
    expect(arguments_.slice(0, 2)).toEqual(["/tmp/project", "Firmware/folder"]);
    expectOptions(arguments_, [["-process", "program.bin"]]);
    expect(arguments_).toContain("-readOnly");
    expect(arguments_).toContain("-noanalysis");
    expect(arguments_).not.toContain("-import");
    expect(arguments_).not.toContain("-deleteProject");
  });
});

describe("Ghidra headless launcher", () => {
  it("forces the admitted real-mode language and loader for DOS MZ", () => {
    const arguments_ = ghidraHeadlessArguments({
      projectRoot: "/tmp/project",
      targetPath: "/tmp/target",
      bridgeScriptPath: "/package/bridge/ReaGhidraBridge.java",
      descriptorPath: "/tmp/session.json",
      ghidraLogPath: "/tmp/ghidra.log",
      scriptLogPath: "/tmp/script.log",
      dosMz: true,
    });
    expectOptions(arguments_, [
      ["-loader", "MzLoader"],
      ["-processor", "x86:LE:16:Real Mode"],
      ["-cspec", "default"],
    ]);
    expect(arguments_).toContain("-readOnly");
    expect(arguments_).toContain("-deleteProject");
  });
  it("builds a read-only ephemeral import with its bridge descriptor", () => {
    const arguments_ = ghidraHeadlessArguments({
      projectRoot: "/tmp/project",
      targetPath: "/tmp/target",
      bridgeScriptPath: "/package/bridge/ReaGhidraBridge.java",
      descriptorPath: "/tmp/session.json",
      ghidraLogPath: "/tmp/ghidra.log",
      scriptLogPath: "/tmp/script.log",
    });
    expect(arguments_.slice(0, 2)).toEqual(["/tmp/project", "rea-project"]);
    expectOptions(arguments_, [
      ["-import", "/tmp/target"],
      ["-log", "/tmp/ghidra.log"],
      ["-scriptlog", "/tmp/script.log"],
      ["-scriptPath", "/package/bridge"],
      ["-postScript", "/package/bridge/ReaGhidraBridge.java"],
    ]);
    expect(arguments_[arguments_.indexOf("-postScript") + 2]).toBe(
      "/tmp/session.json",
    );
    expect(arguments_).toContain("-readOnly");
    expect(arguments_).toContain("-deleteProject");
  });

  it("wraps the Windows batch launcher without enabling a Node shell", () => {
    const command = ghidraHeadlessCommand({
      environment: {},
      platform: "win32",
      analyzeHeadlessPath:
        "C:\\Program Files\\Ghidra 12.1.4\\support\\analyzeHeadless.bat",
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
        '""C:\\Program Files\\Ghidra 12.1.4\\support\\analyzeHeadless.bat" "C:\\REA Runtime\\project" "rea-project" "-import" "C:\\REA Runtime\\target.exe""',
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
        environment: {},
        platform: "win32",
        analyzeHeadlessPath: "C:\\Ghidra\\support\\analyzeHeadless.bat",
        arguments: ["-import", targetPath],
        comSpec: "C:\\Windows\\System32\\cmd.exe",
      }),
    ).toThrow(/metacharacters/u);
  });

  it.skipIf(process.platform !== "win32")(
    "keeps authority in a private descriptor and isolates Ghidra state through the batch launcher",
    async () => {
      vi.stubEnv("GHIDRA_JAVA_OPTIONS", "-javaagent:/unapproved/agent.jar");
      vi.stubEnv("JAVA_TOOL_OPTIONS", "-Duser.home=/unapproved/home");
      vi.stubEnv("JDK_JAVA_OPTIONS", "-XX:MaxRAMPercentage=99");
      vi.stubEnv("_JAVA_OPTIONS", "-Xmx99G");
      const parent = await createTestTempDirectory("rea-launcher-test-");
      const runtime = await createGhidraTestRuntime(parent);
      runtimes.push(runtime);
      const runtimeRoot = runtime.path;
      const token = "secret-token-that-must-not-leak";
      const javaHome = "C:\\Java\\jdk-21";
      const launcher = new GhidraHeadlessLauncher({
        // Select the fixture's Node PATH and injected JVM options explicitly.
        environment: process.env,
        analyzeHeadlessPath: fixturePath,
        // POSIX follows the real inspected-JVM route; Windows uses the official
        // batch script because its launcher contract differs.
        platform: "win32",
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
        providerVersion: "12.1.4",
        profileDigest: "a".repeat(64),
      });
      if (!launched.ok) throw launched.error;
      try {
        const capturePath = join(runtimeRoot, "launch-capture.json");
        await vi.waitFor(() => access(`${capturePath}.ready`), {
          timeout: 10_000,
        });
        const capture = launchCaptureSchema.parse(
          JSON.parse(await readFile(capturePath, "utf8")),
        );
        const encodedArguments = JSON.stringify(capture.arguments);
        const encodedEnvironment = JSON.stringify(capture.environment);
        expect(encodedArguments).not.toContain(token);
        expect(encodedEnvironment).not.toContain(token);
        expect(capture).toMatchObject({
          ...(process.platform === "win32" ? {} : { descriptor_mode: 0o600 }),
          descriptor_has_token: true,
        });
        expectIsolatedEnvironment(capture.environment, runtimeRoot, javaHome);
        expect(capture.environment.GHIDRA_HEADLESS_JAVA_OPTIONS).toBe("");
        if (process.platform !== "win32")
          expect(
            (await stat(join(runtimeRoot, "ownership.json"))).mode & 0o777,
          ).toBe(0o600);
      } finally {
        const cleaned = await launched.value.cleanup?.();
        expect(cleaned).toMatchObject({ cleaned: true });
        await expect(
          access(join(runtimeRoot, "project")),
        ).resolves.toBeUndefined();
      }
    },
  );
});
