import { describe, expect, it } from "vitest";

import { TOOL_CONTRACTS } from "../../../src/contracts/toolContracts.js";
import { toolRegistrationOptions } from "../../../src/server/toolRegistrationOptions.js";

describe("tool registration options", () => {
  it("passes canonical Zod schemas directly to the MCP SDK", () => {
    for (const contract of TOOL_CONTRACTS) {
      const options = toolRegistrationOptions(contract);
      expect(options.inputSchema).toBe(contract.inputSchema);
      expect(options.outputSchema).toBe(contract.outputSchema);
    }
  });

  it("retains the canonical parser as the SDK validation boundary", async () => {
    const contract = TOOL_CONTRACTS.find(
      ({ name }) => name === "analyze_function",
    );
    expect(contract).toBeDefined();
    if (contract === undefined) return;

    const result = await contract.inputSchema["~standard"].validate({});
    expect("issues" in result).toBe(true);
  });
});
