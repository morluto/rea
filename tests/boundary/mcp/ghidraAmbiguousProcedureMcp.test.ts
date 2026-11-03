import { expect, it } from "vitest";
import { err } from "../../../src/domain/result.js";
import { GhidraSessionError } from "../../../src/ghidra/GhidraSessionError.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { connectGhidraMcp } from "./ghidraMcpHarness.js";

it.each(["compact", "full"] as const)(
  "preserves actionable Ghidra procedure ambiguity over MCP (%s)",
  async (profile) => {
    const message =
      "Ghidra procedure name is ambiguous: shared; select an exact entry address from [0x1000, 0x2000]";
    const harness = await connectGhidraMcp(
      "ambiguous-ghidra-procedure",
      () =>
        Promise.resolve(
          err(
            new GhidraSessionError(
              "remote",
              message,
              {},
              { remoteCode: "ambiguous_procedure" },
            ),
          ),
        ),
      { environment: { REA_MCP_OUTPUT_SCHEMA_PROFILE: profile } },
    );
    try {
      const response = await harness.mcp.callTool({
        name: "analyze_function",
        arguments: { procedure: "shared" },
      });
      const { error } = parseMcpToolError(response);
      expect(error).toMatchObject({
        code: "invalid_request",
        message,
        remediation: { action: expect.stringContaining("exact entry address") },
      });
      expect(error.recovery).toBeUndefined();
    } finally {
      await harness.close();
    }
  },
);
