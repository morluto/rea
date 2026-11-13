import type {
  Client,
  CallToolRequestOptions,
} from "@modelcontextprotocol/client";
import type { VerifierCommands } from "./verify-commands.mjs";

/** Keep the opened target and its owned stdio server alive through verification. */
export function withArtifactMcp(
  target: string,
  verify: (client: Client) => Promise<void>,
  options?: {
    readonly commands?: VerifierCommands;
    readonly signal?: AbortSignal;
  },
): Promise<void>;

/** Call with the server's advertised schema; callers cannot replace it. */
export function artifactMcpCall(
  client: Client,
  parameters: Parameters<Client["callTool"]>[0],
  options?: Omit<CallToolRequestOptions, "toolDefinition">,
): ReturnType<Client["callTool"]>;
