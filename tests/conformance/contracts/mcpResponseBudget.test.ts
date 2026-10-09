import { describe, expect, it } from "vitest";
import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from "@modelcontextprotocol/server";

import { parseMcpResponseBudget } from "../../../src/config/mcpResponseBudget.js";

describe("MCP response budget configuration", () => {
  it("requires the override to accommodate the pinned transport's default frames", () => {
    expect(
      parseMcpResponseBudget(String(STDIO_DEFAULT_MAX_BUFFER_SIZE)).ok,
    ).toBe(true);
    expect(
      parseMcpResponseBudget(String(STDIO_DEFAULT_MAX_BUFFER_SIZE - 1)).ok,
    ).toBe(false);
  });

  it.each(["", "1.5", "1e8", " 10485760", "9007199254740992"])(
    "rejects malformed or unusable budgets: %j",
    (value) => {
      const parsed = parseMcpResponseBudget(value);
      if (parsed.ok) throw new Error("Expected invalid budget");
      expect(parsed.error.message).toContain("REA_MCP_MAX_RESPONSE_BYTES");
    },
  );
});
