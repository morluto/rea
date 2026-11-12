import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import {
  classifyMcpAddDiscovery,
  isProjectScopedAmpRegistration,
} from "../../../src/cliBuiltinArguments.js";

describe("mcp add discovery classification", () => {
  it("bypasses help and listing flags", () => {
    for (const flag of [
      "--help",
      "-h",
      "--llms",
      "--llms-full",
      "--mcp",
      "--update",
      "--incur-update-check",
    ]) {
      expect(classifyMcpAddDiscovery(new Set([flag]))).toBe("bypass");
    }
  });

  it("answers version and schema inside the mcp add special-casing", () => {
    expect(classifyMcpAddDiscovery(new Set(["--version"]))).toBe("version");
    expect(classifyMcpAddDiscovery(new Set(["--schema"]))).toBe("schema");
  });

  it("keeps routing precedence when several discovery flags combine", () => {
    expect(classifyMcpAddDiscovery(new Set(["--help", "--version"]))).toBe(
      "bypass",
    );
    expect(classifyMcpAddDiscovery(new Set(["--version", "--schema"]))).toBe(
      "version",
    );
  });

  it("returns undefined for real registrations", () => {
    expect(classifyMcpAddDiscovery(new Set(["--json"]))).toBeUndefined();
    expect(classifyMcpAddDiscovery(new Set())).toBeUndefined();
  });
});

describe("project-scoped Amp registration guard", () => {
  it("flags explicit Amp targets under --no-global", () => {
    expect(
      isProjectScopedAmpRegistration([
        "mcp",
        "add",
        "--no-global",
        "--agent",
        "amp",
        "--command",
        "node project-rea.mjs",
      ]),
    ).toBe(true);
  });

  it("flags the default Amp registration when no agent is given", () => {
    expect(isProjectScopedAmpRegistration(["mcp", "add", "--no-global"])).toBe(
      true,
    );
  });

  it("ignores output flags Incur strips before dispatch", () => {
    expect(
      isProjectScopedAmpRegistration([
        "mcp",
        "add",
        "--no-global",
        "--agent",
        "amp",
        "--command",
        "node project-rea.mjs",
        "--json",
      ]),
    ).toBe(true);
  });

  it("passes global Amp registration through", () => {
    expect(
      isProjectScopedAmpRegistration([
        "mcp",
        "add",
        "--agent",
        "amp",
        "--command",
        "node project-rea.mjs",
      ]),
    ).toBe(false);
  });

  it("passes project-scoped non-Amp agents through", () => {
    expect(
      isProjectScopedAmpRegistration([
        "mcp",
        "add",
        "--no-global",
        "--agent",
        "claude-code",
      ]),
    ).toBe(false);
  });

  it("passes discovery requests through, matching mcp add discovery", () => {
    for (const discovery of [
      "--help",
      "-h",
      "--llms",
      "--llms-full",
      "--version",
      "--schema",
    ]) {
      expect(
        isProjectScopedAmpRegistration([
          "mcp",
          "add",
          "--no-global",
          "--agent",
          "amp",
          discovery,
        ]),
      ).toBe(false);
    }
    expect(
      isProjectScopedAmpRegistration(["mcp", "add", "--no-global", "--help"]),
    ).toBe(false);
  });

  it("reads equals-form agents the same way dispatch does", () => {
    // --agent=claude-code is a non-Amp registration, not the default Amp.
    expect(
      isProjectScopedAmpRegistration([
        "mcp",
        "add",
        "--no-global",
        "--agent=claude-code",
      ]),
    ).toBe(false);
    expect(
      isProjectScopedAmpRegistration([
        "mcp",
        "add",
        "--no-global",
        "--agent=amp",
      ]),
    ).toBe(true);
    // A later equals-form Amp must not slip past an earlier spaced agent.
    expect(
      isProjectScopedAmpRegistration([
        "mcp",
        "add",
        "--no-global",
        "--agent",
        "claude-code",
        "--agent=amp",
      ]),
    ).toBe(true);
    // A --command value is never read as an agent, even in equals form.
    expect(
      isProjectScopedAmpRegistration([
        "mcp",
        "add",
        "--no-global",
        "--command=--agent",
        "amp",
      ]),
    ).toBe(true);
  });

  it("passes other commands through", () => {
    expect(isProjectScopedAmpRegistration(["mcp", "doctor"])).toBe(false);
    expect(isProjectScopedAmpRegistration(["doctor"])).toBe(false);
    expect(
      isProjectScopedAmpRegistration([
        "mcp",
        "add",
        "--no-global",
        "--agent",
        "Amp",
      ]),
    ).toBe(false);
  });
});

describe("project-scoped Amp registration launcher", () => {
  it("refuses explicit Amp and default-agent requests without writing settings", async () => {
    const home = await createTestTempDirectory("rea-amp-launcher-home-");
    const workingDirectory = await createTestTempDirectory(
      "rea-amp-launcher-cwd-",
    );
    const ampDirectory = join(home, ".config", "amp");
    await mkdir(ampDirectory, { recursive: true });
    const settingsPath = join(ampDirectory, "settings.json");
    const sentinel = JSON.stringify({ preexisting: true });
    await writeFile(settingsPath, sentinel);
    for (const args of [
      ["mcp", "add", "--no-global", "--agent", "amp", "--json"],
      ["mcp", "add", "--no-global", "--json"],
      ["mcp", "add", "--no-global", "--agent=amp", "--json"],
      [
        "mcp",
        "add",
        "--no-global",
        "--agent",
        "claude-code",
        "--agent=amp",
        "--json",
      ],
    ]) {
      const result = spawnSync(
        process.execPath,
        [resolve("scripts/rea.mjs"), ...args],
        {
          cwd: workingDirectory,
          env: {
            PATH: process.env.PATH ?? "",
            HOME: home,
            REA_LOG_LEVEL: "silent",
          },
          encoding: "utf8",
          timeout: 60_000,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout)).toEqual({
        ok: false,
        error: {
          code: "AMP_PROJECT_SCOPE_UNSUPPORTED",
          message: expect.any(String),
        },
      });
      expect(result.stderr).toBe("");
      expect(await readFile(settingsPath, "utf8")).toBe(sentinel);
      expect(await readdir(workingDirectory)).toEqual([]);
    }
  });
});
