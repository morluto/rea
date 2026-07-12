import { describe, expect, it } from "vitest";

import { parseConfig } from "../../src/config.js";

describe("configuration parsing integration", () => {
  it("returns defaults when no environment variables are set", () => {
    const result = parseConfig({});
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.hopperLauncherPath).toBe(
      process.platform === "linux"
        ? "/opt/hopper/bin/Hopper"
        : "/Applications/Hopper Disassembler.app/Contents/MacOS/hopper",
    );
    expect(result.value.hopperTargetPath).toBeUndefined();
    expect(result.value.hopperTargetKind).toBe("executable");
    expect(result.value.hopperLoaderArgs).toEqual([]);
  });

  it("parses a complete target-bound configuration", () => {
    const result = parseConfig({
      HOPPER_TARGET_PATH: "/usr/bin/true",
      HOPPER_TARGET_KIND: "executable",
      HOPPER_LOADER_ARGS_JSON: '["-l","Mach-O","--aarch64"]',
      REA_EVIDENCE_ROOTS_JSON: '["/tmp/evidence"]',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.hopperTargetPath).toBe("/usr/bin/true");
    expect(result.value.hopperTargetKind).toBe("executable");
    expect(result.value.hopperLoaderArgs).toEqual([
      "-l",
      "Mach-O",
      "--aarch64",
    ]);
    expect(result.value.evidenceFilePolicy.roots).toEqual(["/tmp/evidence"]);
  });

  it("rejects target kind values outside the enum", () => {
    const result = parseConfig({
      HOPPER_TARGET_KIND: "archive",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.message).toContain("Invalid Hopper environment");
  });

  it("rejects invalid JSON in loader arguments", () => {
    const result = parseConfig({
      HOPPER_LOADER_ARGS_JSON: "not json",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.message).toContain("valid JSON");
  });

  it("rejects non-array types in loader arguments JSON", () => {
    const result = parseConfig({
      HOPPER_LOADER_ARGS_JSON: '"just a string"',
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.message).toContain("array of strings");
  });

  it("allows overriding the launcher path while keeping other defaults", () => {
    const result = parseConfig({
      HOPPER_LAUNCHER_PATH: "/custom/hopper",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.hopperLauncherPath).toBe("/custom/hopper");
    expect(result.value.hopperTargetPath).toBeUndefined();
  });

  it("parses database target kind correctly", () => {
    const result = parseConfig({
      HOPPER_TARGET_PATH: "/path/to/file.hop",
      HOPPER_TARGET_KIND: "database",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.hopperTargetKind).toBe("database");
  });
});
