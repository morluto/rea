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

/**
 * Run the compiled CLI in the artifact verification environment for a run
 * that must fail, and return its JSON error record.
 */
export function artifactCliFailure(
  command: string,
  target: string,
  arguments_?: readonly string[],
  options?: { readonly timeoutMs?: number; readonly signal?: AbortSignal },
): Promise<{
  readonly code: string;
  readonly details?: Record<string, unknown>;
  readonly [key: string]: unknown;
}>;
