import { expect } from "vitest";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { mcpTest } from "../../support/mcp/mcpFixture.js";

mcpTest(
  "keeps the field of a rejected inspect_unity_addressables input",
  async ({ mcp }) => {
    const session = createTestBinarySession(() => {
      throw new Error(
        "Addressables catalog inspection must not start a deep provider",
      );
    });
    const client = await mcp.connect(
      createServer({ kind: "session", session }),
    );
    try {
      const response = await client.callTool({
        name: "inspect_unity_addressables",
        arguments: { path: 123 },
      });
      // The service owns validation, so the field and its expected type survive.
      expect(parseMcpToolError(response).error).toMatchObject({
        code: "invalid_request",
        details: {
          operation: "inspect_unity_addressables",
          issues: [
            { path: ["path"], reason: "invalid_type", expected: "string" },
          ],
        },
      });
    } finally {
      await session.close();
    }
  },
);
