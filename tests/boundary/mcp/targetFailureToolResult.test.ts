import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { machoImage } from "../../../src/artifacts/apple/MachoImage.fixture.js";
import { AnalysisTargetFailureError } from "../../../src/domain/analysisErrorCore.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { mcpTest } from "../../support/mcp/mcpFixture.js";

// The SDK flattens anything a handler throws into one text block, and JSON-RPC
// errors are for protocol faults. A target failure a provider throws must
// still reach the client as an `isError` tool result carrying the projection.
mcpTest(
  "returns a thrown target failure as a tool result, not a JSON-RPC error",
  async ({ mcp }) => {
    const root = await createTestTempDirectory("rea-target-failure-mcp-");
    const path = join(root, "target.bin");
    await writeFile(
      path,
      machoImage({ cpu: { type: 0x0100000c, subtype: 0 }, wide: true }),
    );
    const session = createTestBinarySession(() => {
      throw new AnalysisTargetFailureError("open_binary", path, {
        kind: "malformed",
        format: "macho",
        detail: "load command runs past the image",
        offset: 32,
      });
    });
    try {
      const client = await mcp.connect(
        createServer({ kind: "session", session }),
      );
      // A JSON-RPC error would reject this call.
      const response = await client.callTool({
        name: "open_binary",
        arguments: { path },
      });
      expect(parseMcpToolError(response).error).toMatchObject({
        code: "unsupported_target",
        retry: "none",
        details: {
          path,
          failure_kind: "malformed",
          format: "macho",
          offset: 32,
        },
      });
      // The session survives the refusal and keeps answering requests.
      await expect(client.ping()).resolves.toBeDefined();
    } finally {
      await session.close();
    }
  },
);
