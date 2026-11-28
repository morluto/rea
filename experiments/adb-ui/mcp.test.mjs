import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { PROPOSED_ADB_UI_ACTION_CONTRACT } from "../../dist/contracts/adb/adbUiToolContracts.js";
import { TOOL_CONTRACTS } from "../../dist/contracts/toolContracts.js";

for (const outputProfile of ["off", "compact"])
  await test(
    `only the unshipped entrypoint advertises the proposed action schema (${outputProfile})`,
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
        env: { ...process.env, REA_MCP_OUTPUT_SCHEMA_PROFILE: outputProfile },
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
      assert.equal(
        Boolean(proposals[0].outputSchema),
        outputProfile === "compact",
      );
      const refused = await client.callTool({
        name: contract.name,
        arguments: {},
      });
      assert.equal(refused.isError, true);
    },
  );
