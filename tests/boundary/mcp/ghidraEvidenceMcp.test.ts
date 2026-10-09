import { describe, expect, it } from "vitest";
import { EnhancedTools } from "../../../src/application/EnhancedTools.js";
import { connectGhidraMcp, sessionEvidence } from "./ghidraMcpHarness.js";
import { functionDossierSchema } from "../../../src/domain/hopperValues.js";
import { ghidraFunctionDossier } from "../../../src/domain/ghidraValues.fixture.js";
import { jsonValueSchema } from "../../../src/domain/jsonValue.js";
import { ok } from "../../../src/domain/result.js";

it("rejects contradictory annotation readback across the provider and MCP boundaries", async () => {
  const dossier = functionDossierSchema.parse(ghidraFunctionDossier());
  const annotations = {
    address: dossier.procedure.address,
    name: dossier.procedure.name,
    comment: null,
    inline_comment: "Finding",
  };
  const effects = {
    scope: "session-analysis-database",
    source_bytes_modified: false,
    persists_after_close: false,
  };
  const original = { annotations, dossier, effects };
  let output = jsonValueSchema.parse(original);
  const harness = await connectGhidraMcp("ghidra-malformed-annotation", () =>
    Promise.resolve(ok(output)),
  );
  try {
    const accepted = await harness.mcp.callTool({
      name: "annotate_native_function",
      arguments: {
        procedure: annotations.address,
        inline_comment: "Finding",
      },
    });
    expect(accepted.isError).not.toBe(true);
    expect(accepted.structuredContent).toMatchObject({
      normalized_result: { annotations },
    });
    for (const value of [
      { ...original, annotations: { ...annotations, name: "different" } },
      { ...original, annotations: { ...annotations, address: "0x9999" } },
      { ...original, effects: { ...effects, source_bytes_modified: true } },
      { ...original, effects: { ...effects, persists_after_close: true } },
      { ...original, dossier: { ...dossier, native_value_flow: null } },
    ]) {
      output = jsonValueSchema.parse(value);
      const reply = await harness.mcp.callTool({
        name: "annotate_native_function",
        arguments: {
          procedure: annotations.address,
          inline_comment: "Finding",
        },
      });
      expect(reply.isError).toBe(true);
      expect(reply.structuredContent).toMatchObject({
        error: { code: "unreadable_output" },
      });
    }
  } finally {
    await harness.close();
  }
});

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
      if (!directOverview.ok) throw directOverview.error;
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
        provider: { id: "ghidra", version: "12.1.4" },
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
        limitations: expect.arrayContaining([
          expect.stringContaining("default auto-analysis complete"),
          expect.stringContaining(
            "original executable bytes are never written",
          ),
        ]),
      });
      const directAnalyzed = await new EnhancedTools(session).execute(
        "analyze_function",
        { procedure: "fixture_main" },
      );
      if (!directAnalyzed.ok) throw directAnalyzed.error;
      expect(analyzed.normalized_result).toEqual(directAnalyzed.value);
    } finally {
      await harness.close();
    }
  }, 30_000);
});
