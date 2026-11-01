import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  closeVerifierResources,
  withVerifierCleanup,
} from "./verifier-cleanup.mjs";

/** Share an in-flight SDK close, including one started during failed initialization. */
export class VerifierStdioTransport extends StdioClientTransport {
  #closing;

  close() {
    if (this.#closing !== undefined) return this.#closing;
    this.#closing = super.close().catch((error) => {
      this.#closing = undefined;
      throw error;
    });
    return this.#closing;
  }
}

/** Own MCP transports from connection through discovery, use, and cleanup retry. */
export function createVerifierMcpOwner() {
  const owned = new Set();
  const closeConnection = async (connection) => {
    await closeVerifierResources([
      () => connection.client.close(),
      () => connection.transport.close(),
    ]);
    owned.delete(connection);
  };
  return {
    async open(client, transport) {
      const connection = { client, transport, definitions: new Map() };
      owned.add(connection);
      try {
        await client.connect(transport);
        connection.definitions = new Map(
          (await client.listTools()).tools.map((tool) => [tool.name, tool]),
        );
        return connection;
      } catch (cause) {
        return withVerifierCleanup(() => {
          throw cause;
        }, [() => closeConnection(connection)]);
      }
    },
    closeConnection,
    close() {
      return closeVerifierResources(
        [...owned].map((connection) => () => closeConnection(connection)),
      );
    },
  };
}
