import { describe, expect, it } from "vitest";
import { connectGhidraMcp } from "./ghidraMcpHarness.js";

describe("Ghidra MCP capability routing", () => {
  it("routes composed and capability tools", async () => {
    const harness = await connectGhidraMcp("ghidra-routing");
    const { calls, mcp } = harness;
    try {
      const batch = await mcp.callTool({
        name: "batch_decompile",
        arguments: { addresses: ["fixture_main"] },
      });
      expect(batch.isError).not.toBe(true);
      expect(batch.structuredContent).toMatchObject({
        result: {
          succeeded: 1,
          failed: 0,
          items: [{ status: "ok" }],
        },
      });

      const availableNames = (await mcp.listTools()).tools.map(
        ({ name }) => name,
      );
      expect(availableNames).toContain("set_comment");
      expect(calls).not.toContain("set_comment");

      const status = await mcp.callTool({
        name: "binary_session",
        arguments: { detail: "full" },
      });
      expect(status.structuredContent).toMatchObject({
        result: {
          open: true,
          analysis_provider_binding: {
            provider: { id: "ghidra", version: "12.1.2" },
          },
          tool_availability: expect.arrayContaining([
            expect.objectContaining({
              name: "binary_overview",
              available: true,
            }),
            expect.objectContaining({ name: "swift_classes", available: true }),
            expect.objectContaining({
              name: "get_objc_classes",
              available: true,
            }),
            expect.objectContaining({
              name: "batch_decompile",
              available: true,
            }),
            expect.objectContaining({
              name: "trace_feature",
              available: true,
            }),
            expect.objectContaining({
              name: "get_call_graph",
              available: true,
            }),
            expect.objectContaining({
              name: "find_xrefs_to_name",
              available: true,
            }),
            expect.objectContaining({
              name: "set_comment",
              available: false,
            }),
          ]),
        },
      });
    } finally {
      await harness.close();
    }
  }, 30_000);
});
