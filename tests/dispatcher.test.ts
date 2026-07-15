import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
let fixtureRoot: string | undefined;

afterEach(async () => {
  if (fixtureRoot !== undefined) {
    await rm(fixtureRoot, { recursive: true, force: true });
    fixtureRoot = undefined;
  }
});

describe("executable dispatcher", () => {
  it("reserves production MCP routing for bare mode arguments", async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), "rea-dispatcher-"));
    const scripts = join(fixtureRoot, "scripts");
    const dist = join(fixtureRoot, "dist");
    await Promise.all([mkdir(scripts), mkdir(dist)]);
    await Promise.all([
      copyFile("scripts/rea.mjs", join(scripts, "rea.mjs")),
      writeFile(
        join(fixtureRoot, "package.json"),
        JSON.stringify({ type: "module", version: "1.0.0" }),
      ),
      writeFile(
        join(dist, "main.js"),
        'export const runEntrypoint = () => process.stdout.write(JSON.stringify({ adapter: "mcp" }));\n',
      ),
      writeFile(
        join(dist, "cli.js"),
        'export const createCli = () => ({ serve: (args) => process.stdout.write(JSON.stringify({ adapter: "cli", args })) });\n',
      ),
      writeFile(
        join(dist, "cliOutput.js"),
        "export const sanitizeCliOutput = (output) => output;\n",
      ),
    ]);

    const invoke = async (args: readonly string[]): Promise<unknown> => {
      const { stdout } = await execFileAsync(process.execPath, [
        join(scripts, "rea.mjs"),
        ...args,
      ]);
      return JSON.parse(stdout) as unknown;
    };

    await expect(invoke(["mcp"])).resolves.toEqual({ adapter: "mcp" });
    await expect(invoke(["--mcp"])).resolves.toEqual({ adapter: "mcp" });
    await expect(invoke(["mcp", "add"])).resolves.toEqual({
      adapter: "cli",
      args: ["mcp", "add"],
    });
    await expect(invoke(["--mcp", "extra"])).resolves.toEqual({
      adapter: "cli",
      args: ["--mcp", "extra"],
    });
  });

  it("explains how to restore a missing compiled runtime", async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), "rea-dispatcher-"));
    const scripts = join(fixtureRoot, "scripts");
    await mkdir(scripts);
    await Promise.all([
      copyFile("scripts/rea.mjs", join(scripts, "rea.mjs")),
      writeFile(
        join(fixtureRoot, "package.json"),
        JSON.stringify({ type: "module", version: "1.0.0" }),
      ),
    ]);

    for (const args of [["mcp"], ["--help"]]) {
      const execution = execFileAsync(process.execPath, [
        join(scripts, "rea.mjs"),
        ...args,
      ]);
      await expect(execution).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining(
          "REA's compiled runtime is missing. Run `npm ci` in",
        ),
      });
      await expect(execution).rejects.toMatchObject({
        stderr: expect.not.stringContaining("ERR_MODULE_NOT_FOUND"),
      });
    }
  });
});
