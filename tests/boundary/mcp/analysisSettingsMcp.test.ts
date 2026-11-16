import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, expect, it } from "vitest";
import { AnalysisSettings } from "../../../src/application/AnalysisSettings.js";
import { EvidenceMcpServer } from "../../../src/server/EvidenceMcpServer.js";
import { registerServiceTools } from "../../../src/server/serviceToolBindings.js";
import { ToolResultDelivery } from "../../../src/server/ToolResultDelivery.js";
import { silentLogger } from "../../../src/logger.js";

const open: { client: Client; server: EvidenceMcpServer }[] = [];
afterEach(async () => {
  await Promise.all(
    open
      .splice(0)
      .flatMap(({ client, server }) => [client.close(), server.close()]),
  );
});

it("binds runtime settings through the shared table, outside analysis admission", async () => {
  const delivery = new ToolResultDelivery(1024 * 1024);
  const server = new EvidenceMcpServer(
    { name: "settings-test", version: "1" },
    { capabilities: { tools: { listChanged: true } } },
    undefined,
    delivery,
  );
  const settings = new AnalysisSettings({});
  const admitted: string[] = [];
  registerServiceTools(
    server,
    { analysisSettings: { settings, delivery } },
    {
      logger: silentLogger,
      withAdmittedAnalysis: (operationName) => {
        admitted.push(operationName);
        return Promise.reject(new Error("settings entered analysis admission"));
      },
    },
  );
  const client = new Client({ name: "settings-client", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  open.push({ client, server });

  const inspected = await client.callTool({
    name: "inspect_analysis_settings",
    arguments: { settings: ["asar.max_listing_bytes"] },
  });
  expect(inspected.isError).not.toBe(true);
  expect(inspected.structuredContent).toMatchObject({
    scope: "rea-runtime",
    settings: [{ setting: "asar.max_listing_bytes" }],
    constraints: expect.arrayContaining([
      expect.objectContaining({
        control: "REA_MCP_MAX_RESPONSE_BYTES",
        value: delivery.maximumResponseBytes,
      }),
    ]),
  });

  const updated = await client.callTool({
    name: "update_analysis_settings",
    arguments: {
      changes: [
        { setting: "asar.max_listing_bytes", action: "set", value: 4096 },
      ],
    },
  });
  expect(updated.isError).not.toBe(true);
  expect(settings.read().overrides["asar.max_listing_bytes"]).toBe(4096);

  // The workflow validates its own input and names the refused field.
  const refused = await client.callTool({
    name: "update_analysis_settings",
    arguments: { changes: [{ setting: "unknown.setting", action: "set" }] },
  });
  expect(refused.isError).toBe(true);
  expect(JSON.stringify(refused.content)).toContain("invalid_request");
  expect(settings.read().overrides["asar.max_listing_bytes"]).toBe(4096);
  expect(admitted).toEqual([]);
});
