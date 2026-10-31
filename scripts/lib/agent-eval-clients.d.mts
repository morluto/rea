export type AgentEvalClientId = "codex" | "claude-code" | "gemini-cli";

export interface AgentEvalClient {
  readonly id: AgentEvalClientId;
  readonly setupClient: "codex" | "claude_code" | "gemini_cli";
  readonly commandVariable: string;
  readonly defaultCommand: string;
  /** The credential file name copied into the client's profile. */
  readonly credentialFile: string;
  /** Where that credential lands below `evaluationRoot`, known before preparation. */
  readonly credentialPaths: (evaluationRoot: string) => readonly string[];
  /** The selected executable or JavaScript entry point, as resolved. */
  readonly command: string;
  /** How to spawn it: a JavaScript entry point runs under this Node. */
  readonly launch: (arguments_: readonly string[]) => {
    readonly command: string;
    readonly arguments: readonly string[];
  };
}

export interface PreparedAgentEvalClient {
  readonly environment: Readonly<Record<string, string>>;
  readonly skillDirectory: string;
  readonly arguments: (
    prompt: string,
    approvedTools: readonly string[],
  ) => readonly string[] | Promise<readonly string[]>;
}

export function selectAgentEvalClient(
  value?: string,
  repositoryRoot?: string,
): AgentEvalClient;

export function preflightClientEnvironment(
  client: Pick<AgentEvalClient, "id">,
): Record<string, string>;

export function agentEvalEnvironment(options: {
  readonly account: string;
  readonly runId: string;
  readonly client: Pick<PreparedAgentEvalClient, "environment">;
}): Record<string, string>;

export function prepareAgentEvalClient(
  client: AgentEvalClient,
  options: {
    readonly evaluationRoot: string;
    readonly account: string;
    readonly model?: string;
    readonly authPaths: string[];
  },
): Promise<PreparedAgentEvalClient>;
