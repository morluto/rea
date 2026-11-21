import type { Client, Transport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

/** Share an in-flight SDK close, including one started during failed initialization. */
export class VerifierStdioTransport extends StdioClientTransport {}

type VerifierConnection = {
  client: Client;
  transport: Transport;
  definitions: Map<
    string,
    Awaited<ReturnType<Client["listTools"]>>["tools"][number]
  >;
};

/** Own MCP transports from connection through discovery, use, and cleanup retry. */
export function createVerifierMcpOwner(): {
  open(client: Client, transport: Transport): Promise<VerifierConnection>;
  closeConnection(connection: VerifierConnection): Promise<void>;
  close(): Promise<void>;
};
