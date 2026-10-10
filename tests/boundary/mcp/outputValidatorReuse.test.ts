import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { expect, it } from "vitest";
import { z } from "zod";

import { toolContract } from "../../../src/contracts/toolContracts.js";
import { toolOutputSchemaWithMetadata } from "../../../src/contracts/toolSchemaMetadata.js";

const advertised = <
  Schema extends z.ZodType<Readonly<Record<string, unknown>>>,
>(
  schema: Schema,
): Schema =>
  toolOutputSchemaWithMetadata({
    ...toolContract("binary_session"),
    outputSchema: schema,
  });

const connect = async (server: McpServer, client: Client): Promise<void> => {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
};

it("validates changed schemas after catalog refreshes and availability changes", async () => {
  const client = new Client({ name: "output-reuse-test", version: "1" });
  const server = new McpServer({ name: "output-reuse-fixture", version: "1" });
  const schema = advertised(z.strictObject({ state: z.literal("ready") }));
  let state = "ready";
  const selected = server.registerTool(
    "selected",
    { inputSchema: z.strictObject({}), outputSchema: schema },
    () => ({ content: [], structuredContent: { state } }),
  );
  server.registerTool(
    "equivalent",
    { inputSchema: z.strictObject({}), outputSchema: schema },
    () => ({ content: [], structuredContent: { state: "ready" } }),
  );
  try {
    await connect(server, client);
    await client.listTools();
    expect(
      (await client.callTool({ name: "selected" })).structuredContent,
    ).toEqual({
      state: "ready",
    });
    await client.listTools();
    await client.callTool({ name: "equivalent" });

    selected.update({
      outputSchema: advertised(z.strictObject({ state: z.literal("updated") })),
    });
    state = "updated";
    await client.listTools();
    expect(
      (await client.callTool({ name: "selected" })).structuredContent,
    ).toEqual({
      state: "updated",
    });
    selected.disable();
    const unavailable = await client.listTools();
    expect(unavailable.tools.some((tool) => tool.name === "selected")).toBe(
      false,
    );
    await expect(client.callTool({ name: "selected" })).rejects.toThrow(
      /not found|disabled/iu,
    );
    await client.callTool({ name: "equivalent" });
    selected.enable();
    await client.listTools();
    await client.callTool({ name: "selected" });
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
});

it("uses the new server's schema after reconnecting the client", async () => {
  const client = new Client({ name: "output-reconnect-test", version: "1" });
  const servers: McpServer[] = [];
  try {
    for (const state of ["first", "second"]) {
      const server = new McpServer({ name: `fixture-${state}`, version: "1" });
      servers.push(server);
      server.registerTool(
        "selected",
        {
          inputSchema: z.strictObject({}),
          outputSchema: advertised(z.strictObject({ state: z.literal(state) })),
        },
        () => ({ content: [], structuredContent: { state } }),
      );
      await connect(server, client);
      await client.listTools();
      expect(
        (await client.callTool({ name: "selected" })).structuredContent,
      ).toEqual({ state });
      await client.close();
      await server.close();
    }
  } finally {
    await Promise.allSettled([
      client.close(),
      ...servers.map((server) => server.close()),
    ]);
  }
});
