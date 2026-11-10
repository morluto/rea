import { describe, expect, it } from "vitest";

import {
  DEFAULT_MCP_TOOLS_LIST_PAGE_BUDGET,
  MCP_TOOLS_LIST_PAGE_BUDGET_SETTING,
  parseMcpToolsListPageBudget,
} from "./mcpToolsListPageBudget.js";

describe("REA_MCP_TOOLS_LIST_PAGE_BYTES", () => {
  it("uses the default when the setting is unset", () => {
    const parsed = parseMcpToolsListPageBudget(undefined);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual(DEFAULT_MCP_TOOLS_LIST_PAGE_BUDGET);
  });

  it("accepts a positive decimal override inside the FastMCP event cap", () => {
    const parsed = parseMcpToolsListPageBudget("1048576");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toMatchObject({
      setting: MCP_TOOLS_LIST_PAGE_BUDGET_SETTING,
      bytes: 1_048_576,
      source: "setting",
      defaultBytes: DEFAULT_MCP_TOOLS_LIST_PAGE_BUDGET.bytes,
    });
  });

  it.each(["0", "-1", "1.5", "1048577", " 917504", "abc"])(
    "refuses %s instead of ignoring it",
    (value) => {
      const parsed = parseMcpToolsListPageBudget(value);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.error.settings).toEqual([
        {
          setting: MCP_TOOLS_LIST_PAGE_BUDGET_SETTING,
          constraint: expect.stringContaining(
            MCP_TOOLS_LIST_PAGE_BUDGET_SETTING,
          ),
        },
      ]);
    },
  );
});
