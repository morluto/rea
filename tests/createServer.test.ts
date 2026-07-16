import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

import { observed as ok } from "./fixtures/analysisExecution.js";
import { createServer } from "../src/server/createServer.js";

const analysis = {
  execute: () => Promise.resolve(ok(null)),
};

describe("MCP server composition", () => {
  it("constructs independent MCP server instances", () => {
    expect(createServer(analysis)).not.toBe(createServer(analysis));
  });

  it("does not advertise unavailable session tools", async () => {
    const server = createServer(analysis);
    const client = new Client({ name: "composition-test", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    expect(client.getInstructions()).not.toContain("open_binary");
    const names = (await client.listTools()).tools.map(({ name }) => name);
    expect(names).not.toContain("compare_managed_members");
    expect(names).not.toContain("plan_managed_runtime_correlation");
    await client.close();
    await server.close();
  });
});
