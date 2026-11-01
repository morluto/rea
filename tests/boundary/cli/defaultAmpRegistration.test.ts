import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { delimiter, join } from "node:path";
import { expect, it } from "vitest";
import { Parser, z } from "incur";

import { splitIncurBuiltinArguments } from "../../../src/cliBuiltinArguments.js";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const fixture = async (initial: string) => {
  const home = await createTestTempDirectory("rea-default-amp-");
  const bin = join(home, "bin");
  const log = join(home, "runner.jsonl");
  const script = join(home, "runner.cjs");
  const directory = join(home, ".config", "amp");
  const settings = join(directory, "settings.json");
  await mkdir(bin);
  await mkdir(directory, { recursive: true });
  await writeFile(settings, initial);
  await writeFile(log, "");
  await writeFile(
    script,
    `require("node:fs").appendFileSync(process.env.REA_TEST_RUNNER_LOG,
JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.env.REA_TEST_RUNNER_FAIL) {
  console.error("fixture runner failure");
  process.exitCode = 23;
} else console.log("│ ✓ Fixture Client: fixture │");
`,
  );
  for (const runner of ["npx", "bun", "bunx", "pnpx"])
    await writeFile(
      join(bin, process.platform === "win32" ? `${runner}.cmd` : runner),
      process.platform === "win32"
        ? `@echo off\r\n"%REA_TEST_NODE%" "%REA_TEST_RUNNER_SCRIPT%" %*\r\n`
        : `#!/bin/sh\nexec "$REA_TEST_NODE" "$REA_TEST_RUNNER_SCRIPT" "$@"\n`,
      { mode: 0o700 },
    );
  const environment: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home,
    PATH: [bin, process.env.PATH ?? ""].join(delimiter),
    REA_TEST_NODE: process.execPath,
    REA_TEST_RUNNER_SCRIPT: script,
    REA_TEST_RUNNER_LOG: log,
    npm_config_user_agent: "npm/11 node/v24.22.1",
    npm_execpath: "",
  };
  for (const key of [
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XDG_STATE_HOME",
    "TMPDIR",
  ]) {
    environment[key] = join(home, key);
    await mkdir(environment[key]!);
  }
  return { home, log, directory, settings, environment };
};

const original = `${JSON.stringify({
  "amp.mcpServers": {
    rea: { command: "old", env: { KEEP_ME: "1" } },
    peer: { command: "peer" },
  },
  theme: "dark",
})}\n`;

cliTest(
  "default registration preserves Amp settings and recovery in both output modes",
  async ({ cli }) => {
    for (const output of [[], ["--json"]]) {
      const f = await fixture(original);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const before = await readFile(f.settings, "utf8");
        const result = await cli.run({
          arguments: [
            "mcp",
            "add",
            "--command",
            "fixture-server --mcp",
            ...output,
          ],
          cwd: f.home,
          environment: f.environment,
          timeoutMs: 20_000,
        });
        expect(result.exitCode, result.stderr).toBe(0);
        expect(result.stdout).toContain("Amp");
        expect(JSON.parse(await readFile(f.settings, "utf8"))).toEqual({
          "amp.mcpServers": {
            rea: {
              command: "fixture-server",
              args: ["--mcp"],
              env: { KEEP_ME: "1" },
            },
            peer: { command: "peer" },
          },
          theme: "dark",
        });
        const backup = result.stderr.trim().split(" retained at ")[1]!;
        expect(await readFile(backup, "utf8")).toBe(before);
        if (process.platform !== "win32")
          expect((await stat(backup)).mode & 0o777).toBe(0o600);
        expect(await readFile(`${f.settings}.rea.backup`, "utf8")).toBe(
          original,
        );
      }
      const calls = (await readFile(f.log, "utf8")).trim().split("\n");
      expect(calls.map((line) => JSON.parse(line))).toEqual(
        Array.from({ length: 2 }, () => [
          "add-mcp",
          "fixture-server --mcp",
          "--name",
          "rea",
          "-y",
          "-g",
        ]),
      );
    }
  },
);

cliTest(
  "default registration refuses invalid settings and unavailable backups before the runner",
  async ({ cli }) => {
    for (const initial of [
      "broken JSON\n",
      "null\n",
      '{"amp.mcpServers":[]}\n',
      original,
    ]) {
      const f = await fixture(initial);
      if (initial === original) await mkdir(`${f.settings}.rea.backup`);
      for (const output of [[], ["--json"]]) {
        const result = await cli.run({
          arguments: ["mcp", "add", ...output],
          cwd: f.home,
          environment: f.environment,
          timeoutMs: 20_000,
        });
        expect(result.exitCode).toBe(1);
        expect(result.stdout).toContain("VALIDATION_ERROR");
        if (output.length > 0)
          expect(JSON.parse(result.stdout)).toMatchObject({
            code: "VALIDATION_ERROR",
          });
        expect(await readFile(f.settings, "utf8")).toBe(initial);
        expect(await readFile(f.log, "utf8")).toBe("");
        expect(await readdir(f.directory)).toEqual(
          initial === original
            ? ["settings.json", "settings.json.rea.backup"]
            : ["settings.json"],
        );
      }
    }
  },
);

cliTest(
  "non-Amp selections, command values and discovery do not touch Amp settings",
  async ({ cli }) => {
    const f = await fixture("broken JSON\n");
    for (const selection of [
      ["--agent", "claude-code"],
      ["--agent=claude-code"],
      ["--agent", "cursor", "--agent", "claude-code"],
      ["--command", "--agent", "amp", "--agent", "claude-code"],
      ["-c", "--agent", "amp", "--agent", "claude-code"],
    ]) {
      const result = await cli.run({
        arguments: ["mcp", "add", ...selection, "--json"],
        cwd: f.home,
        environment: f.environment,
        timeoutMs: 20_000,
      });
      expect(result.exitCode, result.stdout).toBe(0);
      expect(await readFile(f.settings, "utf8")).toBe("broken JSON\n");
      expect(await readdir(f.directory)).toEqual(["settings.json"]);
    }
    const calls = (await readFile(f.log, "utf8")).trim().split("\n");
    expect(calls).toHaveLength(5);
    for (const line of calls) expect(JSON.parse(line)).toContain("claude-code");
    await writeFile(f.log, "");
    for (const flag of [
      "--help",
      "-h",
      "--llms",
      "--llms-full",
      "--schema",
      "--version",
    ]) {
      const result = await cli.run({
        arguments: ["mcp", "add", flag, "--json"],
        cwd: f.home,
        environment: f.environment,
        timeoutMs: 20_000,
      });
      expect(result.exitCode).toBe(flag === "--schema" ? 1 : 0);
      expect(result.stdout).not.toContain("VALIDATION_ERROR");
      expect(await readFile(f.settings, "utf8")).toBe("broken JSON\n");
      expect(await readdir(f.directory)).toEqual(["settings.json"]);
    }
    expect(await readFile(f.log, "utf8")).toBe("");
  },
);

cliTest(
  "default runner failure retains the original settings and failure status",
  async ({ cli }) => {
    for (const output of [[], ["--json"]]) {
      const f = await fixture(original);
      const result = await cli.run({
        arguments: ["mcp", "add", ...output],
        cwd: f.home,
        environment: { ...f.environment, REA_TEST_RUNNER_FAIL: "1" },
        timeoutMs: 20_000,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("MCP_ADD_FAILED");
      expect(result.stdout).not.toContain("VALIDATION_ERROR");
      expect(result.stdout).not.toContain("Registered rea");
      expect(result.stderr).not.toContain("backup retained");
      expect(await readFile(f.settings, "utf8")).toBe(original);
      expect(await readFile(`${f.settings}.rea.backup`, "utf8")).toBe(original);
      expect((await readFile(f.log, "utf8")).trim().split("\n")).toHaveLength(
        1,
      );
    }
  },
);

cliTest(
  "timing globals cannot bypass Amp preservation or validation",
  async ({ cli }) => {
    const cases = [
      ["--no-timings", "mcp", "add"],
      ["--timings=false", "mcp", "add", "--json"],
      ["mcp", "--timings=true", "add"],
      ["mcp", "add", "--agent", "--no-timings", "amp", "--json"],
      ["mcp", "add", "--agent", "--timings=false", "amp"],
    ];
    for (const arguments_ of cases) {
      const f = await fixture(original);
      const run = () =>
        cli.run({
          arguments: arguments_,
          cwd: f.home,
          environment: f.environment,
          timeoutMs: 20_000,
        });
      const registered = await run();
      expect(registered.exitCode, registered.stdout).toBe(0);
      expect(
        JSON.parse(await readFile(f.settings, "utf8"))["amp.mcpServers"].rea
          .env,
      ).toEqual({ KEEP_ME: "1" });
      expect(await readFile(`${f.settings}.rea.backup`, "utf8")).toBe(original);
      await writeFile(f.settings, "broken JSON\n");
      await writeFile(f.log, "");
      const rejected = await run();
      expect(rejected.exitCode).toBe(1);
      expect(rejected.stdout).toContain("VALIDATION_ERROR");
      expect(await readFile(f.settings, "utf8")).toBe("broken JSON\n");
      expect(await readFile(f.log, "utf8")).toBe("");
      expect(await readFile(`${f.settings}.rea.backup`, "utf8")).toBe(original);
    }
    const f = await fixture("broken JSON\n");
    for (const arguments_ of [
      [
        "--no-timings",
        "mcp",
        "add",
        "--agent",
        "--timings=false",
        "claude-code",
      ],
      ["--timings=false", "mcp", "add", "--help"],
    ]) {
      const result = await cli.run({
        arguments: arguments_,
        cwd: f.home,
        environment: f.environment,
        timeoutMs: 20_000,
      });
      expect(result.exitCode, result.stdout).toBe(0);
      expect(await readFile(f.settings, "utf8")).toBe("broken JSON\n");
      expect(await readdir(f.directory)).toEqual(["settings.json"]);
    }
    const calls = (await readFile(f.log, "utf8")).trim().split("\n");
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]!)).toContain("claude-code");
  },
);

it("timing splitting matches Incur after output values and before the terminator", () => {
  for (const flag of [
    "--timings",
    "--no-timings",
    "--timings=false",
    "--timings=true",
    "--timings=other",
  ]) {
    for (const command of [
      [flag, "mcp", "add"],
      ["mcp", "add", "--agent", flag, "amp"],
      ["mcp", "add", "--command", flag],
      ["mcp", "add", "--", flag],
    ]) {
      const expected = Parser.parseGlobals(
        command,
        z.object({ timings: z.boolean().default(false) }),
        undefined,
        { validate: false },
      ).rest;
      expect(splitIncurBuiltinArguments(command).command).toEqual(expected);
      // The builtin output pass consumes this flag-shaped value before globals.
      expect(
        splitIncurBuiltinArguments(["--filter-output", flag, ...command])
          .command,
      ).toEqual(expected);
    }
  }
});

cliTest(
  "expanded discovery values never inspect or back up Amp settings",
  async ({ cli }) => {
    for (const initial of [undefined, "broken JSON\n", original]) {
      const f = await fixture(initial ?? "");
      if (initial === undefined) await rm(f.settings);
      for (const flag of ["--help", "--llms"]) {
        const result = await cli.run({
          arguments: ["mcp", "add", `--command=${flag}`],
          cwd: f.home,
          environment: f.environment,
          timeoutMs: 20_000,
        });
        expect(result.exitCode, result.stdout).toBe(0);
        expect(result.stdout).not.toContain("VALIDATION_ERROR");
        expect(result.stdout).not.toContain("Registered rea");
        expect(result.stdout.length).toBeGreaterThan(0);
        expect(result.stderr).not.toContain("backup retained");
        expect(await readdir(f.directory)).toEqual(
          initial === undefined ? [] : ["settings.json"],
        );
        if (initial !== undefined)
          expect(await readFile(f.settings, "utf8")).toBe(initial);
        expect(await readFile(f.log, "utf8")).toBe("");
      }
    }
  },
);
