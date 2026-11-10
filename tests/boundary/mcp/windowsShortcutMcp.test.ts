import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { BINARY_DIAGNOSTICS_TOOL_CONTRACTS } from "../../../src/contracts/native/binaryDiagnosticsToolContracts.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { powershellHiddenIconSpoofShortcut } from "../../fixtures/binaryDiagnostics/windowsShortcut.js";
import { advertisedMcpToolSchemas } from "../../fixtures/advertisedMcpTool.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { mcpTest } from "../../support/mcp/mcpFixture.js";

const shortcutContract = (() => {
  const contract = BINARY_DIAGNOSTICS_TOOL_CONTRACTS.find(
    (item) => item.name === "inspect_windows_shortcut",
  );
  if (contract === undefined)
    throw new Error("Missing inspect_windows_shortcut contract");
  return contract;
})();

mcpTest(
  "advertises inspect_windows_shortcut and reads Shell Link facts",
  async ({ mcp }) => {
    const session = createTestBinarySession(() => {
      throw new Error("Shell Link inspection must not start a deep provider");
    });
    const client = await mcp.connect(
      createServer({ kind: "session", session }),
    );
    try {
      const {
        toolDefinition: advertised,
        ajv,
        outputSchema,
      } = await advertisedMcpToolSchemas(client, "inspect_windows_shortcut");
      expect(advertised?.annotations).toMatchObject({
        readOnlyHint: false,
        idempotentHint: true,
      });
      const root = await createTestTempDirectory("rea-windows-shortcut-mcp-");
      const path = join(root, "shortcut.lnk");
      await writeFile(path, powershellHiddenIconSpoofShortcut());
      const response = await client.callTool({
        name: "inspect_windows_shortcut",
        arguments: { path },
      });
      expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
      expect(
        ajv.validate(outputSchema, response.structuredContent),
        JSON.stringify(ajv.errors),
      ).toBe(true);
      const evidence = shortcutContract.outputSchema.parse(
        response.structuredContent,
      );
      expect(evidence.normalized_result.header.clsid).toBe(
        "00021401-0000-0000-C000-000000000046",
      );
      expect(evidence.normalized_result.coverage.status).toBe("complete");
      const relative = await client.callTool({
        name: "inspect_windows_shortcut",
        arguments: { path: "shortcut.lnk" },
      });
      expect(relative.isError).toBe(true);
      expect(parseMcpToolError(relative).error).toMatchObject({
        code: "invalid_request",
        details: { operation: "inspect_windows_shortcut" },
      });
    } finally {
      await session.close();
    }
  },
);
