import type { Client } from "@modelcontextprotocol/client";

import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { mcpTest } from "./mcpFixture.js";

/** A fresh inspection client whose session refuses deep-provider startup. */
export const fileInspectionTest = mcpTest.extend<{ client: Client }>({
  client: async ({ mcp }, use) => {
    const session = createTestBinarySession(() => {
      throw new Error("File inspection must not start a deep provider");
    });
    try {
      const client = await mcp.connect(
        createServer({ kind: "session", session }),
      );
      await use(client);
    } finally {
      const result = await session.close();
      if (!result.ok) throw result.error;
    }
  },
});
