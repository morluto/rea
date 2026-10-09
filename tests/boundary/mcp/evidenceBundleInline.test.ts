import { ok as resultOk } from "../../../src/domain/result.js";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";

import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { observed } from "../../fixtures/analysisExecution.js";
import { createEvidence } from "../../../src/domain/evidence.js";
import { createServer } from "../../../src/server/createServer.js";

it("returns the complete session Evidence bundle in the tool result", async () => {
  const evidence = createEvidence(
    undefined,
    { id: "fixture", name: "Fixture", version: "1" },
    { operation: "observe", parameters: {}, result: { value: "seen" } },
  );
  const session = createTestBinarySession(() => ({
    execute: () => Promise.resolve(observed(null)),
    close: () => Promise.resolve(resultOk(null)),
  }));
  expect(session.recordEvidence(evidence).ok).toBe(true);
  const server = createServer(session, session);
  const client = new Client({ name: "inline-evidence-bundle", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({
      name: "get_evidence_bundle",
      arguments: {},
    });
    expect(result.structuredContent).toMatchObject({
      result: {
        records: [
          {
            evidence_id: evidence.evidence_id,
            normalized_result: { value: "seen" },
          },
        ],
      },
    });
  } finally {
    await Promise.allSettled([client.close(), server.close(), session.close()]);
  }
});
