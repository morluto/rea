import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Parser, z } from "incur";
import { decode } from "@toon-format/toon";

import { mcpRegistrationReportSchema } from "../../../src/contracts/mcpRegistration.js";
import { splitIncurBuiltinArguments } from "../../../src/cliBuiltinArguments.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { registrationEnvironment } from "../../support/cli/registrationEnvironment.js";

const fixture = async (initial: string) => {
  const home = await createTestTempDirectory("rea-default-amp-");
  const directory = join(home, ".config", "amp");
  const settings = join(directory, "settings.json");
  await mkdir(directory, { recursive: true });
  await writeFile(settings, initial);
  return {
    home,
    directory,
    settings,
    environment: await registrationEnvironment(home),
  };
};
const original = `${JSON.stringify({
  "amp.mcpServers": {
    rea: { command: "old", env: { KEEP_ME: "1" } },
    peer: { command: "peer" },
  },
  theme: "dark",
})}\n`;
const report = (stdout: string, json: boolean) =>
  mcpRegistrationReportSchema.parse(json ? JSON.parse(stdout) : decode(stdout));

cliTest(
  "packaged default registration preserves Amp settings and repeats without another backup",
  async ({ cli }) => {
    for (const json of [false, true]) {
      const f = await fixture(original);
      const run = () =>
        cli.run({
          arguments: [
            "mcp",
            "add",
            "--command",
            "fixture-server --mcp",
            ...(json ? ["--json"] : []),
          ],
          cwd: f.home,
          environment: f.environment,
          timeoutMs: 20_000,
        });
      const first = await run();
      expect(first.exitCode, first.stderr).toBe(0);
      const outcome = report(first.stdout, json).clients.find(
        (client) => client.client === "amp",
      );
      expect(outcome?.status).toBe("configured");
      if (outcome?.status !== "configured" || outcome.backup_path === undefined)
        throw Error("Missing Amp backup receipt.");
      expect(await readFile(outcome.backup_path, "utf8")).toBe(original);
      if (process.platform !== "win32")
        expect((await stat(outcome.backup_path)).mode & 0o777).toBe(0o600);
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
      const before = await stat(f.settings);
      const repeated = await run();
      expect(repeated.exitCode, repeated.stderr).toBe(0);
      expect(
        report(repeated.stdout, json).clients.find(
          (client) => client.client === "amp",
        ),
      ).toMatchObject({ status: "unchanged" });
      expect((await stat(f.settings)).ino).toBe(before.ino);
      expect(repeated.stderr).not.toContain("backup retained");
      expect(await readdir(f.directory)).toEqual([
        "settings.json",
        "settings.json.rea.backup",
      ]);
    }
  },
);

cliTest(
  "packaged default registration reports an Amp failure without claiming its old entry changed",
  async ({ cli }) => {
    for (const initial of [
      "broken JSON\n",
      "null\n",
      '{"amp.mcpServers":[]}\n',
      original,
    ]) {
      const f = await fixture(initial);
      if (initial === original) await mkdir(`${f.settings}.rea.backup`);
      for (const json of [false, true]) {
        const result = await cli.run({
          arguments: ["mcp", "add", ...(json ? ["--json"] : [])],
          cwd: f.home,
          environment: f.environment,
          timeoutMs: 20_000,
        });
        expect(result.exitCode).toBe(1);
        const document = report(result.stdout, json);
        expect(document.ok).toBe(false);
        expect(
          document.clients.find((client) => client.client === "amp"),
        ).toMatchObject({
          status: "failed",
          error: { code: expect.any(String), message: expect.any(String) },
        });
        expect(await readFile(f.settings, "utf8")).toBe(initial);
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
  "unselected malformed Amp settings do not block named clients or discovery",
  async ({ cli }) => {
    const f = await fixture("broken JSON\n");
    for (const arguments_ of [
      ["mcp", "add", "--agent=cursor", "--agent", "claude-code", "--json"],
      ["mcp", "add", "--llms"],
      ["mcp", "add", "--llms-full"],
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
  },
);

cliTest(
  "timing globals retain registration and owned-document failure semantics",
  async ({ cli }) => {
    for (const arguments_ of [
      ["--no-timings", "mcp", "add"],
      ["--timings=false", "mcp", "add", "--json"],
      ["mcp", "--timings=true", "add"],
      ["mcp", "add", "--agent", "--no-timings", "amp", "--json"],
      ["mcp", "add", "--agent", "--timings=false", "amp"],
    ]) {
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
      const rejected = await run();
      expect(rejected.exitCode).toBe(1);
      expect(
        report(rejected.stdout, arguments_.includes("--json")).clients.find(
          (client) => client.client === "amp",
        ),
      ).toMatchObject({ status: "failed" });
      expect(await readFile(f.settings, "utf8")).toBe("broken JSON\n");
      expect(await readFile(`${f.settings}.rea.backup`, "utf8")).toBe(original);
    }
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
      expect(
        splitIncurBuiltinArguments(["--filter-output", flag, ...command])
          .command,
      ).toEqual(expected);
    }
  }
});

cliTest(
  "equals-form flag-shaped command values remain launcher data",
  async ({ cli }) => {
    const f = await fixture(original);
    for (const command of ["--help", "--llms"]) {
      const result = await cli.run({
        arguments: [
          "mcp",
          "add",
          "--agent",
          "amp",
          `--command=${command}`,
          "--json",
        ],
        cwd: f.home,
        environment: f.environment,
        timeoutMs: 20_000,
      });
      expect(result.exitCode, result.stdout).toBe(0);
      expect(report(result.stdout, true)).toMatchObject({
        command,
        args: [],
        ok: true,
      });
      expect(
        JSON.parse(await readFile(f.settings, "utf8"))["amp.mcpServers"].rea,
      ).toMatchObject({ command, args: [], env: { KEEP_ME: "1" } });
    }
  },
);

cliTest(
  "invalid registration preserves settings and explicit sensitive-value handling",
  async ({ cli }) => {
    const f = await fixture(original);
    const before = await stat(f.settings);
    for (const options of [
      ["--bogus"],
      ["--agents", "claude-code"],
      ["--unknown=declared-literal", "--sensitive-value", "declared-literal"],
      ["--unknown=API_SECRET_ordinary-evidence"],
    ]) {
      const result = await cli.run({
        arguments: ["mcp", "add", ...options, "--json"],
        cwd: f.home,
        environment: f.environment,
        timeoutMs: 20_000,
      });
      expect(result.exitCode, result.stderr).toBe(1);
      expect(result.json).toMatchObject({
        code: "VALIDATION_ERROR",
        fieldErrors: [expect.objectContaining({ path: "arguments" })],
      });
      if (options.includes("--sensitive-value")) {
        expect(result.stdout + result.stderr).not.toContain("declared-literal");
        expect(result.stdout).toContain("[REDACTED]");
      } else expect(result.stdout).toContain(options[0]);
      expect(await readFile(f.settings, "utf8")).toBe(original);
      expect((await stat(f.settings)).mtimeMs).toBe(before.mtimeMs);
      expect(await readdir(f.directory)).toEqual(["settings.json"]);
    }
  },
);
