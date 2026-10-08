import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { createTestBinarySession } from "../../fixtures/binarySession.js";
import type { BinarySession } from "../../../src/application/binary/BinarySession.js";
import { observed } from "../../fixtures/analysisExecution.js";
import { createServer } from "../../../src/server/createServer.js";

/** Owned MCP SDK session shared by application workflow scenarios. */
export interface ApplicationMcpHarness {
  readonly client: Client;
  readonly session: BinarySession;
  readonly close: () => Promise<void>;
}

/** Connect application workflows through the production MCP registration. */
export async function createApplicationMcpHarness(): Promise<ApplicationMcpHarness> {
  const session = createTestBinarySession(() => ({
    execute: () => Promise.resolve(observed(null)),
    close: () => Promise.resolve(),
  }));
  const server = createServer(session, session);
  const client = new Client({
    name: "application-workflow-test",
    version: "1",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    client,
    session,
    close: async () => {
      await Promise.all([client.close(), server.close(), session.close()]);
    },
  };
}
