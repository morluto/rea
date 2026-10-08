import { describe, expect, it } from "vitest";
import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from "@modelcontextprotocol/server";

import { parseMcpResponseBudget } from "../../../src/config/mcpResponseBudget.js";

describe("MCP response budget configuration", () => {
  it("leaves the default policy to the MCP adapter", () => {
    expect(parseMcpResponseBudget(undefined)).toEqual({
      ok: true,
      value: undefined,
    });
  });

  it("requires the override to accommodate the pinned transport's default frames", () => {
    expect(
      parseMcpResponseBudget(String(STDIO_DEFAULT_MAX_BUFFER_SIZE)).ok,
    ).toBe(true);
    expect(
      parseMcpResponseBudget(String(STDIO_DEFAULT_MAX_BUFFER_SIZE - 1)).ok,
    ).toBe(false);
  });

  it.each(["10485760", "268435456", "1073741824"])(
    "accepts an explicit complete-response budget: %s",
    (value) => {
      expect(parseMcpResponseBudget(value)).toEqual({
        ok: true,
        value: Number(value),
      });
    },
  );

  it.each([
    "",
    "0",
    "-1",
    "1024",
    "1.5",
    "1e8",
    " 10485760",
    "Infinity",
    "9007199254740992",
  ])("rejects malformed or unusable budgets: %j", (value) => {
    const parsed = parseMcpResponseBudget(value);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("Expected invalid budget");
    expect(parsed.error.message).toContain("REA_MCP_MAX_RESPONSE_BYTES");
  });
});
