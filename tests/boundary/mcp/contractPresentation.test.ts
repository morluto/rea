import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { isCallToolResult } from "@modelcontextprotocol/server";
import { beforeAll, expect, it, onTestFinished } from "vitest";
import { z } from "zod";

import { BROWSER_TOOL_CONTRACTS } from "../../../src/contracts/browserToolContracts.js";
import { BROWSER_SCENARIO_TOOL_CONTRACTS } from "../../../src/contracts/browserScenarioToolContracts.js";
import { ELECTRON_TOOL_CONTRACTS } from "../../../src/contracts/javascript/electronToolContracts.js";
import { JAVASCRIPT_RUNTIME_OBSERVATION_TOOL_CONTRACTS } from "../../../src/contracts/javascript/javascriptRuntimeObservationToolContracts.js";
import { TOOL_CONTRACTS } from "../../../src/contracts/toolContracts.js";
import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";
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
  presentationOrder: z.array(z.string()),
  catalog: z.array(
    z.looseObject({
      name: z.string(),
      inputSchema: z.record(z.string(), z.unknown()),
      outputSchema: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
  responses: z.array(
    z.object({ name: z.string(), response: z.record(z.string(), z.unknown()) }),
  ),
});

it("preserves advertised schemas and handler meaning when presentation order changes", async () => {
  const ordinary = await createApplicationMcpHarness({
    serverOptions: { environment: {} },
  });
  const { tools: expected } = await ordinary.client
    .listTools()
    .finally(() => ordinary.close());
  const cancellation = new AbortController();
  const command = runOwnedCommand(
    {
      command: process.execPath,
      arguments: [fixture, "reversed"],
      runId: randomUUID(),
      env: {
        ...process.env,
      },
      sweepTokenOwnedProcesses: true,
    },
    {
      // A prepared catalog run needed about 32s on two CPU cores.
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
  const byName = <Tool extends { readonly name: string }>(
    tools: readonly Tool[],
  ) =>
    tools.toSorted((left, right) => left.name.localeCompare(right.name, "en"));
  const reversed = byName(result.catalog);
  expect(result.presentationOrder).toEqual(
    TOOL_CONTRACTS.toReversed().map(({ name }) => name),
  );
  expect(reversed.map(({ name }) => name)).toEqual(
    byName(TOOL_CONTRACTS).map(({ name }) => name),
  );
  expect(reversed).toEqual(byName(expected));
  expect(
    reversed.filter(({ outputSchema }) => outputSchema !== undefined),
  ).toEqual([]);
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
});
