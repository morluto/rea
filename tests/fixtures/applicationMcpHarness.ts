import { ok as resultOk } from "../../src/domain/result.js";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { createTestBinarySession } from "./binarySession.js";
import type { BinarySession } from "../../src/application/binary/BinarySession.js";
import { observed } from "./analysisExecution.js";
import { createServer } from "../../src/server/createServer.js";

/** Owned MCP SDK session shared by application workflow scenarios. */
export interface ApplicationMcpHarness {
  readonly client: Client;
  readonly session: BinarySession;
  readonly close: () => Promise<void>;
}

/** Connect application workflows through the production MCP registration. */
export async function createApplicationMcpHarness(
  options: {
    readonly session?: BinarySession;
    readonly serverOptions?: Parameters<typeof createServer>[1];
  } = {},
): Promise<ApplicationMcpHarness> {
  const session =
    options.session ??
    createTestBinarySession(() => ({
      execute: () => Promise.resolve(observed(null)),
      close: () => Promise.resolve(resultOk(null)),
    }));
  const server = createServer(
    { kind: "session", session },
    options.serverOptions,
  );
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
