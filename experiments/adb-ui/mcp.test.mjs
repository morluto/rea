import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { PROPOSED_ADB_UI_ACTION_CONTRACT } from "../../dist/contracts/adb/adbUiToolContracts.js";
import { TOOL_CONTRACTS } from "../../dist/contracts/toolContracts.js";

test(
  "only the unshipped entrypoint advertises the proposed action schema",
  { timeout: 60_000 },
  async (t) => {
    const contract = PROPOSED_ADB_UI_ACTION_CONTRACT;
    assert.equal(
      TOOL_CONTRACTS.some(({ name }) => name === contract.name),
      false,
    );
    assert.equal(contract.annotations.destructiveHint, true);
    const client = new Client({ name: "ui-proposal-contract", version: "1" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL("./mcp.mjs", import.meta.url))],
      stderr: "pipe",
    });
    transport.stderr?.resume();
    t.after(async () => {
      await client.close();
      await transport.close();
    });
    await client.connect(transport);
    const { tools } = await client.listTools();
    const proposals = tools.filter(({ name }) => name === contract.name);
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].annotations.destructiveHint, true);
    assert(proposals[0].inputSchema.properties.action);
    assert(proposals[0].outputSchema);
    const refused = await client.callTool({
      name: contract.name,
      arguments: {},
    });
    assert.equal(refused.isError, true);
  },
);
