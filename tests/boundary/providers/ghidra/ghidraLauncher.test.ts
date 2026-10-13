import {
  access,
  chmod,
  mkdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, posix, win32 } from "node:path";
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

describe("Ghidra raw-binary loader", () => {
  it("loads caller-supplied architecture and entry before auto-analysis", () => {
    const arguments_ = ghidraHeadlessArguments({
      projectRoot: "/tmp/project",
      targetPath: "/tmp/ecu.bin",
      bridgeScriptPath: "/package/bridge/ReaGhidraBridge.java",
      descriptorPath: "/tmp/session.json",
      ghidraLogPath: "/tmp/ghidra.log",
      scriptLogPath: "/tmp/script.log",
      rawBinary: {
        languageId: "ARM:LE:32:v7",
        compilerSpecId: "default",
        baseAddr: "0x8000000",
      },
    });
    expectOptions(arguments_, [
      ["-loader", "BinaryLoader"],
      ["-loader-baseAddr", "0x8000000"],
      ["-processor", "ARM:LE:32:v7"],
      ["-cspec", "default"],
    ]);
    const prepare = arguments_.indexOf("-preScript");
    expect(arguments_[prepare + 1]).toBe(
      join("/package/bridge", "ReaGhidraPrepareRaw.java"),
    );
    expect(arguments_[prepare + 2]).toBe("ARM:LE:32:v7");
    expect(arguments_[prepare + 3]).toBe("0x8000000");
    expect(prepare).toBeLessThan(arguments_.indexOf("-postScript"));
    expect(arguments_).toContain("-readOnly");
    expect(arguments_).toContain("-deleteProject");
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
      platform: "darwin",
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
      ["-postScript", "/package/bridge/ReaGhidraNoReturnFix.java"],
    ]);
    // The no-return repair must finish before the bridge starts serving.
    const fix = arguments_.indexOf("/package/bridge/ReaGhidraNoReturnFix.java");
    const bridge = arguments_.indexOf("/package/bridge/ReaGhidraBridge.java");
    expect(fix).toBeLessThan(bridge);
    expect(arguments_[bridge + 1]).toBe("/tmp/session.json");
    expect(arguments_).toContain("-readOnly");
    expect(arguments_).toContain("-deleteProject");
  });
  it("remaps soft-float storage after the no-return fix and before the bridge", () => {
    const base = {
      platform: "linux" as const,
      projectRoot: "/tmp/project",
      targetPath: "/tmp/target",
      bridgeScriptPath: "/package/bridge/ReaGhidraBridge.java",
      descriptorPath: "/tmp/session.json",
      ghidraLogPath: "/tmp/ghidra.log",
      scriptLogPath: "/tmp/script.log",
    };
    const soft = "/package/bridge/ReaGhidraMipsSoftFloat.java";
    expect(ghidraHeadlessArguments(base)).not.toContain(soft);
    const arguments_ = ghidraHeadlessArguments({
      ...base,
      mipsSoftFloat: true,
    });
    expect(arguments_[arguments_.indexOf(soft) - 1]).toBe("-postScript");
    expect(
      arguments_.indexOf("/package/bridge/ReaGhidraNoReturnFix.java"),
    ).toBeLessThan(arguments_.indexOf(soft));
    expect(arguments_.indexOf(soft)).toBeLessThan(
      arguments_.indexOf("/package/bridge/ReaGhidraBridge.java"),
    );
    for (const conflict of [
      { psp: true as const },
      { dosMz: true as const },
      { dosCom: true as const },
      {
        rawBinary: {
          languageId: "x86:LE:32:default",
          compilerSpecId: "default",
          baseAddr: "0x1000",
        },
      },
    ])
      expect(() =>
        ghidraHeadlessArguments({ ...base, mipsSoftFloat: true, ...conflict }),
      ).toThrow(/generic MIPS ELF/u);
  });
});

describe("Ghidra configured import language and seeds", () => {
  const base = {
    platform: "darwin" as const,
    projectRoot: "/tmp/project",
    targetPath: "/tmp/target",
    bridgeScriptPath: "/package/bridge/ReaGhidraBridge.java",
    descriptorPath: "/tmp/session.json",
    ghidraLogPath: "/tmp/ghidra.log",
    scriptLogPath: "/tmp/script.log",
  };

  it("passes a configured language and compiler spec to the import", () => {
    const arguments_ = ghidraHeadlessArguments({
      ...base,
      languageOverride: {
        languageId: "x86:LE:32:default",
        compilerSpecId: "borlandcpp",
      },
    });
    expectOptions(arguments_, [
      ["-processor", "x86:LE:32:default"],
      ["-cspec", "borlandcpp"],
    ]);
    expect(arguments_).not.toContain("-loader");
    expect(arguments_.indexOf("-processor")).toBeGreaterThan(
      arguments_.indexOf("-import"),
    );
  });

  it("lets Ghidra choose the language default compiler spec", () => {
    const arguments_ = ghidraHeadlessArguments({
      ...base,
      languageOverride: { languageId: "x86:LE:32:default" },
    });
    expectOptions(arguments_, [["-processor", "x86:LE:32:default"]]);
    expect(arguments_).not.toContain("-cspec");
  });

  it("never combines a configured language with a DOS import", () => {
    expect(() =>
      ghidraHeadlessArguments({
        ...base,
        dosMz: true,
        languageOverride: { languageId: "x86:LE:32:default" },
      }),
    ).toThrow(/cannot be combined with a DOS import/u);
  });

  it("never combines a configured language with a raw-binary import", () => {
    expect(() =>
      ghidraHeadlessArguments({
        ...base,
        languageOverride: { languageId: "x86:LE:32:default" },
        rawBinary: {
          languageId: "ARM:LE:32:v7",
          compilerSpecId: "default",
          baseAddr: "0x8000000",
        },
      }),
    ).toThrow(/cannot be combined with a raw-binary import/u);
  });

  it.each(["darwin", "win32"] as const)(
    "applies seeds after loader preparation and before analysis scripts on %s",
    (platform) => {
      const path = platform === "win32" ? win32 : posix;
      const bridgeDirectory = path.join("/package", "bridge");
      const seedPath = path.join("/tmp/runtime/seeds", "seeds.tsv");
      const arguments_ = ghidraHeadlessArguments({
        ...base,
        platform,
        bridgeScriptPath: path.join(bridgeDirectory, "ReaGhidraBridge.java"),
        dosCom: true,
        seedPath,
      });
      const prepare = arguments_.indexOf(
        path.join(bridgeDirectory, "ReaGhidraPrepareCom.java"),
      );
      const seeds = arguments_.indexOf(
        path.join(bridgeDirectory, "ReaGhidraApplySeeds.java"),
      );
      expect(prepare).toBeGreaterThanOrEqual(0);
      expect(arguments_[seeds - 1]).toBe("-preScript");
      expect(arguments_[seeds + 1]).toBe(seedPath);
      expect(prepare).toBeLessThan(seeds);
      expect(seeds).toBeLessThan(arguments_.indexOf("-postScript"));
    },
  );

  it("adds no seed script without a seed snapshot", () => {
    expect(ghidraHeadlessArguments(base)).not.toContain(
      posix.join("/package/bridge", "ReaGhidraApplySeeds.java"),
    );
  });
});

describe("Ghidra disabled analyzers", () => {
  const base = {
    platform: "darwin" as const,
    projectRoot: "/tmp/project",
    targetPath: "/tmp/target",
    bridgeScriptPath: "/package/bridge/ReaGhidraBridge.java",
    descriptorPath: "/tmp/session.json",
    ghidraLogPath: "/tmp/ghidra.log",
    scriptLogPath: "/tmp/script.log",
  };

  it("applies the analyzer options after seeds and before analysis scripts", () => {
    const arguments_ = ghidraHeadlessArguments({
      ...base,
      dosCom: true,
      seedPath: posix.join("/tmp/runtime/seeds", "seeds.tsv"),
      disabledAnalyzers: [
        "Objective-C Message Analyzer",
        "Decompiler Switch Analysis",
      ],
    });
    const options = arguments_.indexOf(
      posix.join("/package/bridge", "ReaGhidraAnalysisOptions.java"),
    );
    expect(arguments_[options - 1]).toBe("-preScript");
    expect(arguments_[options + 1]).toBe(
      "Objective-C Message Analyzer,Decompiler Switch Analysis",
    );
    const prepare = arguments_.indexOf(
      posix.join("/package/bridge", "ReaGhidraPrepareCom.java"),
    );
    const seeds = arguments_.indexOf(
      posix.join("/package/bridge", "ReaGhidraApplySeeds.java"),
    );
    expect(prepare).toBeLessThan(seeds);
    expect(seeds).toBeLessThan(options);
    expect(options).toBeLessThan(arguments_.indexOf("-postScript"));
  });

  it.each(["darwin", "win32"] as const)(
    "uses the target platform's script path for the options script on %s",
    (platform) => {
      const path = platform === "win32" ? win32 : posix;
      const arguments_ = ghidraHeadlessArguments({
        ...base,
        platform,
        bridgeScriptPath: path.join(
          "/package",
          "bridge",
          "ReaGhidraBridge.java",
        ),
        disabledAnalyzers: ["Objective-C Message Analyzer"],
      });
      const options = arguments_.indexOf(
        path.join("/package", "bridge", "ReaGhidraAnalysisOptions.java"),
      );
      expect(arguments_[options - 1]).toBe("-preScript");
      expect(arguments_[options + 1]).toBe("Objective-C Message Analyzer");
      expect(options).toBeLessThan(arguments_.indexOf("-postScript"));
    },
  );

  it("keeps the invocation byte-identical without an override", () => {
    expect(ghidraHeadlessArguments(base)).toEqual([
      "/tmp/project",
      "rea-project",
      "-import",
      "/tmp/target",
      "-readOnly",
      "-deleteProject",
      "-log",
      "/tmp/ghidra.log",
      "-scriptlog",
      "/tmp/script.log",
      "-scriptPath",
      "/package/bridge",
      "-postScript",
      "/package/bridge/ReaGhidraNoReturnFix.java",
      "-postScript",
      "/package/bridge/ReaGhidraBridge.java",
      "/tmp/session.json",
    ]);
  });

  it("adds no analyzer script for an empty override", () => {
    expect(
      ghidraHeadlessArguments({ ...base, disabledAnalyzers: [] }),
    ).not.toContain(
      posix.join("/package/bridge", "ReaGhidraAnalysisOptions.java"),
    );
  });
});

describe("Ghidra Windows launcher", () => {
  it("keeps analysis repair outside Windows P0 authority", () => {
    const args = ghidraHeadlessArguments({
      platform: "win32",
      projectRoot: "/tmp/project",
      targetPath: "/tmp/target",
      bridgeScriptPath: "/package/bridge/ReaGhidraBridge.java",
      descriptorPath: "/tmp/session.json",
      ghidraLogPath: "/tmp/ghidra.log",
      scriptLogPath: "/tmp/script.log",
    });
    expect(args).not.toContain("/package/bridge/ReaGhidraNoReturnFix.java");
    expect(args).toContain("/package/bridge/ReaGhidraBridge.java");
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
});

describe("Ghidra Windows launcher runtime", () => {
  it.skipIf(process.platform !== "win32").each([
    {
      properties:
        "application.version=12.1.4\napplication.release.name=PUBLIC\n",
      release: "ghidra_12.1.4_PUBLIC",
    },
    { properties: undefined, release: "renamed-install" },
    { properties: "application.version=12.1.4\n", release: "renamed-install" },
  ])(
    "prepares the release directory through the Windows runtime ($release)",
    async ({ properties, release }) => {
      const parent = await createTestTempDirectory("rea-launch-config-");
      const installRoot = join(parent, "renamed-install");
      if (properties !== undefined) {
        await mkdir(join(installRoot, "Ghidra"), { recursive: true });
        await writeFile(
          join(installRoot, "Ghidra", "application.properties"),
          properties,
        );
      }
      const runtime = await createGhidraTestRuntime(parent);
      runtimes.push(runtime);
      const spawnProcess = vi.fn(async () => {
        throw new Error("fixture stops before process creation");
      });
      const launcher = new GhidraHeadlessLauncher({
        environment: process.env,
        platform: "win32",
        analyzeHeadlessPath: join(
          installRoot,
          "support",
          "analyzeHeadless.bat",
        ),
        javaHome: "C:\\Java\\jdk-21",
        bridgeScriptPath: join(parent, "ReaGhidraBridge.java"),
        spawnProcess,
      });
      const launched = await launcher.launch({
        runtimeRoot: runtime.path,
        transport: "unix-socket",
        endpointPath: join(runtime.path, "bridge.sock"),
        token: "fixture-token",
        runId: "d6fcbb66-e829-4ff6-a535-0035aec63139",
        targetPath: join(parent, "fixture.exe"),
        targetSha256: "b".repeat(64),
        providerVersion: "12.1.4",
        profileDigest: "a".repeat(64),
      });
      expect(launched.ok).toBe(false);
      expect(spawnProcess).toHaveBeenCalledOnce();
      expect(
        (
          await stat(join(runtime.path, "config", "ghidra", release))
        ).isDirectory(),
      ).toBe(true);
    },
  );

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
