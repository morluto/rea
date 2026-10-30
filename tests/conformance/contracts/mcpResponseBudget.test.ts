import { describe, expect, it } from "vitest";
import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from "@modelcontextprotocol/server";

import {
  MINIMUM_RESPONSE_BYTES,
  nodeStringCeilingRecovery,
  parseMcpResponseBudget,
  stdioResponseBudgetRecovery,
} from "../../../src/config/mcpResponseBudget.js";

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
    const reserved = 536_869_864;
    const nodeCeiling = 536_870_888;
    const recovery = stdioResponseBudgetRecovery(
      20_971_520,
      reserved,
      nodeCeiling,
    );
    expect(recovery).toContain(
      "The effective REA_MCP_MAX_RESPONSE_BYTES value is 20971520 bytes",
    );
    expect(recovery).toContain("floor 10485760 bytes, 10 MiB");
    expect(recovery).toContain("restarting the REA process");
    expect(recovery).toContain(
      `REA's reserved single-string limit of ${String(reserved)} UTF-16 code units`,
    );
    expect(recovery).toContain(
      `Node's single-string ceiling of ${String(nodeCeiling)} UTF-16 code units`,
    );
    expect(recovery).not.toContain(
      `Node's single-string ceiling of ${String(reserved)}`,
    );
    expect(recovery).not.toContain(
      `Node's single-string ceiling is ${String(reserved)}`,
    );
    expect(nodeStringCeilingRecovery(reserved, nodeCeiling)).toBe(
      `REA's reserved single-string limit is ${String(reserved)} UTF-16 code units, below Node's single-string ceiling of ${String(nodeCeiling)} UTF-16 code units. This release has no runtime override for either limit, and REA_MCP_MAX_RESPONSE_BYTES does not raise them.`,
    );
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
