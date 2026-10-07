import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { afterEach, expect } from "vitest";
import { z } from "zod";

import type { BinarySessionPort } from "../../../src/application/binary/BinarySessionPort.js";
import {
  loadOptionalObservationProviders,
  type OptionalObservationFactories,
} from "../../../src/composition/optionalObservationProviders.js";
import {
  TOOL_CONTRACTS,
  toolContract,
} from "../../../src/contracts/toolContracts.js";
import { run } from "../../../src/main.js";
import { createServer } from "../../../src/server/createServer.js";
import { optionalObservationFactories } from "../../fixtures/optionalObservationProviders.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { mcpTest } from "../../support/mcp/mcpFixture.js";

const failedAdapters = [
  ["browserObservation", "list_browser_targets", "rea-cdp-browser"],
  [
    "browserScenarioCapture",
    "capture_browser_scenario",
    "rea-playwright-browser-scenario",
  ],
  ["electronObservation", "list_electron_targets", "rea-cdp-electron"],
  [
    "electronActiveObservation",
    "capture_electron_scenario",
    "rea-playwright-electron-active",
  ],
  [
    "javascriptRuntimeObservation",
    "list_javascript_runtime_targets",
    "rea-v8-inspector",
  ],
] as const;

const resources: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of resources.splice(0).reverse()) await close();
});

const boot = async (factories: OptionalObservationFactories) => {
  const loaded = await loadOptionalObservationProviders(factories);
  let server: McpServer | undefined;
  let session: BinarySessionPort | undefined;
  let shutdown: (() => void) | undefined;
  let resolveClose: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClose = resolve;
  });
  const output: string[] = [];
  const exitCodes: number[] = [];
  expect(
    await run({
      env: {},
      loadOptionalProviders: async () => loaded,
      createServer: (analysis, selectedSession, options) => {
        session = selectedSession;
        // A configured policy cannot hide an actual adapter loading failure.
        return createServer(analysis, selectedSession, {
          ...options,
          availabilityPolicy: () => ({
            processCaptureEnabled: true,
            browserObservationEnabled: true,
            browserScenarioEnabled: true,
            electronObservationEnabled: true,
            electronAutomationEnabled: true,
            v8InspectorObservationEnabled: true,
          }),
        });
      },
      serve: (factory) => {
        const created = factory({ era: "legacy" });
        if (!(created instanceof McpServer))
          throw new Error("Expected the production synchronous MCP factory");
        server = created;
        return {
          close: async () => {
            await server?.close();
            resolveClose?.();
          },
        };
      },
      registerShutdown: (handler) => {
        shutdown = handler;
        return () => {};
      },
      writeStderr: (message) => output.push(message),
      setExitCode: (code) => exitCodes.push(code),
    }),
  ).toBe(0);
  expect(output).toEqual([]);
  if (server === undefined || session === undefined || shutdown === undefined)
    throw new Error("Runtime did not construct the MCP server and session");
  const close = shutdown;
  resources.push(async () => {
    close();
    await closed;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(exitCodes).toEqual([]);
  });
  return { server, session, loaded };
};

mcpTest.for(failedAdapters)(
  "isolates %s and retains successful peers",
  async ([port, operation, providerId], { mcp }) => {
    const calls: string[] = [];
    const failure = `${port} synthetic import failure`;
    const factories = optionalObservationFactories(calls);
    const connected = await boot({
      ...factories,
      [port]: async () => {
        throw new Error(failure);
      },
    });
    expect(connected.loaded.optionalProviderLoadFailures).toEqual({
      [port]: { providerId, reason: failure },
    });
    for (const [peer] of failedAdapters)
      expect(connected.loaded[peer] !== undefined).toBe(peer !== port);
    const client = await mcp.connect(connected.server);
    const names = (await client.listTools()).tools.map(({ name }) => name);
    expect(new Set(names)).toEqual(
      new Set(TOOL_CONTRACTS.map(({ name }) => name)),
    );
    expect(names).toHaveLength(TOOL_CONTRACTS.length);
    const example = toolContract(operation).examples[0];
    if (example === undefined)
      throw new Error(`Missing example for ${operation}`);
    const unavailable = await client.callTool({
      name: operation,
      arguments: example.input,
    });
    expect(unavailable.isError).toBe(true);
    expect(unavailable.structuredContent).toMatchObject({
      error: {
        details: {
          provider_id: providerId,
          operation,
          reason: `Adapter could not load: ${failure}`,
        },
      },
    });
    const status = await client.callTool({
      name: "binary_session",
      arguments: {},
    });
    expect(status.structuredContent).toMatchObject({
      result: {
        tool_availability: expect.arrayContaining([
          expect.objectContaining({
            name: operation,
            available: false,
            reason: "provider_unavailable",
            remediation: expect.stringContaining(failure),
          }),
          expect.objectContaining({
            name: "analyze_javascript_application",
            available: true,
          }),
          expect.objectContaining({
            name: "reconcile_javascript_runtime",
            available: true,
          }),
          expect.objectContaining({
            name:
              port === "electronActiveObservation"
                ? "list_electron_targets"
                : "capture_electron_scenario",
            available: true,
          }),
        ]),
      },
    });
    const healthy =
      port === "javascriptRuntimeObservation"
        ? "list_browser_targets"
        : "list_javascript_runtime_targets";
    const listed = await client.callTool({
      name: healthy,
      arguments:
        healthy === "list_browser_targets"
          ? { cdp_endpoint: "http://127.0.0.1:9222" }
          : { inspector_endpoint: "http://127.0.0.1:9222" },
    });
    expect(listed.isError).not.toBe(true);
    const evidenceId = z
      .object({ evidence: z.object({ evidence_id: z.string() }) })
      .parse(listed.structuredContent).evidence.evidence_id;
    expect(connected.session.evidenceById(evidenceId)?.operation).toBe(healthy);
    expect(calls).toEqual([
      port === "javascriptRuntimeObservation" ? "browser" : "runtime",
    ]);
    const reconciled = await client.callTool({
      name: "reconcile_javascript_runtime",
      arguments: toolContract("reconcile_javascript_runtime").examples[0]
        ?.input,
    });
    expect(reconciled.isError).not.toBe(true);
    if (
      port === "electronObservation" ||
      port === "electronActiveObservation"
    ) {
      const directory = await createTestTempDirectory("rea-optional-static-");
      await writeFile(
        join(directory, "package.json"),
        JSON.stringify({ name: "optional-isolation", main: "index.js" }),
      );
      await writeFile(join(directory, "index.js"), "exports.answer = 42;\n");
      const analyzed = await client.callTool({
        name: "analyze_javascript_application",
        arguments: { input_path: directory, format: "directory" },
      });
      expect(analyzed.isError).not.toBe(true);
      expect(analyzed.structuredContent).toMatchObject({
        evidence: { operation: "analyze_javascript_application" },
      });
    }
    const malformed = await client.callTool({
      name: operation,
      arguments: { unexpected: true },
    });
    expect(malformed.isError).toBe(true);
    expect(JSON.stringify(malformed)).not.toContain(failure);
  },
);

mcpTest(
  "starts with every optional adapter failed and creates fresh connection state",
  async ({ mcp }) => {
    const failed = async (): Promise<never> => {
      throw new Error("all optional adapters unavailable");
    };
    const first = await boot({
      browserObservation: failed,
      browserScenarioCapture: failed,
      electronObservation: failed,
      electronActiveObservation: failed,
      javascriptRuntimeObservation: failed,
    });
    const client = await mcp.connect(first.server);
    expect((await client.listTools()).tools).toHaveLength(
      TOOL_CONTRACTS.length,
    );
    const status = await client.callTool({
      name: "binary_session",
      arguments: {},
    });
    expect(status.isError).not.toBe(true);
    const second = await boot(optionalObservationFactories([]));
    expect(second.loaded.optionalProviderLoadFailures).toEqual({});
    expect(second.session.exportEvidenceBundle().records).toEqual([]);
    expect(second.loaded.browserObservation).toBeDefined();
  },
);
