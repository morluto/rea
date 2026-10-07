import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";

import { createServer } from "../../../src/server/createServer.js";
import {
  createCacheProvider,
  createTestBinarySession,
} from "../../fixtures/binarySession.js";

describe("per-request client capability reporting", () => {
  it.each([
    [{ elicitation: {} }, true, false],
    [{ elicitation: { form: {} } }, true, false],
    [{ elicitation: { url: {} } }, false, true],
    [{ elicitation: { form: {}, url: {} } }, true, true],
    [{}, false, false],
  ] as const)(
    "reports the negotiated capability %j",
    async (capabilities, form, url) => {
      const session = createTestBinarySession(createCacheProvider([]));
      const server = createServer(session, session);
      const client = new Client({ name: "capabilities-test", version: "1" });
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      try {
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        const status = await client.callTool({
          name: "binary_session",
          arguments: {},
          _meta: {
            [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
            [CLIENT_INFO_META_KEY]: { name: "capabilities-test", version: "1" },
            [CLIENT_CAPABILITIES_META_KEY]: capabilities,
          },
        });
        expect(status.structuredContent).toMatchObject({
          result: {
            client_features: { elicitation_form: form, elicitation_url: url },
          },
        });
      } finally {
        await Promise.allSettled([
          client.close(),
          server.close(),
          session.close(),
        ]);
      }
    },
  );
});
