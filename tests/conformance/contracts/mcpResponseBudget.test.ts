import { describe, expect, it } from "vitest";
import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from "@modelcontextprotocol/server";

import {
  MINIMUM_RESPONSE_BYTES,
  nodeStringCeilingRecovery,
  parseMcpResponseBudget,
  stdioResponseBudgetRecovery,
} from "../../../src/config/mcpResponseBudget.js";
import {
  MCP_RESULT_STRING_LIMIT,
  NODE_MAX_STRING_LENGTH,
} from "../../../src/server/toolResultEncoding.js";

describe("MCP response budget configuration", () => {
  it("requires the override to accommodate the pinned transport's default frames", () => {
    expect(
      parseMcpResponseBudget(String(STDIO_DEFAULT_MAX_BUFFER_SIZE)).ok,
    ).toBe(true);
    expect(
      parseMcpResponseBudget(String(STDIO_DEFAULT_MAX_BUFFER_SIZE - 1)).ok,
    ).toBe(false);
  });

  it("names the effective stdio budget without claiming it raises the string ceiling", () => {
    expect(MINIMUM_RESPONSE_BYTES).toBe(10_485_760);
    const effectiveResponseBytes = 20_971_520;
    const recovery = stdioResponseBudgetRecovery(
      effectiveResponseBytes,
      MCP_RESULT_STRING_LIMIT,
      NODE_MAX_STRING_LENGTH,
    );
    const nodeRecovery = nodeStringCeilingRecovery(
      MCP_RESULT_STRING_LIMIT,
      NODE_MAX_STRING_LENGTH,
    );
    expect(recovery).toContain("REA_MCP_MAX_RESPONSE_BYTES");
    expect(recovery).toContain(`${String(effectiveResponseBytes)} bytes`);
    expect(recovery).toContain(`${String(MINIMUM_RESPONSE_BYTES)} bytes`);
    for (const guidance of [recovery, nodeRecovery]) {
      expect(guidance).toContain(
        `${String(MCP_RESULT_STRING_LIMIT)} UTF-16 code units`,
      );
      expect(guidance).toContain(
        `${String(NODE_MAX_STRING_LENGTH)} UTF-16 code units`,
      );
      expect(guidance).toContain("REA_MCP_MAX_RESPONSE_BYTES");
    }
    expect(MCP_RESULT_STRING_LIMIT).toBeLessThan(NODE_MAX_STRING_LENGTH);
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
