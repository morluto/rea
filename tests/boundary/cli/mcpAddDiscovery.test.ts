import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect } from "vitest";
import { z } from "zod";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { registrationEnvironment } from "../../support/cli/registrationEnvironment.js";

cliTest(
  "packaged mcp add advertises named schemas without changing settings",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-mcp-discovery-");
    const path = join(home, ".config", "amp", "settings.json");
    const environment = await registrationEnvironment(home);
    const run = (arguments_: readonly string[]) =>
      cli.run({
        arguments: arguments_,
        cwd: home,
        environment,
      });
    const schema = await run([
      "mcp",
      "add",
      "--agent",
      "amp",
      "--schema",
      "--json",
    ]);
    expect(schema.exitCode, schema.stderr).toBe(0);
    const named = z
      .object({
        inputSchema: z.record(z.string(), z.unknown()),
        outputSchema: z.record(z.string(), z.unknown()),
      })
      .parse(schema.json);
    expect(named.inputSchema.$schema).toBe(
      "https://json-schema.org/draft/2020-12/schema",
    );
    expect(named.outputSchema.$schema).toBe(
      "https://json-schema.org/draft/2020-12/schema",
    );
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    const input = ajv.compile(named.inputSchema);
    const output = ajv.compile(named.outputSchema);
    expect(input({ agent: ["amp"] }), JSON.stringify(input.errors)).toBe(true);
    expect(input({ agent: "amp" })).toBe(false);
    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
    for (const format of ["csv", "tsv"]) {
      const result = await run([
        "mcp",
        "add",
        "--agent",
        "amp",
        "--schema",
        "--format",
        format,
        "--filter-output",
        "clients",
        "--columns",
        "client",
      ]);
      expect(result.exitCode).toBe(1);
      expect(result.json).toMatchObject({
        error: { code: "UNSUPPORTED_OUTPUT_COMBINATION" },
      });
      await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
    }
    const invalidFormat = await run([
      "mcp",
      "add",
      "--agent",
      "amp",
      "--format",
      "--schema",
    ]);
    expect(invalidFormat.exitCode).toBe(1);
    expect(invalidFormat.stdout).not.toContain("inputSchema");
    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
    await mkdir(join(home, ".config", "amp"), { recursive: true });
    const original = '{"existing":true}\n';
    await writeFile(path, original);
    for (const flag of ["--schema", "--version", "--help"]) {
      const result = await run(["mcp", "add", "--agent", "amp", flag]);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(await readFile(path, "utf8")).toBe(original);
    }
    const registered = await run(["mcp", "add", "--agent", "amp", "--json"]);
    expect(registered.exitCode, registered.stderr).toBe(0);
    expect(output(registered.json), JSON.stringify(output.errors)).toBe(true);
    expect(registered.json).toMatchObject({
      ok: true,
      clients: [{ client: "amp", status: "configured" }],
    });
    expect(
      JSON.parse(await readFile(path, "utf8"))["amp.mcpServers"].rea,
    ).toBeDefined();
  },
);

cliTest(
  "mcp add applies output controls to its registration document",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-mcp-output-");
    const environment = await registrationEnvironment(home);
    const run = (arguments_: readonly string[]) =>
      cli.run({
        arguments: arguments_,
        cwd: home,
        environment,
      });
    const filtered = await run([
      "mcp",
      "add",
      "--agent",
      "amp",
      "--json",
      "--filter-output",
      "ok",
    ]);
    expect(filtered.exitCode, filtered.stderr).toBe(0);
    expect(filtered.json).toBe(true);
    const schema = await run([
      "mcp",
      "add",
      "--schema",
      "--json",
      "--filter-output",
      "outputSchema.type",
    ]);
    expect(schema.exitCode, schema.stderr).toBe(0);
    expect(schema.json).toEqual({ outputSchema: { type: "object" } });
    const failure = await run([
      "mcp",
      "add",
      "--agent",
      "not-a-client",
      "--json",
      "--filter-output",
      "message",
    ]);
    expect(failure.exitCode).toBe(1);
    expect(failure.json).toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.any(String),
      fieldErrors: [{ path: "agent" }],
    });
    const path = join(home, ".config", "amp", "settings.json");
    await writeFile(path, "{malformed");
    const partial = await run([
      "mcp",
      "add",
      "--agent",
      "amp",
      "--json",
      "--filter-output",
      "ok",
    ]);
    expect(partial.exitCode).toBe(1);
    expect(partial.json).toMatchObject({
      ok: false,
      clients: [
        {
          client: "amp",
          status: "failed",
          error: { reason: expect.any(String) },
        },
      ],
    });
    await writeFile(path, "{}");
    const counted = await run([
      "mcp",
      "add",
      "--agent",
      "amp",
      "--token-count",
    ]);
    expect(counted.exitCode, counted.stderr).toBe(0);
    expect(counted.stdout.trim()).toMatch(/^\d+$/u);
    const windowed = await run([
      "mcp",
      "add",
      "--agent",
      "amp",
      "--token-limit",
      "2",
    ]);
    expect(windowed.exitCode, windowed.stderr).toBe(0);
    expect(windowed.stdout).toMatch(
      /\[truncated: showing tokens 0–2 of \d+\]/u,
    );
  },
);
