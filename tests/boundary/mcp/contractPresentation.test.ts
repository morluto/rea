import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { isCallToolResult } from "@modelcontextprotocol/server";
import { beforeAll, expect, it, onTestFinished } from "vitest";
import { z } from "zod";

import { BROWSER_TOOL_CONTRACTS } from "../../../src/contracts/browserToolContracts.js";
import { BROWSER_SCENARIO_TOOL_CONTRACTS } from "../../../src/contracts/browserScenarioToolContracts.js";
import { ELECTRON_TOOL_CONTRACTS } from "../../../src/contracts/javascript/electronToolContracts.js";
import { JAVASCRIPT_RUNTIME_OBSERVATION_TOOL_CONTRACTS } from "../../../src/contracts/javascript/javascriptRuntimeObservationToolContracts.js";
import { GENERATED_MCP_TOOL_CATALOG } from "../../fixtures/mcpToolCatalog.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import {
  prepareOwnedCommand,
  runOwnedCommand,
} from "../../../src/process/OwnedCommand.js";
import { resolveSwiftcCompileTimeoutMs } from "../../../src/process/DarwinProcessRunTokenReader.js";

beforeAll(
  () => prepareOwnedCommand(),
  Math.min(2_147_483_647, resolveSwiftcCompileTimeoutMs() + 30_000),
);

const fixture = fileURLToPath(
  new URL("../../fixtures/contractPresentation.mjs", import.meta.url),
);

it.skipIf(process.platform === "win32")(
  "cleans up a child that ignores its deadline signal",
  async () => {
    await expect(
      runOwnedCommand(
        {
          command: process.execPath,
          arguments: [
            "-e",
            'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000);',
          ],
          runId: randomUUID(),
          sweepTokenOwnedProcesses: true,
        },
        { timeoutMs: 1_000, diagnosticBytes: 1024 },
      ),
    ).rejects.toMatchObject({
      reason: "timeout",
      cleanupFailure: null,
      snapshot: { stdout: { text: "ready\n" } },
    });
  },
);
const resultSchema = z.object({
  catalog: z.array(
    z.object({
      name: z.string(),
      inputSchema: z.record(z.string(), z.unknown()),
      outputSchema: z.record(z.string(), z.unknown()),
    }),
  ),
  responses: z.array(
    z.object({ name: z.string(), response: z.record(z.string(), z.unknown()) }),
  ),
});

it(
  "preserves full advertised schemas and handler meaning when presentation order changes",
  { timeout: 70_000 },
  async () => {
    const cancellation = new AbortController();
    const command = runOwnedCommand(
      {
        command: process.execPath,
        arguments: [fixture, "reversed"],
        runId: randomUUID(),
        env: {
          ...process.env,
          REA_MCP_INPUT_SCHEMA_PROFILE: "full",
          REA_MCP_OUTPUT_SCHEMA_PROFILE: "full",
        },
        sweepTokenOwnedProcesses: true,
      },
      {
        // A prepared full/full catalog run needs about 32s on two CPU cores.
        timeoutMs: 60_000,
        diagnosticBytes: 16 * 1024 * 1024,
      },
      { signal: cancellation.signal },
    );
    onTestFinished(async () => {
      cancellation.abort();
      await command;
    });
    const snapshot = await command;
    const stdout = snapshot.stdout.text;
    const result = resultSchema.parse(JSON.parse(stdout));
    expect(result.catalog).toHaveLength(GENERATED_MCP_TOOL_CATALOG.length);
    expect(new Set(result.catalog.map(({ name }) => name))).toEqual(
      new Set(GENERATED_MCP_TOOL_CATALOG.map(({ name }) => name)),
    );
    for (const advertised of result.catalog) {
      const canonical = GENERATED_MCP_TOOL_CATALOG.find(
        ({ name }) => name === advertised.name,
      );
      expect(advertised.inputSchema).toEqual(canonical?.inputSchema);
      expect(advertised.outputSchema).toEqual(canonical?.outputSchema);
    }
    expect(result.responses.map(({ name }) => name).sort()).toEqual(
      [
        ...BROWSER_TOOL_CONTRACTS,
        ...BROWSER_SCENARIO_TOOL_CONTRACTS,
        ...ELECTRON_TOOL_CONTRACTS.filter(
          ({ name }) => name !== "analyze_javascript_application",
        ),
        ...JAVASCRIPT_RUNTIME_OBSERVATION_TOOL_CONTRACTS,
      ]
        .map(({ name }) => name)
        .sort(),
    );
    for (const { name, response } of result.responses) {
      if (!isCallToolResult(response))
        throw new Error(`Invalid tools/call fixture result for ${name}`);
      if (name === "reconcile_javascript_runtime") {
        expect(response.isError).not.toBe(true);
        expect(response.structuredContent).toMatchObject({
          operation: name,
        });
      } else {
        expect(response.isError, name).toBe(true);
        expect(parseMcpToolError(response), name).toMatchObject({
          error: { details: { operation: name } },
        });
      }
    }
  },
);
