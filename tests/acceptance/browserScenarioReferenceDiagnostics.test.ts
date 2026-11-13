import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect } from "vitest";
import { browserScenarioReferences } from "../fixtures/browserScenarioReferences.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { parseMcpToolError } from "../fixtures/mcpToolError.js";
import { cliTest } from "../support/cli/cliFixture.js";

cliTest.for([
  ["CLI", "query"],
  ["CLI", "storage"],
  ["CLI", "session-storage"],
  ["CLI", "cookie"],
  ["stdio MCP", "query"],
  ["stdio MCP", "storage"],
  ["stdio MCP", "session-storage"],
  ["stdio MCP", "cookie"],
] as const)(
  "reports undeclared references through %s for a wide %s list",
  { timeout: 60_000 },
  async ([surface, placement], { cli }) => {
    const home = await createTestTempDirectory("rea-scenario-reference-");
    const input = browserScenarioReferences(placement, 130_000);
    input.browser.executable_path = join(home, "missing-chromium");
    input.secrets = [];
    const expected = {
      code: "invalid_request",
      category: "invalid_input",
      retryable: false,
      details: {
        operation: "capture_browser_scenario",
        issues: expect.arrayContaining([
          expect.objectContaining({
            path: ["secrets"],
            reason: "invalid_value",
            message: "Secret reference token is not declared",
          }),
        ]),
      },
    };
    if (surface === "CLI") {
      const path = join(home, "scenario.json");
      await writeFile(path, JSON.stringify(input));
      // A real file argument avoids the host argv limit for this valid JSON.
      const result = await cli.run({
        arguments: ["capture-browser-scenario", path, "--json"],
        environment: { HOME: home, REA_LOG_LEVEL: "silent" },
        timeoutMs: 30_000,
      });
      expect(result.exitCode).toBe(1);
      expect(result.json).toMatchObject(expected);
      return;
    }
    const client = new Client({
      name: "scenario-reference-diagnostics",
      version: "1",
    });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("scripts/rea.mjs"), "mcp"],
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        REA_LOG_LEVEL: "silent",
        // This workload explicitly selects admission above the 1024 default.
        REA_MCP_MAX_INPUT_ELEMENTS: "1000000",
      },
      stderr: "pipe",
    });
    transport.stderr?.on("data", () => undefined);
    try {
      await client.connect(transport);
      const result = await client.callTool({
        name: "capture_browser_scenario",
        arguments: input,
      });
      expect(result.isError).toBe(true);
      expect(parseMcpToolError(result).error).toMatchObject(expected);
      await expect(client.ping()).resolves.toEqual({});
    } finally {
      await Promise.all([client.close(), transport.close()]);
    }
  },
);
