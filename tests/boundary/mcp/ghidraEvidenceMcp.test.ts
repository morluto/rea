import { describe, expect, it } from "vitest";
import { EnhancedTools } from "../../../src/application/EnhancedTools.js";
import { connectGhidraMcp, sessionEvidence } from "./ghidraMcpHarness.js";

describe("Ghidra MCP evidence parity", () => {
  it("preserves provider evidence, composed parity, and capability routing", async () => {
    const harness = await connectGhidraMcp("ghidra-parity");
    const { mcp, session } = harness;
    try {
      const listed = sessionEvidence(
        session,
        (
          await mcp.callTool({
            name: "list_procedures",
            arguments: {},
          })
        ).structuredContent,
      );
      expect(listed).toMatchObject({
        operation: "list_procedures",
        provider: { id: "ghidra", name: "Ghidra", version: "12.1.4" },
        analysis_profile: {
          provider: { id: "ghidra", version: "12.1.4" },
          parameters: {
            import_mode: "ephemeral-source-immutable",
            annotation_policy: "atomic-function-entry-metadata-v1",
            analyzer_preset: "ghidra-default",
          },
        },
        normalized_result: [
          {
            address: "0x401000",
            value: "fixture_main",
            procedure: {
              external: false,
              thunk: false,
              thunk_target: null,
            },
          },
        ],
      });

      const mcpOverview = sessionEvidence(
        session,
        (
          await mcp.callTool({
            name: "binary_overview",
            arguments: {},
          })
        ).structuredContent,
      );
      const directOverview = await new EnhancedTools(session).execute(
        "binary_overview",
        {},
      );
      expect(directOverview.ok).toBe(true);
      if (!directOverview.ok) return;
      expect(mcpOverview.normalized_result).toEqual(directOverview.value);
      expect(mcpOverview).toMatchObject({
        provider: { id: "rea-workflow" },
        confidence: "derived",
        normalized_result: {
          document: "fixture",
          segment_count: 1,
          procedure_count: 1,
          string_count: 2,
          segments: [{ name: ".text", length: 256 }],
        },
      });

      const pseudocode = sessionEvidence(
        session,
        (
          await mcp.callTool({
            name: "procedure_pseudo_code",
            arguments: { procedure: "fixture_main" },
          })
        ).structuredContent,
      );
      expect(pseudocode).toMatchObject({
        operation: "procedure_pseudo_code",
        provider: { id: "ghidra", version: "12.1.4" },
        normalized_result: expect.stringContaining("return 42"),
        limitations: expect.arrayContaining([
          expect.stringContaining("not text-equivalent to Hopper"),
        ]),
      });

      const analyzed = sessionEvidence(
        session,
        (
          await mcp.callTool({
            name: "analyze_function",
            arguments: { procedure: "fixture_main" },
          })
        ).structuredContent,
      );
      expect(analyzed).toMatchObject({
        operation: "analyze_function",
        provider: { id: "rea-workflow", version: "1" },
        normalized_result: {
          procedure: {
            address: "0x401000",
            name: "fixture_main",
            classification: {
              external: false,
              thunk: false,
              provenance: "ghidra-function-manager",
            },
          },
          pseudocode: "int fixture_main(void) { return 42; }",
          outgoing_references: [
            {
              kind: { available: true, provenance: "ghidra-reference-manager" },
            },
          ],
          limitations: expect.arrayContaining([
            expect.stringContaining("indirect flows without target addresses"),
            expect.stringContaining(
              "not original source or Hopper-equivalent text",
            ),
          ]),
        },
        limitations: [
          "Derived by an REA workflow from one or more provider observations.",
        ],
      });
      const directAnalyzed = await new EnhancedTools(session).execute(
        "analyze_function",
        { procedure: "fixture_main" },
      );
      expect(directAnalyzed.ok).toBe(true);
      if (!directAnalyzed.ok) return;
      expect(analyzed.normalized_result).toEqual(directAnalyzed.value);
    } finally {
      await harness.close();
    }
  }, 30_000);
});
