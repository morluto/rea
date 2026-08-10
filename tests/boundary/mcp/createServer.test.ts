import { describe, expect } from "vitest";

import { observed as ok } from "../../fixtures/analysisExecution.js";
import { mcpTest } from "../../support/mcp/mcpFixture.js";
import { createServer } from "../../../src/server/createServer.js";

const analysis = {
  execute: () => Promise.resolve(ok(null)),
};

describe("MCP server composition", () => {
  mcpTest("does not advertise unavailable session tools", async ({ mcp }) => {
    const server = createServer(analysis);
    const client = await mcp.connect(server, {
      name: "composition-test",
      version: "1.0.0",
    });
    expect(client.getInstructions()).not.toContain("open_binary");
    const names = (await client.listTools()).tools.map(({ name }) => name);
    expect(names).not.toContain("compare_managed_members");
    expect(names).not.toContain("plan_managed_runtime_correlation");
  });
});
