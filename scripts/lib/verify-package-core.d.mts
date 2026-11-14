import type { Client } from "@modelcontextprotocol/client";
export function verifyCompleteToolCatalog(
  client: Pick<Client, "listTools" | "callTool">,
  options?: Parameters<Client["listTools"]>[1],
  environment?: Readonly<NodeJS.ProcessEnv>,
): Promise<string[]>;
export function pathExists(path: string): Promise<boolean>;
