import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";

import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { analysisViewLayoutEvidence } from "../../fixtures/analysisView.js";

const pageViewError = async (page: { offset: number; limit: number }) => {
  const session = createTestBinarySession(() => {
    throw new Error("inspect_analysis_view must not launch a provider");
  });
  const server = createServer({ kind: "session", session });
  const client = new Client({ name: "exclusive-bound-issues", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return parseMcpToolError(
      await client.callTool({
        name: "inspect_analysis_view",
        arguments: {
          source: { kind: "inline", evidence: analysisViewLayoutEvidence() },
          view: { kind: "page", collection: "sections", ...page },
        },
      }),
    ).error;
  } finally {
    await client.close();
    await server.close();
    await session.close();
  }
};

it("reports an exclusive page limit without naming the rejected value as allowed", async () => {
  const error = await pageViewError({ offset: 0, limit: 0 });
  expect(error).toMatchObject({
    code: "invalid_request",
    details: {
      issues: [
        {
          path: ["view", "limit"],
          reason: "out_of_range",
          message: expect.stringContaining(">0"),
        },
      ],
    },
  });
  expect(JSON.stringify(error)).not.toContain('"minimum":0');
});

it("keeps reporting an inclusive page offset as the minimum", async () => {
  expect(await pageViewError({ offset: -1, limit: 1 })).toMatchObject({
    code: "invalid_request",
    details: {
      issues: [
        { path: ["view", "offset"], reason: "out_of_range", minimum: 0 },
      ],
    },
  });
});
