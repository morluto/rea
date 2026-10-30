import type { Client } from "@modelcontextprotocol/client";

/**
 * Verify segmented aliases and restore the entry's observed public name.
 * With `mutable: false` (Windows P0), annotation and naming edits must be refused.
 */
export function verifyGhidraAddressBoundaries(
  client: Pick<Client, "callTool">,
  entry: string,
  cli: (command: string, address: string, flags: string[]) => Promise<unknown>,
  options?: { readonly mutable?: boolean },
): Promise<void>;
