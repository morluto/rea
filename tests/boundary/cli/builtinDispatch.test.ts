import { expect, it } from "vitest";
import { z } from "zod";
import { estimateTokenCount } from "tokenx";

import { registerCliCommand } from "../../../src/cli/commandRegistry.js";
import { createCliShell } from "../../../src/cli/cliShell.js";
import { renderFailure } from "../../../src/cli/outputEnvelope.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { serveInProcessCli } from "../../support/cli/serveInProcessCli.js";

const shell = () =>
  createCliShell({
    selectedEnvironment: {},
    registrations: [
      {
        module: {},
        registration: {
          analysis: false,
          load: async () => ({}),
          register: (_module, { cli }) => {
            registerCliCommand(cli, "fixture", {
              options: z.object({ value: z.string().optional() }),
              run: ({ options }) => ({
                selected: options.value,
                "--mcp": "preserved",
              }),
            });
          },
        },
      },
    ],
  });

it.for([
  ["fixture", "--mcp", "--help", "--json"],
  ["fixture", "--mcp", "--schema", "--json"],
  ["mcp", "add", "--mcp", "--json"],
  ["unknown", "--mcp", "--json"],
])("returns MCP startup guidance for %j", async (arguments_) => {
  const reply = await serveInProcessCli(shell(), arguments_);
  expect(reply.exitCode).toBe(1);
  expect(JSON.parse(reply.stdout)).toMatchObject({
    code: "MCP_MODE_REMOVED",
    message: expect.stringContaining("rea mcp"),
    cta: { commands: [{ command: "rea mcp" }] },
  });
});

it("preserves an option value spelled like the retired flag", async () => {
  const reply = await serveInProcessCli(shell(), [
    "fixture",
    "--value=--mcp",
    "--json",
  ]);
  expect(reply.exitCode).toBe(0);
  expect(JSON.parse(reply.stdout)).toEqual({
    selected: "--mcp",
    "--mcp": "preserved",
  });
});

it("preserves a consumed output value instead of treating it as an MCP flag", async () => {
  const reply = await serveInProcessCli(shell(), [
    "fixture",
    "--filter-output",
    "--mcp",
    "--json",
  ]);
  expect(reply.exitCode).toBe(0);
  expect(JSON.parse(reply.stdout)).toBe("preserved");
});

cliTest("refuses per-command MCP through the public CLI", async ({ cli }) => {
  for (const arguments_ of [
    ["doctor", "--mcp", "--json"],
    ["mcp", "doctor", "--mcp", "--json"],
    ["--mcp", "extra", "--json"],
  ]) {
    const reply = await cli.run({ arguments: arguments_ });
    expect(reply.exitCode, JSON.stringify(arguments_)).toBe(1);
    expect(reply.json).toMatchObject({
      code: "MCP_MODE_REMOVED",
      cta: { commands: [{ command: "rea mcp" }] },
    });
  }
});

cliTest.skipIf(process.platform === "win32")(
  "keeps retired MCP diagnostics useful on a terminal",
  async ({ cli }) => {
    const reply = await cli.run({
      arguments: ["doctor", "--mcp"],
      terminal: true,
    });
    expect(reply.exitCode).toBe(1);
    expect(reply.stdout).toContain("Error (MCP_MODE_REMOVED)");
    expect(reply.stdout).toContain("rea mcp");
  },
);

it.for([false, true])(
  "counts the selected refusal document including recovery and envelope (%s)",
  (fullOutput) => {
    const render = (tokenCount: boolean) =>
      renderFailure(
        { code: "MCP_MODE_REMOVED", message: "Use rea mcp" },
        { command: "doctor", duration: "0ms" },
        {
          description: "Suggested command:",
          commands: [{ command: "rea mcp" }],
        },
        {
          format: "json",
          human: false,
          fullOutput,
          tokenCount,
          tokenLimit: undefined,
          tokenOffset: undefined,
        },
      );
    expect(Number(render(true))).toBe(
      estimateTokenCount(render(false).trimEnd()),
    );
  },
);

cliTest.skipIf(process.platform === "win32")(
  "applies token controls to terminal MCP refusals",
  async ({ cli }) => {
    const count = await cli.run({
      arguments: ["doctor", "--mcp", "--token-count"],
      terminal: true,
    });
    expect(count.exitCode).toBe(1);
    expect(count.stdout.trim()).toMatch(/^\d+$/u);
    const window = await cli.run({
      arguments: ["doctor", "--mcp", "--token-limit", "0"],
      terminal: true,
    });
    expect(window.exitCode).toBe(1);
    expect(window.stdout).toMatch(/\[truncated: showing tokens 0–0 of \d+\]/u);
    expect(window.stdout).not.toContain("Per-command");
  },
);

cliTest(
  "redacts retired MCP diagnostics before token windows",
  async ({ cli }) => {
    const sensitive = "--mcp has been removed. Use";
    const run = (declarations: readonly string[]) =>
      cli.run({
        arguments: [
          "analyze-javascript-application",
          "--mcp",
          ...declarations,
          "--token-limit",
          "22",
        ],
      });
    const control = await run([]);
    const redacted = await run([`--sensitive-value=${sensitive}`]);
    for (const reply of [control, redacted]) {
      expect(reply.exitCode).toBe(1);
      expect(reply.stdout).toContain("MCP_MODE_REMOVED");
      expect(reply.stdout).toContain("[truncated:");
    }
    expect(control.stdout).toContain("--mcp");
    expect(control.stdout).not.toContain(sensitive);
    expect(redacted.stdout).not.toContain("--mcp");
    expect(redacted.stdout).toContain("[REDACTED]");
  },
);

cliTest(
  "refuses bare CSV/TSV discovery requests through the public CLI without suggesting row flags",
  async ({ cli }) => {
    for (const [arguments_, flag, format] of [
      [["--llms", "--format", "csv"], "--llms", "csv"],
      [["--llms-full", "--format", "tsv"], "--llms-full", "tsv"],
      [["doctor", "--schema", "--format", "csv"], "--schema", "csv"],
    ] as const) {
      const reply = await cli.run({ arguments: arguments_ });
      expect(reply.exitCode).toBe(1);
      expect(reply.json).toMatchObject({
        ok: false,
        error: {
          code: "UNSUPPORTED_OUTPUT_COMBINATION",
          message: expect.stringMatching(
            new RegExp(`${flag}.*--format ${format}`, "u"),
          ),
        },
      });
      expect(reply.stdout).not.toContain("--filter-output");
    }
  },
);

it.for([false, true])(
  "clamps dispatcher refusal token windows at the end (%s)",
  (fullOutput) => {
    const output = renderFailure(
      { code: "COMMAND_NOT_FOUND", message: "Unknown command" },
      { command: "fixture", duration: "0ms" },
      undefined,
      {
        format: "json",
        human: false,
        fullOutput,
        tokenCount: false,
        tokenLimit: 5,
        tokenOffset: 1000,
      },
    );
    expect(output).toMatch(/\[truncated: showing tokens (\d+)–\1 of \1\]/u);
    expect(output).not.toContain("nextOffset");
    expect(output).not.toContain("Unknown command");
  },
);
