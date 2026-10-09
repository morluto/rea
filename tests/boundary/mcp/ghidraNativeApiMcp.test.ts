import { describe, expect, it } from "vitest";
import { connectGhidraMcp, sessionEvidence } from "./ghidraMcpHarness.js";

describe("Ghidra MCP native API evidence", () => {
  it("returns complete native API boundaries without output-cap unknowns", async () => {
    const harness = await connectGhidraMcp("ghidra-native-api");
    const { mcp, session } = harness;
    try {
      const inspection = sessionEvidence(
        session,
        (
          await mcp.callTool({
            name: "inspect_native_api",
            arguments: { procedure: "fixture_main" },
          })
        ).structuredContent,
      );
      expect(inspection.normalized_result).toMatchObject({
        procedure: { address: "0x401000", name: "fixture_main" },
        boundary: {
          available: true,
          return_type: { data_type: "int", confidence: "medium" },
          jump_tables: [
            {
              dispatch_address: "0x401010",
              data_sources: [{ address: "0x403000" }],
              mappings: [{ case_value: 0, target_address: "0x401020" }],
              default_targets: [
                { target_address: "0x401030", confidence: "high" },
              ],
            },
          ],
        },
        unsupported_branches: [],
        residual_unknowns: [],
      });
      expect(
        (
          await mcp.callTool({
            name: "list_unknowns",
            arguments: {},
          })
        ).structuredContent,
      ).toMatchObject({ result: { items: [] } });
    } finally {
      await harness.close();
    }
  }, 30_000);
});
