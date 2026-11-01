import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";

import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const registrationFixture = async () => {
  const home = await createTestTempDirectory("rea-mcp-unknown-options-");
  const bin = join(home, "bin");
  const log = join(home, "runner.jsonl");
  const script = join(home, "runner.cjs");
  await mkdir(bin);
  await writeFile(log, "");
  await writeFile(
    script,
    `require("node:fs").appendFileSync(process.env.REA_TEST_RUNNER_LOG,
  JSON.stringify(process.argv.slice(2)) + "\\n");
console.log("│ ✓ Claude Code: fixture │");
`,
  );
  // Cover every runner that Incur can select, without acquiring a package.
  for (const runner of ["npx", "bun", "bunx", "pnpx"]) {
    await writeFile(
      join(bin, process.platform === "win32" ? `${runner}.cmd` : runner),
      process.platform === "win32"
        ? `@echo off\r\n"%REA_TEST_NODE%" "%REA_TEST_RUNNER_SCRIPT%" %*\r\n`
        : `#!/bin/sh\nexec "$REA_TEST_NODE" "$REA_TEST_RUNNER_SCRIPT" "$@"\n`,
      { mode: 0o700 },
    );
  }
  return {
    home,
    log,
    settings: join(home, ".config", "amp", "settings.json"),
    environment: {
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      PATH: [bin, process.env.PATH ?? ""].join(delimiter),
      REA_TEST_NODE: process.execPath,
      REA_TEST_RUNNER_SCRIPT: script,
      REA_TEST_RUNNER_LOG: log,
      npm_config_user_agent: "npm/11 node/v24.22.1",
      npm_execpath: "",
    },
  };
};

cliTest(
  "mcp add rejects unknown options before registration",
  async ({ cli }) => {
    const fixture = await registrationFixture();
    const cases = [
      { arguments: ["mcp", "add", "--bogus"], flag: "--bogus" },
      {
        arguments: ["mcp", "add", "--agents", "claude-code"],
        flag: "--agents",
      },
      {
        arguments: ["mcp", "add", "--agent", "claude-code", "--bogus=value"],
        flag: "--bogus",
      },
      { arguments: ["mcp", "add", "--agent", "amp", "-x"], flag: "-x" },
      {
        arguments: ["--full-output", "mcp", "add", "--bogus"],
        flag: "--bogus",
      },
      {
        arguments: ["mcp", "--format", "json", "add", "--bogus"],
        flag: "--bogus",
      },
    ];
    for (const entry of cases) {
      const result = await cli.run({
        arguments: [...entry.arguments, "--json"],
        cwd: fixture.home,
        environment: fixture.environment,
        timeoutMs: 20_000,
      });
      expect(result.exitCode, entry.arguments.join(" ")).toBe(1);
      expect(result.json).toMatchObject({
        code: "PARSE_ERROR",
        message: expect.stringContaining(`Unknown flag: ${entry.flag}`),
      });
      expect(result.stdout).not.toContain("Registered rea");
      expect(await readFile(fixture.log, "utf8")).toBe("");
      await expect(access(fixture.settings)).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
    for (const format of ["toon", "md", "csv", "tsv"]) {
      const result = await cli.run({
        arguments: [
          "mcp",
          "add",
          "--bogus",
          "--format",
          format,
          ...(format === "csv" || format === "tsv"
            ? ["--filter-output", "rows", "--columns", "code"]
            : []),
        ],
        cwd: fixture.home,
        environment: fixture.environment,
        timeoutMs: 20_000,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain(
        format === "md" ? "Unknown flag&#58; --bogus" : "Unknown flag: --bogus",
      );
      expect(await readFile(fixture.log, "utf8")).toBe("");
      await expect(access(fixture.settings)).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
  },
);

cliTest.for(["default", "json", "jsonl", "yaml", "toon", "md", "csv", "tsv"])(
  "unknown registration diagnostics redact declared values in %s output",
  async (format, { cli }) => {
    const fixture = await registrationFixture();
    const directory = join(fixture.home, ".config", "amp");
    await mkdir(directory, { recursive: true });
    const original = "malformed settings\n";
    await writeFile(fixture.settings, original);
    const literal = "SYNTHETIC_REGISTRATION_LITERAL_83A4";
    const declarations = [
      ["--sensitive-value", literal],
      [`--sensitive-value=${literal}`],
      ["--sensitiveValue", literal],
      [`--sensitiveValue=${literal}`],
    ];
    for (const declaration of declarations) {
      const result = await cli.run({
        arguments: [
          "mcp",
          "add",
          "--agent=amp",
          `--bogus=${literal}`,
          ...declaration,
          ...(format === "default" ? [] : ["--format", format]),
          ...(format === "csv" || format === "tsv"
            ? ["--filter-output", "rows", "--columns", "code"]
            : []),
        ],
        cwd: fixture.home,
        environment: fixture.environment,
        timeoutMs: 20_000,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).not.toContain(literal);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("PARSE_ERROR");
      expect(result.stdout).toContain("--bogus=");
      expect(result.stdout).toContain("REDACTED");
      expect(result.stdout).not.toContain("Registered rea");
      expect(await readFile(fixture.settings, "utf8")).toBe(original);
      expect(await readdir(directory)).toEqual(["settings.json"]);
      expect(await readFile(fixture.log, "utf8")).toBe("");
    }
  },
);

cliTest(
  "registration diagnostics use split declarations and redact the whole message only",
  async ({ cli }) => {
    const fixture = await registrationFixture();
    const literal = "SYNTHETIC_REGISTRATION_LITERAL_83A4";
    const cases = [
      {
        tail: [`--bogus=${literal}`, "--sensitive-value", "--json", literal],
        message: "Unknown flag: --bogus=[REDACTED]",
      },
      {
        tail: [`--sensitiveValue=${literal}`, `--bogus=${literal}`],
        message: "Unknown flag: --sensitiveValue=[REDACTED]",
      },
      {
        tail: [
          `--${literal}-suffix`,
          "--sensitive-value",
          literal,
          `--sensitiveValue=${literal}-suffix`,
          "--sensitive-value=Unknown flag",
        ],
        message: "[REDACTED]: --[REDACTED]",
      },
      {
        // A declaration-shaped output value is not a command declaration.
        tail: [
          `--bogus=${literal}`,
          "--filter-output",
          `--sensitive-value=${literal}`,
        ],
        message: `Unknown flag: --bogus=${literal}`,
      },
      {
        tail: [`--bogus=${literal}`],
        message: `Unknown flag: --bogus=${literal}`,
      },
    ];
    for (const entry of cases) {
      const result = await cli.run({
        arguments: [
          "mcp",
          "add",
          "--agent",
          "claude-code",
          ...entry.tail,
          "--json",
        ],
        cwd: fixture.home,
        environment: fixture.environment,
        timeoutMs: 20_000,
      });
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout)).toEqual({
        code: "PARSE_ERROR",
        message: entry.message,
      });
      expect(result.stderr).toBe("");
      expect(await readFile(fixture.log, "utf8")).toBe("");
      await expect(access(fixture.settings)).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
  },
);

cliTest(
  "unknown registration options precede Amp settings validation and backup",
  async ({ cli }) => {
    const fixture = await registrationFixture();
    const directory = join(fixture.home, ".config", "amp");
    await mkdir(directory, { recursive: true });
    const original = "malformed settings\n";
    await writeFile(fixture.settings, original);
    const result = await cli.run({
      arguments: ["mcp", "add", "--agent=amp", "--bogus", "--json"],
      cwd: fixture.home,
      environment: fixture.environment,
      timeoutMs: 20_000,
    });
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      code: "PARSE_ERROR",
      message: expect.stringContaining("Unknown flag: --bogus"),
    });
    expect(await readFile(fixture.settings, "utf8")).toBe(original);
    expect(await readdir(directory)).toEqual(["settings.json"]);
    expect(await readFile(fixture.log, "utf8")).toBe("");
  },
);

cliTest(
  "registration values and discovery retain their existing behavior",
  async ({ cli }) => {
    const fixture = await registrationFixture();
    const run = (arguments_: string[]) =>
      cli.run({
        arguments: arguments_,
        cwd: fixture.home,
        environment: fixture.environment,
        timeoutMs: 20_000,
      });
    for (const flag of ["--help", "--schema"]) {
      const result = await run(["mcp", "add", "--bogus", flag, "--json"]);
      expect(result.exitCode).toBe(flag === "--help" ? 0 : 1);
      expect(result.stdout).not.toContain("Unknown flag");
      expect(result.stdout).not.toContain("Registered rea");
      expect(await readFile(fixture.log, "utf8")).toBe("");
      await expect(access(fixture.settings)).rejects.toMatchObject({
        code: "ENOENT",
      });
    }

    for (const option of ["--command", "-c"]) {
      await writeFile(fixture.log, "");
      const result = await run([
        "mcp",
        "add",
        "--agent",
        "claude-code",
        option,
        "--bogus",
        "--no-global",
      ]);
      expect(result.exitCode, result.stderr).toBe(0);
      const calls = (await readFile(fixture.log, "utf8")).trim().split("\n");
      expect(calls).toHaveLength(1);
      expect(JSON.parse(calls[0]!)).toEqual([
        "add-mcp",
        "--bogus",
        "--name",
        "rea",
        "-y",
        "-a",
        "claude-code",
      ]);
      await expect(access(fixture.settings)).rejects.toMatchObject({
        code: "ENOENT",
      });
    }

    await writeFile(fixture.log, "");
    const equals = await run([
      "mcp",
      "add",
      "--agent=amp",
      "--command=fixture-command",
    ]);
    expect(equals.exitCode, equals.stderr).toBe(0);
    expect(
      JSON.parse(await readFile(fixture.settings, "utf8"))["amp.mcpServers"]
        .rea,
    ).toMatchObject({ command: "fixture-command", args: [] });
    expect(await readFile(fixture.log, "utf8")).toBe("");
  },
);
