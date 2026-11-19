import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import {
  classifyMcpAddDiscovery,
  isProjectScopedAmpRegistration,
  parseCliGlobalArguments,
  productionMcpHttpArguments,
} from "../../../src/cliBuiltinArguments.js";

/** Whether these caller arguments ask for a project-scoped Amp registration. */
const projectScoped = (arguments_: readonly string[]): boolean =>
  isProjectScopedAmpRegistration(parseCliGlobalArguments(arguments_));

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
  it("passes project-scoped non-Amp agents through", () => {
    expect(
      projectScoped(["mcp", "add", "--no-global", "--agent", "claude-code"]),
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
        projectScoped([
          "mcp",
          "add",
          "--no-global",
          "--agent",
          "amp",
          discovery,
        ]),
      ).toBe(false);
    }
    expect(projectScoped(["mcp", "add", "--no-global", "--help"])).toBe(false);
  });

  it("reads equals-form agents the same way dispatch does", () => {
    // --agent=claude-code is a non-Amp registration, not the default Amp.
    expect(
      projectScoped(["mcp", "add", "--no-global", "--agent=claude-code"]),
    ).toBe(false);
    // A --command value is never read as an agent, even in equals form.
    expect(
      projectScoped(["mcp", "add", "--no-global", "--command=--agent", "amp"]),
    ).toBe(true);
  });

  it("passes other commands through", () => {
    expect(projectScoped(["mcp", "doctor"])).toBe(false);
    expect(projectScoped(["doctor"])).toBe(false);
    expect(projectScoped(["mcp", "add", "--no-global", "--agent", "Amp"])).toBe(
      false,
    );
  });
});

describe("production mcp --http arguments", () => {
  it("selects the HTTP reader only for flags that follow the entry", () => {
    expect(productionMcpHttpArguments(["mcp", "--http"])).toEqual(["--http"]);
    expect(productionMcpHttpArguments(["--mcp", "--http"])).toEqual(["--http"]);
    expect(
      productionMcpHttpArguments(["mcp", "--http", "--port", "8765"]),
    ).toEqual(["--http", "--port", "8765"]);
    expect(
      productionMcpHttpArguments(["mcp", "--host", "127.0.0.1", "--http"]),
    ).toEqual(["--host", "127.0.0.1", "--http"]);
    expect(productionMcpHttpArguments(["mcp", "-h", "--http"])).toEqual([
      "-h",
      "--http",
    ]);
  });

  it("keeps registration, subcommands, and a bare alias with the dispatcher", () => {
    expect(
      productionMcpHttpArguments(["mcp", "add", "--http"]),
    ).toBeUndefined();
    expect(productionMcpHttpArguments(["--http"])).toBeUndefined();
    expect(productionMcpHttpArguments(["mcp", "--json", "--http"])).toEqual([
      "--json",
      "--http",
    ]);
  });

  it("treats an output flag's value as data, not as the mode", () => {
    expect(
      productionMcpHttpArguments(["mcp", "--format", "--http"]),
    ).toBeUndefined();
    expect(
      productionMcpHttpArguments(["mcp", "--format=--http"]),
    ).toBeUndefined();
    expect(
      productionMcpHttpArguments(["mcp", "--format", "json", "--http"]),
    ).toEqual(["--format", "json", "--http"]);
  });

  it("treats a transport option's value as data", () => {
    // A transport option's value is data: `doctor` here is its host name.
    expect(
      productionMcpHttpArguments(["mcp", "--host", "doctor", "--http"]),
    ).toEqual(["--host", "doctor", "--http"]);
    expect(
      productionMcpHttpArguments(["mcp", "--host", "--http", "--http"]),
    ).toEqual(["--host", "--http", "--http"]);
    expect(
      productionMcpHttpArguments(["mcp", "--host", "127.0.0.1", "--http"]),
    ).toEqual(["--host", "127.0.0.1", "--http"]);
  });

  it("leaves doctor with the reader that owns output flags", () => {
    expect(
      productionMcpHttpArguments(["mcp", "doctor", "--http"]),
    ).toBeUndefined();
    // `--http` puts the entry in flag position, so a following word is this
    // entry's own argument error, not a doctor request.
    expect(productionMcpHttpArguments(["mcp", "--http", "doctor"])).toEqual([
      "--http",
      "doctor",
    ]);
  });

  it("keeps help in flag position for the HTTP entry", () => {
    // The doctor reader wants `mcp doctor` in that order; a word after a flag
    // is not the doctor command, so this stays HTTP help.
    expect(
      productionMcpHttpArguments(["mcp", "--http", "--help", "doctor"]),
    ).toEqual(["--http", "--help", "doctor"]);
    expect(productionMcpHttpArguments(["mcp", "--http", "--help"])).toEqual([
      "--http",
      "--help",
    ]);
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
