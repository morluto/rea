export function completeEvidenceCliArguments(
  arguments_: readonly string[],
  cwd?: string,
): Promise<readonly string[]>;

export function completeEvidenceToolArguments(
  name: string,
  arguments_: Record<string, unknown> | undefined,
): Promise<Record<string, unknown> | undefined>;

export function completeEvidenceClient<Client extends { callTool: unknown }>(
  client: Client,
): Client;
