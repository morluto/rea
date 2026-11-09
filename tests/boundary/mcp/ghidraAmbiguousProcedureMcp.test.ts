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
              { remoteCode: "procedure_ambiguous" },
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
        remediation: {
          action: expect.stringContaining("explicit procedure entry address"),
        },
      });
      expect(error.recovery).toBeUndefined();
      const malformed = await harness.mcp.callTool({
        name: "analyze_function",
        arguments: { procedure: 42 },
      });
      expect(parseMcpToolError(malformed).error).toMatchObject({
        code: "invalid_request",
        recovery: { kind: "inspect_input_contract" },
        details: {
          issues: [
            expect.objectContaining({
              path: ["procedure"],
              reason: "invalid_type",
            }),
          ],
        },
      });
    } finally {
      await harness.close();
    }
  },
);

it.each(["compact", "full"] as const)(
  "keeps file-offset mapping ambiguity distinct from function identity (%s)",
  async (profile) => {
    const message =
      "File offset 0x400 has multiple loaded mappings: [0x1000, 0x2000]; select an explicit analysis address";
    const harness = await connectGhidraMcp(
      "ambiguous-ghidra-offset",
      () =>
        Promise.resolve(
          err(
            new GhidraSessionError(
              "remote",
              message,
              {},
              { remoteCode: "file_offset_ambiguous" },
            ),
          ),
        ),
      { environment: { REA_MCP_OUTPUT_SCHEMA_PROFILE: profile } },
    );
    try {
      const response = await harness.mcp.callTool({
        name: "procedure_pseudo_code",
        arguments: { procedure: "file-offset:0x400" },
      });
      const { error } = parseMcpToolError(response);
      expect(error).toMatchObject({
        code: "invalid_request",
        message,
        remediation: {
          action: expect.stringContaining("ram:0x1000"),
        },
      });
      expect(error.remediation.action).toContain("inspect_native_load_image");
      expect(error.remediation.action).toContain("bare 0x");
      expect(error.recovery).toBeUndefined();
    } finally {
      await harness.close();
    }
  },
);
