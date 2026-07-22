import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

import { BinarySession } from "../src/application/BinarySession.js";
import { REPLAY_MACHINE_RUN_EXAMPLE } from "../src/contracts/replayMachineExample.js";
import { createServer } from "../src/server/createServer.js";
import { observed } from "./fixtures/analysisExecution.js";

describe("direct replay machine MCP parity", () => {
  it("returns typed journal output and safe validation failures", async () => {
    const session = new BinarySession(() => ({
      execute: () => Promise.resolve(observed(null)),
      close: () => Promise.resolve(),
    }));
    const server = createServer(session, session);
    const client = new Client({ name: "replay-machine-test", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const example = REPLAY_MACHINE_RUN_EXAMPLE;
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: "run_replay_machine",
        arguments: example,
      });
      expect(result).toMatchObject({
        structuredContent: {
          result: {
            schema_version: 1,
            final_state: "complete",
            terminal: true,
            decisions: [{ outcome: "matched", transition_sequence: 0 }],
            transition_journal: [
              {
                transition_id: "accept_callback",
                captured_aliases: [{ name: "token", sensitive: true }],
              },
            ],
          },
        },
      });
      expect(JSON.stringify(result)).not.toContain("opaque");

      const invalid = await client.callTool({
        name: "run_replay_machine",
        arguments: {
          ...example,
          events: [
            {
              protocol: "http",
              connection: "not_applicable",
              at_ms: 0,
              method: null,
              path: "/callback",
              headers: {},
              body: "private-request-body",
            },
          ],
        },
      });
      expect(invalid).toMatchObject({
        isError: true,
        structuredContent: { error: { code: "invalid_request" } },
      });
      expect(JSON.stringify(invalid)).not.toContain("private-request-body");
    } finally {
      await client.close();
      await server.close();
      await session.close();
    }
  });
});
