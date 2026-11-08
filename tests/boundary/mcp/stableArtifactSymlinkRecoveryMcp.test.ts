import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { mcpTest } from "../../support/mcp/mcpFixture.js";

mcpTest.skipIf(process.platform === "win32")(
  "offers one resolved-file retry for sibling stable-artifact inspectors",
  async ({ mcp }) => {
    const root = await createTestTempDirectory("rea-stable-recovery-mcp-");
    const target = join(root, "target.bin");
    const selected = join(root, "selected");
    await writeFile(target, "carrier");
    await symlink(target, selected);
    const session = createTestBinarySession(() => {
      throw new Error("Target-free inspection must not start a deep provider");
    });
    try {
      const client = await mcp.connect(
        createServer({ kind: "session", session }),
      );
      for (const name of [
        "inspect_rust_binary",
        "inspect_elf_notes",
        "inspect_devicetree",
        "inspect_sqlite_database",
      ]) {
        const response = await client.callTool({
          name,
          arguments: { path: selected },
        });
        const diagnostic = parseMcpToolError(response).error;
        expect(diagnostic.remediation.action, name).toContain(target);
        expect(diagnostic, name).not.toHaveProperty("recovery");
      }
      const captureResponse = await client.callTool({
        name: "inspect_web_network_capture",
        arguments: {
          capture_path: selected,
          format: "har",
          sensitive_values: ["unrelated marked value"],
        },
      });
      const captureError = parseMcpToolError(captureResponse).error;
      expect(captureError.remediation.action).toContain(target);
      expect(captureError).not.toHaveProperty("recovery");
    } finally {
      const closed = await session.close();
      if (!closed.ok) throw closed.error;
    }
  },
);
