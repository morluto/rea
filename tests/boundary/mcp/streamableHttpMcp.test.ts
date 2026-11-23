import {
  Client,
  StreamableHTTPClientTransport,
  type StreamableHTTPClientTransportOptions,
} from "@modelcontextprotocol/client";
import { describe, expect, onTestFinished } from "vitest";
import { once } from "node:events";

import { advertisedMcpToolSchemas } from "../../fixtures/advertisedMcpTool.js";
import { expectForeignHostRefused } from "../../support/http/rawRequest.js";
import {
  startMcpHttpProcess,
  startListeningProcess,
} from "../../support/mcp/streamableHttpProcess.js";
import { processTest } from "../../support/process/processFixture.js";
import { assertAdvertisedMcpContracts } from "./mcpContractHarness.js";
import { createMcpSchemaValidation } from "../../fixtures/mcpSchemaValidation.js";
import { phaseArrival } from "../../support/lifecycleHarness.js";

const openSession = async (
  url: URL,
  name: string,
  options?: StreamableHTTPClientTransportOptions,
) => {
  const transport = new StreamableHTTPClientTransport(url, options);
  const client = new Client(
    { name, version: "1" },
    { jsonSchemaValidator: createMcpSchemaValidation() },
  );
  onTestFinished(() => client.close());
  await client.connect(transport);
  expect(transport.sessionId).toEqual(expect.any(String));
  const { toolDefinition } = await advertisedMcpToolSchemas(
    client,
    "binary_session",
  );
  assertAdvertisedMcpContracts(["binary_session"], [toolDefinition]);
  return { transport, client, toolDefinition };
};

/** The shared target answers with its identity only while its providers are still open. */
const expectIdentity = async ({
  client,
  toolDefinition,
}: Awaited<ReturnType<typeof openSession>>): Promise<void> => {
  const identity = await client.callTool(
    { name: "binary_session", arguments: {} },
    { toolDefinition },
  );
  expect(identity.isError).toBeFalsy();
  expect(identity.structuredContent).toMatchObject({
    result: {
      server_identity: { package: { version: expect.any(String) } },
    },
  });
};

describe("rea mcp --http", () => {
  processTest(
    "keeps hot/cold visibility within its HTTP session and refreshes named contracts",
    async ({ processes }) => {
      const started = await startListeningProcess(
        processes,
        ["mcp", "--http", "--port", "0"],
        // Sessions validate advertised output schemas, which default to off.
        {
          REA_MCP_TOOL_CATALOG_PROFILE: "hot-cold",
        },
      );
      const listenerExit = once(started.child, "exit");
      const stream = phaseArrival<Response>();
      const first = await openSession(started.url, "hot-cold-first", {
        fetch: async (url, init) => {
          const response = await fetch(url, init);
          if (init?.method === "GET") stream.arrive(response);
          return response;
        },
      });
      const initialNames = (await first.client.listTools()).tools.map(
        ({ name }) => name,
      );
      expect(initialNames).not.toContain("inspect_analysis_view");
      expect(initialNames).not.toContain("list_unknowns");
      const changed = phaseArrival();
      first.client.setNotificationHandler(
        "notifications/tools/list_changed",
        () => changed.arrive(),
      );
      expect((await stream.reached(listenerExit, "HTTP event stream")).ok).toBe(
        true,
      );
      const discovered = await first.client.callTool({
        name: "discover_tools",
        arguments: { names: ["list_unknowns"] },
      });
      expect(discovered.isError).not.toBe(true);
      await changed.reached(listenerExit, "catalog change notification");
      const { toolDefinition } = await advertisedMcpToolSchemas(
        first.client,
        "list_unknowns",
      );
      expect(
        (
          await first.client.callTool(
            { name: "list_unknowns", arguments: {} },
            { toolDefinition },
          )
        ).isError,
      ).not.toBe(true);
      await first.transport.terminateSession();
      await first.client.close();
      const second = await openSession(started.url, "hot-cold-second");
      expect(
        (await second.client.listTools()).tools.map(({ name }) => name),
      ).toEqual(initialNames);
      await expectIdentity(second);
      await second.transport.terminateSession();
    },
  );

  processTest(
    "serves initialize, tools/list, a tool call and DELETE, then keeps serving later clients",
    async ({ processes }) => {
      const started = await startListeningProcess(
        processes,
        ["mcp", "--http", "--port", "0"],
        {},
      );
      expect(started.url.hostname).toBe("127.0.0.1");
      expect(started.url.pathname).toBe("/mcp");
      let stdout = "";
      started.child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      const first = await openSession(started.url, "streamable-http-boundary");
      await expectIdentity(first);
      await first.transport.terminateSession();
      expect(first.transport.sessionId).toBeUndefined();
      await first.client.close();
      // DELETE ended the session, not the server: the next client's tools still work.
      const second = await openSession(started.url, "next-session");
      await expectIdentity(second);
      // A client that leaves without DELETE does not block the listener: the next initialize replaces it.
      const third = await openSession(started.url, "replacing-session");
      expect(third.transport.sessionId).not.toBe(second.transport.sessionId);
      await expectIdentity(third);
      await expect(expectIdentity(second)).rejects.toThrow("Session not found");
      await second.client.close();
      await third.transport.terminateSession();
      await third.client.close();
      expect(stdout).toBe("");
      expect(started.stderr()).toContain('"transport":"streamable-http"');
      expect(started.stderr()).toContain(
        "MCP HTTP session replaced by a new client",
      );
    },
  );

  processTest(
    "refuses a non-loopback Host header on the loopback bind",
    async ({ processes }) => {
      const { url } = await startMcpHttpProcess(processes);
      const refused = await expectForeignHostRefused(url);
      expect(refused.body).not.toContain("127.0.0.1");
    },
  );
});
