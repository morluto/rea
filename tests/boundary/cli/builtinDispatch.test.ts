import { expect, it } from "vitest";
import { z } from "zod";
import { estimateTokenCount } from "tokenx";

import { registerCliCommand } from "../../../src/cli/commandRegistry.js";
import { createCliShell } from "../../../src/cli/cliShell.js";
import { serveDiscovery } from "../../../src/cli/discovery.js";
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
  ["fixture", "--mcp", "--json"],
  ["--mcp", "fixture", "--json"],
  ["fixture", "--mcp", "--help", "--json"],
  ["fixture", "--mcp", "--schema", "--json"],
  ["mcp", "add", "--mcp", "--json"],
  ["mcp", "doctor", "--mcp", "--json"],
  ["unknown", "--mcp", "--json"],
])("does not delegate a retired MCP invocation: %j", async (arguments_) => {
  let stdout = "";
  let exitCode = 0;
  const answered = serveDiscovery(
    shell(),
    arguments_,
    {
      stdout: (text) => {
        stdout += text;
      },
      exit: (code) => {
        exitCode = code;
      },
    },
    { variables: {}, platform: process.platform },
  );
  expect(
    answered,
    "an unanswered invocation would reach the dispatcher",
  ).toBeDefined();
  await answered;
  const reply = { stdout, exitCode };
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
    ["doctor", "--mcp", "--json", "--full-output"],
  ]) {
    const reply = await cli.run({ arguments: arguments_ });
    expect(reply.exitCode, JSON.stringify(arguments_)).toBe(1);
    const failure = { code: "MCP_MODE_REMOVED" };
    const cta = { commands: [{ command: "rea mcp" }] };
    expect(reply.json).toMatchObject(
      arguments_.includes("--full-output")
        ? { ok: false, error: failure, meta: { command: "doctor", cta } }
        : { ...failure, cta },
    );
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
    const reply = await cli.run({
      arguments: [
        "analyze-javascript-application",
        "--mcp",
        "--sensitive-value=--mcp",
        "--token-limit",
        "12",
      ],
    });
    expect(reply.exitCode).toBe(1);
    expect(reply.stdout).not.toContain("--mcp");
    expect(reply.stdout).toContain("MCP_MODE_REMOVED");
  },
);
