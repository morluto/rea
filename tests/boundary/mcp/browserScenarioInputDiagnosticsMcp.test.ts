import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Ajv2020 } from "ajv/dist/2020.js";
import { join, resolve } from "node:path";
import { afterAll, expect } from "vitest";
import { z } from "zod";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { createMcpSchemaValidation } from "../../fixtures/mcpSchemaValidation.js";

// Compile SDK output validators for the tools a test calls, not the whole catalog.
const schemaValidation = createMcpSchemaValidation();
afterAll(() => schemaValidation.clear());

const scenarios = [
  {
    name: "undeclared secret references",
    fullSchemaValid: true,
    issue: {
      path: ["secrets"],
      reason: "invalid_value",
      message: "Secret reference pw is not declared",
    },
    actions: [
      {
        step_id: "pw",
        action: "fill",
        locator: { kind: "css", selector: "#pw" },
        value: { source: "secret", secret_id: "pw" },
      },
    ],
  },
  {
    name: "duplicate action step IDs",
    fullSchemaValid: true,
    issue: {
      path: ["actions"],
      reason: "invalid_value",
      message: "Action step IDs must be unique",
    },
    actions: [
      { step_id: "wait", action: "wait_for_timeout", duration_ms: 1 },
      { step_id: "wait", action: "wait_for_timeout", duration_ms: 1 },
    ],
  },
  {
    name: "overflowing wait duration",
    fullSchemaValid: false,
    issue: {
      path: ["actions", 0, "duration_ms"],
      reason: "out_of_range",
      maximum: 2_147_483_647,
    },
    actions: [
      {
        step_id: "wait",
        action: "wait_for_timeout",
        duration_ms: 2_147_483_648,
      },
    ],
  },
  {
    name: "overflowing action deadline",
    fullSchemaValid: false,
    issue: {
      path: ["actions", 0, "timeout_ms"],
      reason: "out_of_range",
      maximum: 2_147_483_647,
    },
    actions: [
      {
        step_id: "visible",
        action: "wait_for",
        locator: { kind: "css", selector: "#btn" },
        state: "visible",
        timeout_ms: 2_147_483_648,
      },
    ],
  },
] as const;

cliTest.for(["full", "compact"] as const)(
  "projects browser scenario input diagnostics over stdio MCP (%s)",
  async (profile, { cli }) => {
    const home = await createTestTempDirectory(
      "rea-browser-scenario-mcp-home-",
    );
    const client = new Client(
      {
        name: "browser-scenario-input-diagnostics",
        version: "1",
      },
      { jsonSchemaValidator: schemaValidation },
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("scripts/rea.mjs"), "mcp"],
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        REA_LOG_LEVEL: "silent",
        REA_MCP_INPUT_SCHEMA_PROFILE: profile,
      },
      stderr: "pipe",
    });
    transport.stderr?.on("data", () => undefined);

    try {
      await client.connect(transport);
      const tool = (await client.listTools()).tools.find(
        ({ name }) => name === "capture_browser_scenario",
      );
      if (tool === undefined) throw new Error("Missing browser scenario tool");
      const validate = new Ajv2020({
        strict: false,
        validateFormats: false,
      }).compile(tool.inputSchema);

      for (const scenario of scenarios) {
        const input = {
          browser: {
            mode: "launch",
            executable_path: join(home, "missing-chromium"),
          },
          start_url: { url: "http://127.0.0.1:1/", query: [] },
          actions: scenario.actions,
          secrets: [],
        };
        expect(
          validate(input),
          `${scenario.name}: ${JSON.stringify(validate.errors)}`,
        ).toBe(scenario.fullSchemaValid || profile === "compact");

        const cliResult = await cli.run({
          arguments: [
            "capture-browser-scenario",
            JSON.stringify(input),
            "--json",
          ],
          environment: { HOME: home, REA_LOG_LEVEL: "silent" },
        });
        expect(cliResult.exitCode).toBe(1);
        const cliDiagnostic = z
          .record(z.string(), z.unknown())
          .parse(cliResult.json);
        expect(typeof cliDiagnostic.error).toBe("string");
        delete cliDiagnostic.error;
        expect(cliDiagnostic).toMatchObject({
          code: "invalid_request",
          category: "invalid_input",
          retryable: false,
          remediation: {
            action: expect.stringContaining("capture_browser_scenario"),
          },
          recovery: {
            kind: "inspect_input_contract",
            operation: "capture_browser_scenario",
          },
          details: {
            operation: "capture_browser_scenario",
            issues: [scenario.issue],
          },
        });

        const mcpResult = await client.callTool({
          name: tool.name,
          arguments: input,
        });
        expect(mcpResult.structuredContent).toBeUndefined();
        const mcpError = parseMcpToolError(mcpResult).error;
        if (scenario.fullSchemaValid) expect(mcpError).toEqual(cliDiagnostic);
        else {
          // The SDK validates the canonical schema before invoking the handler.
          expect(mcpError).toMatchObject({
            code: "invalid_request",
            category: "invalid_input",
            retryable: false,
            recovery: { kind: "inspect_input_contract", operation: tool.name },
            details: {
              operation: tool.name,
              issues: [scenario.issue],
            },
          });
        }
        await expect(client.ping()).resolves.toEqual({});
      }
    } finally {
      await Promise.all([client.close(), transport.close()]);
    }
  },
);
