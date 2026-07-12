import { describe, expect, it } from "vitest";

import {
  ENHANCED_TOOL_CONTRACTS,
  OFFICIAL_TOOL_CONTRACTS,
  SESSION_TOOL_CONTRACTS,
  TOOL_CONTRACTS,
} from "../src/contracts/toolContracts.js";

describe("tool contract inventory", () => {
  it("publishes 43 analysis contracts and seven session tools", () => {
    expect(OFFICIAL_TOOL_CONTRACTS).toHaveLength(33);
    expect(ENHANCED_TOOL_CONTRACTS).toHaveLength(10);
    expect(SESSION_TOOL_CONTRACTS.map(({ name }) => name)).toEqual([
      "open_binary",
      "close_binary",
      "binary_session",
      "export_evidence_bundle",
      "import_evidence_bundle",
      "capture_process_scenario",
      "compare_process_captures",
    ]);
    expect(TOOL_CONTRACTS).toHaveLength(50);
    expect(new Set(TOOL_CONTRACTS.map(({ name }) => name)).size).toBe(50);
  });

  it("retains documented enhanced-tool limits at the input boundary", () => {
    const batch = ENHANCED_TOOL_CONTRACTS.find(
      ({ name }) => name === "batch_decompile",
    );
    const graph = ENHANCED_TOOL_CONTRACTS.find(
      ({ name }) => name === "get_call_graph",
    );

    expect(
      batch?.inputSchema.safeParse({
        addresses: Array.from({ length: 21 }, () => "0x1"),
      }).success,
    ).toBe(false);
    expect(
      graph?.inputSchema.safeParse({ address: "0x1", depth: 6 }).success,
    ).toBe(false);
    expect(graph?.inputSchema.parse({ address: "0x1" })).toEqual({
      address: "0x1",
      depth: 2,
      direction: "forward",
    });
  });
});
