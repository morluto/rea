import { currentClientRegistrationCommand } from "../../../src/application/ClientRegistrationIdentity.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect } from "vitest";
import { z } from "zod";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { registrationEnvironment } from "../../support/cli/registrationEnvironment.js";
import { mcpRegistrationReportSchema } from "../../../src/contracts/mcpRegistration.js";

const ompConfigurationSchema = z.object({
  mcpServers: z.object({
    rea: z.object({ command: z.string(), args: z.array(z.string()) }),
  }),
});

cliTest.skipIf(process.platform !== "win32")(
  "mcp add blocks an implicit MSIX-private launcher before writing client files",
  async ({ processes }) => {
    const home = await createTestTempDirectory("rea-msix-mcp-add-");
    const environment = await registrationEnvironment(home, {
      CLAUDE_CONFIG_DIR: home,
    });
    const isolatedConfig = join(home, ".claude.json");
    const installed = join(home, "installed", "rea.mjs");
    const privateEntry = join(
      home,
      "localappdata",
      "Packages",
      "Fixture_123",
      "LocalCache",
      "rea.mjs",
    );
    const original = '{"mcpServers":{"other":{"command":"unchanged"}}}\n';
    const launcher = `import ${JSON.stringify(pathToFileURL(resolve("scripts/rea.mjs")).href)};\n`;
    for (const entry of [installed, privateEntry]) {
      await mkdir(dirname(entry), { recursive: true });
      await writeFile(entry, launcher);
    }
    await writeFile(isolatedConfig, original);
    const run = (entry: string, args: readonly string[] = []) =>
      processes.run(
        process.execPath,
        [entry, "mcp", "add", "--agent", "claude-code", "--json", ...args],
        {
          cwd: home,
          env: environment,
        },
      );

    const blocked = await run(privateEntry);
    expect(blocked.exitCode, blocked.stderr).toBe(1);
    expect(JSON.parse(blocked.stdout)).toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining(
        "inside the private storage of MSIX package Fixture_123",
      ),
      fieldErrors: [expect.objectContaining({ path: "command" })],
    });
    expect(await readFile(isolatedConfig, "utf8")).toBe(original);
    await expect(
      readFile(`${isolatedConfig}.rea.backup`, "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const allowed = await run(installed);
    expect(allowed.exitCode, allowed.stderr).toBe(0);
    expect(JSON.parse(await readFile(isolatedConfig, "utf8"))).toMatchObject({
      mcpServers: {
        rea: { command: process.execPath, args: [installed, "mcp"] },
        other: { command: "unchanged" },
      },
    });
    expect(await readFile(`${isolatedConfig}.rea.backup`, "utf8")).toBe(
      original,
    );

    const explicit = await run(privateEntry, [
      "--command",
      '"custom executable" mcp',
    ]);
    expect(explicit.exitCode, explicit.stderr).toBe(0);
    expect(JSON.parse(await readFile(isolatedConfig, "utf8"))).toMatchObject({
      mcpServers: { rea: { command: "custom executable", args: ["mcp"] } },
    });
  },
);

const controlledRunnerFixture = async (home: string) => {
  const bin = join(home, "bin");
  const script = join(home, "runner-fixture.cjs");
  const log = join(home, "runner-calls.jsonl");
  await mkdir(bin);
  await writeFile(log, "");
  await writeFile(
    script,
    `const { appendFileSync } = require("node:fs");
appendFileSync(process.env.REA_TEST_RUNNER_LOG, JSON.stringify({
  runner: process.argv[2],
  arguments: process.argv.slice(3),
  home: process.env.HOME,
  npm_command: process.env.npm_command,
  user_agent: process.env.npm_config_user_agent,
}) + "\\n");
console.log("controlled runner fixture");
`,
  );
  for (const runner of ["npx", "bunx", "pnpx"]) {
    await writeFile(
      join(bin, process.platform === "win32" ? `${runner}.cmd` : runner),
      process.platform === "win32"
        ? `@echo off\r\n"%REA_TEST_NODE%" "%REA_TEST_RUNNER_SCRIPT%" ${runner} %*\r\n`
        : `#!/bin/sh\nexec "$REA_TEST_NODE" "$REA_TEST_RUNNER_SCRIPT" ${runner} "$@"\n`,
      { mode: 0o700 },
    );
  }
  return {
    log,
    environment: {
      PATH: [bin, process.env.PATH ?? ""].join(delimiter),
      REA_TEST_NODE: process.execPath,
      REA_TEST_RUNNER_SCRIPT: script,
      REA_TEST_RUNNER_LOG: log,
    },
  };
};

// Package runners set these variables for the bin they launch from a temporary cache.
// Decoy runners record any accidental acquisition; setup retains its launch identity.
for (const { runner, userAgent } of [
  { runner: "npx", userAgent: "npm/10.9.0 node/v24.11.0 linux x64" },
  { runner: "bunx", userAgent: "bun/1.4.2 npm/? node/v26.3.0 linux x64" },
] as const) {
  cliTest(
    `${runner} setup binds the selected installation without invoking another runner`,
    async ({ cli }) => {
      const home = await createTestTempDirectory("rea-package-runner-");
      const controlledRunner = await controlledRunnerFixture(home);
      const environment = await registrationEnvironment(home, {
        ...controlledRunner.environment,
        npm_command: "exec",
        npm_config_user_agent: userAgent,
      });
      const run = (arguments_: readonly string[]) =>
        cli.run({
          arguments: arguments_,
          cwd: home,
          environment,
        });
      const setup = await run([
        "setup",
        "--client",
        "omp",
        "--no-skill",
        "--yes",
        "--json",
      ]);
      expect(setup.exitCode).toBe(0);
      expect(setup.json).toMatchObject({ status: "ready" });
      expect(setup.json).not.toHaveProperty("prewarm");
      const configuration = ompConfigurationSchema.parse(
        JSON.parse(
          await readFile(join(home, ".omp", "agent", "mcp.json"), "utf8"),
        ),
      );
      const { command, args } = configuration.mcpServers.rea;
      expect([command, ...args]).toEqual(
        currentClientRegistrationCommand({
          entrypointPath: resolve("scripts/rea.mjs"),
          environment,
        }),
      );
      const registration = await run([
        "mcp",
        "add",
        "--agent",
        "amp",
        "--json",
      ]);
      expect(registration.exitCode, registration.stderr).toBe(0);
      const registered = mcpRegistrationReportSchema.parse(registration.json);
      expect([registered.command, ...registered.args]).toEqual([
        command,
        ...args,
      ]);
      expect(registered.clients).toMatchObject([
        { client: "amp", status: "configured" },
      ]);
      // Doctor also reports Amp, whose table row mcp add registered through.
      const doctor = await run(["doctor", "--client", "omp", "--json"]);
      expect(doctor.json).toMatchObject({
        identity: {
          registrations: [
            { client: "amp", state: "aligned" },
            { client: "omp", state: "aligned" },
          ],
        },
      });
      const repeat = await run([
        "setup",
        "--client",
        "omp",
        "--no-skill",
        "--dry-run",
        "--json",
      ]);
      expect(repeat.json).toMatchObject({ plannedActions: [] });
      expect(await readFile(controlledRunner.log, "utf8")).toBe("");
    },
  );
}
