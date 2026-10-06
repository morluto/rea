import { describe, expect, it } from "vitest";

import { parseConfig } from "./config.js";

it("configures Binary Ninja GUI HTTP or headless stdio independently of Hopper/Ghidra", () => {
  expect(
    parseConfig({
      REA_ANALYSIS_PROVIDER: "binary-ninja",
      REA_BINARY_NINJA_MCP_URL: "http://127.0.0.1:24642/mcp",
      REA_BINARY_NINJA_MCP_TOKEN: "secret",
    }),
  ).toMatchObject({
    ok: true,
    value: {
      analysisProvider: "binary-ninja",
      binaryNinjaMcp: {
        url: "http://127.0.0.1:24642/mcp",
        token: "secret",
        args: [],
        timeoutMs: 300_000,
      },
    },
  });
  expect(
    parseConfig({
      REA_BINARY_NINJA_MCP_COMMAND: "/opt/binaryninja/binaryninja_mcp",
      REA_BINARY_NINJA_MCP_ARGS_JSON: '["-p"]',
    }),
  ).toMatchObject({
    ok: true,
    value: {
      binaryNinjaMcp: {
        command: "/opt/binaryninja/binaryninja_mcp",
        args: ["-p"],
      },
    },
  });
});

it.each([
  { REA_BINARY_NINJA_MCP_URL: "http://example.com/mcp" },
  { REA_BINARY_NINJA_MCP_URL: "file:///mcp" },
  { REA_BINARY_NINJA_MCP_URL: "http://user:secret@localhost/mcp" },
  { REA_BINARY_NINJA_MCP_URL: "http://localhost/mcp?token=secret" },
  { REA_BINARY_NINJA_MCP_URL: "http://localhost/mcp#fragment" },
  {
    REA_BINARY_NINJA_MCP_URL: "http://localhost/mcp",
    REA_BINARY_NINJA_MCP_COMMAND: "/opt/binaryninja_mcp",
  },
  { REA_BINARY_NINJA_MCP_COMMAND: "relative/binaryninja_mcp" },
  { REA_BINARY_NINJA_MCP_TOKEN: "secret" },
  { REA_BINARY_NINJA_MCP_ARGS_JSON: "[1]" },
  { REA_BINARY_NINJA_MCP_ARGS_JSON: '["-p"]' },
  { REA_BINARY_NINJA_MCP_TIMEOUT_MS: "0" },
  { REA_BINARY_NINJA_MCP_TIMEOUT_MS: "NaN" },
])("rejects invalid Binary Ninja transport configuration %#", (env) => {
  expect(parseConfig(env).ok).toBe(false);
});

describe("runtime configuration", () => {
  it("allows target-free startup and defaults to Hopper's documented launcher", () => {
    const empty = parseConfig({});
    expect(empty.ok).toBe(true);
    if (empty.ok) {
      expect(empty.value.hopperTargetPath).toBeUndefined();
      expect(empty.value.analysisProvider).toBe("auto");
    }
    const result = parseConfig({ HOPPER_TARGET_PATH: "/usr/bin/true" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.hopperLauncherPath).toBe(
        process.platform === "linux"
          ? "/opt/hopper/bin/Hopper"
          : "/Applications/Hopper Disassembler.app/Contents/MacOS/hopper",
      );
      expect(result.value.hopperTargetKind).toBe("executable");
      expect(result.value.hopperLoaderArgs).toEqual([]);
      expect(result.value.logLevel).toBe("info");
      expect(result.value.referenceSourcePolicy).toEqual({
        secretPatterns: [],
      });
    }
  });

  it("parses one shared provider selector and rejects unstable IDs", () => {
    expect(parseConfig({ REA_ANALYSIS_PROVIDER: "ghidra" })).toMatchObject({
      ok: true,
      value: { analysisProvider: "ghidra" },
    });
    expect(parseConfig({ REA_ANALYSIS_PROVIDER: "auto" })).toMatchObject({
      ok: true,
      value: { analysisProvider: "auto" },
    });
    for (const invalid of ["", "Auto", "ghidra_1", "ghidra "])
      expect(parseConfig({ REA_ANALYSIS_PROVIDER: invalid }).ok).toBe(false);
  });

  it("parses absolute BYO Ghidra and optional Java paths", () => {
    expect(
      parseConfig({
        GHIDRA_INSTALL_DIR: "/opt/ghidra_12.1.4_PUBLIC",
        JAVA_HOME: "/usr/lib/jvm/jdk-21",
      }),
    ).toMatchObject({
      ok: true,
      value: {
        ghidraInstallDir: "/opt/ghidra_12.1.4_PUBLIC",
        ghidraJavaHome: "/usr/lib/jvm/jdk-21",
      },
    });
    expect(parseConfig({ GHIDRA_INSTALL_DIR: "relative/ghidra" }).ok).toBe(
      false,
    );
    expect(parseConfig({ JAVA_HOME: "relative/jdk" }).ok).toBe(false);
  });

  it("parses an optional absolute BYO ilspycmd path", () => {
    expect(
      parseConfig({ REA_ILSPY_CMD_PATH: "/home/user/.dotnet/tools/ilspycmd" }),
    ).toMatchObject({
      ok: true,
      value: {
        ilspyCmdPath: "/home/user/.dotnet/tools/ilspycmd",
      },
    });
    expect(parseConfig({ REA_ILSPY_CMD_PATH: "relative/ilspycmd" }).ok).toBe(
      false,
    );
  });
});

describe("runtime target configuration", () => {
  it("rejects invalid target kinds with actionable environment diagnostics", () => {
    const result = parseConfig({ HOPPER_TARGET_KIND: "archive" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected invalid target kind");
    expect(result.error.message).toContain("Invalid REA environment");
  });

  it("parses database kind and loader arguments", () => {
    expect(
      parseConfig({
        HOPPER_LAUNCHER_PATH: "/custom/hopper",
        REA_ANALYSIS_PROVIDER: "hopper",
        HOPPER_TARGET_PATH: "/fixture/sample.hop",
        HOPPER_TARGET_KIND: "database",
        HOPPER_LOADER_ARGS_JSON: '["-l","FAT","--aarch64","-l","Mach-O"]',
      }),
    ).toMatchObject({
      ok: true,
      value: {
        hopperLauncherPath: "/custom/hopper",
        analysisProvider: "hopper",
        hopperTargetPath: "/fixture/sample.hop",
        hopperTargetKind: "database",
        hopperLoaderArgs: ["-l", "FAT", "--aarch64", "-l", "Mach-O"],
        logLevel: "info",
        referenceSourcePolicy: {
          secretPatterns: [],
        },
      },
    });
  });
});

describe("runtime collection configuration", () => {
  it.each(["not-json", "{}", '"just a string"', '["ok",1]'])(
    "rejects invalid loader args: %s",
    (encoded) => {
      const result = parseConfig({
        HOPPER_TARGET_PATH: "/tmp/a",
        HOPPER_LOADER_ARGS_JSON: encoded,
      });
      expect(result.ok).toBe(false);
      if (result.ok)
        throw new Error("expected malformed loader arguments to fail");
      expect(result.error.message).toContain(
        encoded === "not-json" ? "valid JSON" : "array of strings",
      );
    },
  );

  it("parses supported log levels and rejects unknown levels", () => {
    const configured = parseConfig({ REA_LOG_LEVEL: "debug" });
    expect(configured.ok && configured.value.logLevel).toBe("debug");
    expect(parseConfig({ REA_LOG_LEVEL: "verbose" }).ok).toBe(false);
  });

  it("parses reference source secret patterns", () => {
    const result = parseConfig({
      REA_REFERENCE_SECRET_PATTERNS_JSON: '["*.env", "*.pem", "secrets/"]',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.referenceSourcePolicy).toEqual({
        secretPatterns: ["*.env", "*.pem", "secrets/"],
      });
    }
  });

  it.each(["not-json", "{}", '["*.ok", 1]'])(
    "rejects invalid reference source secret patterns: %s",
    (encoded) => {
      expect(
        parseConfig({ REA_REFERENCE_SECRET_PATTERNS_JSON: encoded }).ok,
      ).toBe(false);
    },
  );
});
