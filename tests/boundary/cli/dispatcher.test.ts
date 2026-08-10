import { copyFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect } from "vitest";

import { workspaceCliTest } from "../../support/cli/workspaceCliFixture.js";

describe("executable dispatcher", () => {
  workspaceCliTest(
    "reserves production MCP routing for bare mode arguments",
    async ({ processes, workspace }) => {
      const scripts = await workspace.mkdir("scripts");
      await workspace.mkdir("dist");
      await Promise.all([
        copyFile("scripts/rea.mjs", join(scripts, "rea.mjs")),
        workspace.write(
          "package.json",
          JSON.stringify({ type: "module", version: "1.0.0" }),
        ),
        workspace.write(
          "dist/main.js",
          'export const runEntrypoint = () => process.stdout.write(JSON.stringify({ adapter: "mcp" }));\n',
        ),
        workspace.write(
          "dist/cli.js",
          'export const createCli = () => ({ serve: (args) => process.stdout.write(JSON.stringify({ adapter: "cli", args })) });\n',
        ),
        workspace.write(
          "dist/cliOutput.js",
          "export const sanitizeCliOutput = (output) => output; export const validateCliOutputArguments = () => ({ ok: true }); export const renderCliOutputArgumentError = () => '';\n",
        ),
        workspace.write(
          "dist/mcpDoctor.js",
          'export const runProductionMcpDoctorCli = (args) => Promise.resolve({ output: JSON.stringify({ adapter: "mcp-doctor", args }), exitCode: 0 });\n',
        ),
      ]);

      const invoke = async (args: readonly string[]): Promise<unknown> => {
        const { exitCode, stdout } = await processes.run(
          process.execPath,
          [join(scripts, "rea.mjs"), ...args],
          { cwd: workspace.root },
        );
        expect(exitCode).toBe(0);
        return JSON.parse(stdout) as unknown;
      };

      await expect(invoke(["mcp"])).resolves.toEqual({ adapter: "mcp" });
      await expect(invoke(["--mcp"])).resolves.toEqual({ adapter: "mcp" });
      await expect(invoke(["mcp", "doctor", "--json"])).resolves.toEqual({
        adapter: "mcp-doctor",
        args: ["--json"],
      });
      await expect(invoke(["mcp", "add"])).resolves.toEqual({
        adapter: "cli",
        args: ["mcp", "add"],
      });
      await expect(invoke(["--mcp", "extra"])).resolves.toEqual({
        adapter: "cli",
        args: ["--mcp", "extra"],
      });
    },
  );

  workspaceCliTest(
    "explains how to restore a missing compiled runtime",
    async ({ processes, workspace }) => {
      const scripts = await workspace.mkdir("scripts");
      await Promise.all([
        copyFile("scripts/rea.mjs", join(scripts, "rea.mjs")),
        workspace.write(
          "package.json",
          JSON.stringify({ type: "module", version: "1.0.0" }),
        ),
      ]);

      for (const args of [["mcp"], ["mcp", "doctor"], ["--help"]]) {
        const result = await processes.run(
          process.execPath,
          [join(scripts, "rea.mjs"), ...args],
          { cwd: workspace.root },
        );
        expect(result).toMatchObject({
          exitCode: 1,
          stderr: expect.stringContaining(
            "REA's compiled runtime is missing. Run `npm ci` in",
          ),
        });
        expect(result).toMatchObject({
          stderr: expect.not.stringContaining("ERR_MODULE_NOT_FOUND"),
        });
      }
    },
  );
});
