import type { CallToolResult } from "@modelcontextprotocol/server";
import { expect } from "vitest";
import { z } from "zod";

import { analysisErrorProjectionSchema } from "../../src/domain/analysisErrorProjectionSchema.js";

/** Read and validate the complete typed diagnostic in an MCP tool failure. */
export function parseMcpToolError(result: CallToolResult) {
  expect(result.isError).toBe(true);
  const text = result.content.find((item) => item.type === "text");
  if (text?.type !== "text") throw new Error("Tool error omitted text content");
  return z
    .object({ error: analysisErrorProjectionSchema })
    .strict()
    .parse(JSON.parse(text.text));
}

/**
 * Expect MCP and CLI to report the same failure facts. Only the recovery
 * differs: each adapter names an operation in its own spelling, so the CLI
 * recovery never carries the MCP name and uses `rea <command>` wherever MCP
 * names the operation.
 */
export function expectAdapterErrorParity(
  mcpError: { readonly remediation: { readonly action: string } },
  cliJson: unknown,
  operation: string,
) {
  const { remediation: mcpRecovery, ...mcpFacts } = mcpError;
  const { remediation: cliRecovery, ...cliFacts } = z
    .object({ remediation: z.object({ action: z.string() }).loose() })
    .loose()
    .parse(cliJson);
  expect(mcpFacts).toEqual(cliFacts);
  expect(cliRecovery.action).not.toContain(operation);
  if (mcpRecovery.action.includes(operation))
    expect(cliRecovery.action).toContain(
      `rea ${operation.replaceAll("_", "-")}`,
    );
}
