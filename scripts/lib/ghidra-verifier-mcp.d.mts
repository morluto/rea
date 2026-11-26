import type { GhidraVerifierTimeouts } from "./ghidra-verifier-timeouts.mjs";

export interface GhidraVerifierMcpClient<Reply> {
  connect(
    transport: unknown,
    options: GhidraVerifierTimeouts["requestOptions"],
  ): Promise<void>;
  callTool(
    request: unknown,
    options: GhidraVerifierTimeouts["requestOptions"],
  ): Promise<Reply>;
}

/** Bind every verifier MCP operation to the same owned request budget. */
export function createGhidraVerifierMcpOperations<Reply>(
  client: GhidraVerifierMcpClient<Reply>,
  requestOptions: GhidraVerifierTimeouts["requestOptions"],
): {
  connect(transport: unknown): Promise<void>;
  callTool(request: unknown): Promise<Reply>;
  decodedCall<Name extends string, Value>(
    decode: (reply: Reply, name: Name) => Value,
  ): (name: Name, args?: Record<string, unknown>) => Promise<Awaited<Value>>;
};
