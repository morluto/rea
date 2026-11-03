import { expect, it } from "vitest";
import { err, ok } from "../../../src/domain/result.js";
import { GhidraSessionError } from "../../../src/ghidra/GhidraSessionError.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { connectGhidraMcp } from "./ghidraMcpHarness.js";

it.each(["compact", "full"] as const)(
  "identifies the invalid Ghidra regex field and permits correction (%s)",
  async (profile) => {
    const message =
      "Invalid regex pattern [: Unclosed character class at index 0";
    const harness = await connectGhidraMcp(
      "ghidra-regex-diagnostic",
      (operation, input) =>
        Promise.resolve(
          input.pattern === "["
            ? err(
                new GhidraSessionError(
                  "remote",
                  message,
                  {},
                  { remoteCode: "invalid_regex_pattern" },
                ),
              )
            : ok([]),
        ),
      { environment: { REA_MCP_OUTPUT_SCHEMA_PROFILE: profile } },
    );
    try {
      for (const operation of [
        "search_strings",
        "search_procedures",
      ] as const) {
        const rejected = await harness.mcp.callTool({
          name: operation,
          arguments: { pattern: "[", mode: "regex" },
        });
        const error = parseMcpToolError(rejected).error;
        expect(error).toMatchObject({
          code: "invalid_request",
          message,
          remediation: {
            action: expect.stringMatching(/pattern.*mode literal/u),
          },
          details: {
            issues: [{ path: ["pattern"], reason: "invalid_format", message }],
          },
        });
        expect(error.recovery).toMatchObject({
          kind: "inspect_input_contract",
          operation,
        });
        const corrected = await harness.mcp.callTool({
          name: operation,
          arguments: { pattern: "valid", mode: "regex" },
        });
        expect(corrected.isError).not.toBe(true);
      }
    } finally {
      await harness.close();
    }
  },
);
