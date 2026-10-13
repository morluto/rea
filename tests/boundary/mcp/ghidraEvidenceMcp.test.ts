import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { describe, expect, it } from "vitest";
import { EnhancedTools } from "../../../src/application/EnhancedTools.js";
import { connectGhidraMcp, sessionEvidence } from "./ghidraMcpHarness.js";
import { functionDossierSchema } from "../../../src/domain/hopperValues.js";
import { ghidraFunctionDossier } from "../../../src/domain/ghidraValues.fixture.js";
import {
  jsonValueSchema,
  type JsonValue,
} from "../../../src/domain/jsonValue.js";
import { ok } from "../../../src/domain/result.js";
import {
  isGhidraFunctionOperation,
  type GhidraFunctionOperation,
} from "../../../src/ghidra/GhidraFunctionValues.js";

it("retains terminal-call qualifications across function views and snapshot replay", async () => {
  const limitation =
    "Ghidra Listing reports a terminal call at 0x401000 to EXTERNAL:0x20 __tls_get_addr (external=true, thunk=false, hasNoReturn=true); fallthrough is excluded by Ghidra's flow model. This records Ghidra's FunctionManager flag, not an independent verification that the callee cannot return.";
  const dossier = functionDossierSchema.parse(ghidraFunctionDossier());
  dossier.limitations.push(limitation);
  const { signature, locals, ...identity } = dossier.procedure;
  if (!identity.body.available)
    throw new Error("The function fixture must include its analyzed body");
  const values = new Map<GhidraFunctionOperation, JsonValue>([
    ["procedure_pseudo_code", dossier.pseudocode],
    ["procedure_assembly", dossier.assembly.join("\n")],
    [
      "procedure_info",
      {
        name: identity.name,
        entrypoint: identity.address,
        signature,
        locals,
        basicblock_count: dossier.basic_blocks.length,
        length: identity.body.total_bytes,
        classification: identity.classification,
        body: identity.body,
      },
    ],
    [
      "read_function_instructions",
      {
        procedure: identity,
        instructions: dossier.assembly,
        limitations: [limitation],
      },
    ],
    ["procedure_callees", ["0x402000"]],
    ["procedure_callers", [identity.address]],
    ["analyze_function", jsonValueSchema.parse(dossier)],
  ]);
  const harness = await connectGhidraMcp(
    "ghidra-terminal-call-evidence",
    (operation) => {
      if (!isGhidraFunctionOperation(operation))
        throw new Error(`Unexpected operation: ${operation}`);
      const value = values.get(operation);
      if (value === undefined)
        throw new Error(`Unexpected operation: ${operation}`);
      return Promise.resolve(ok({ value, limitations: [limitation] }));
    },
  );
  try {
    for (const [name, value] of values) {
      const request = {
        name,
        arguments:
          name === "analyze_function"
            ? { procedure: identity.address }
            : { procedure: identity.address, document: "fixture" },
      };
      const reply = await harness.mcp.callTool(request);
      expect(reply.isError, name).not.toBe(true);
      const evidence = sessionEvidence(
        harness.session,
        reply.structuredContent,
      );
      expect(evidence.normalized_result, name).toEqual(value);
      expect(evidence.raw_result, name).toEqual({
        value,
        limitations: [limitation],
      });
      expect(evidence.limitations, name).toContain(limitation);
      expect(evidence.analysis_profile?.parameters).toMatchObject({
        function_boundary_observations: "ghidra-terminal-call-limitations-v2",
      });
      const replay = await harness.session.execute(name, evidence.parameters);
      if (!replay.ok) throw replay.error;
      expect(replay.value.result, name).toEqual(value);
      expect(replay.value.limitations, name).toContain(limitation);
      expect(replay.value.limitations, name).toContainEqual(
        expect.stringContaining("Loaded from a local REA analysis snapshot"),
      );
    }
    expect(harness.calls).toEqual([...values.keys()]);
  } finally {
    await harness.close();
  }
});

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
      expect(parseMcpToolError(reply)).toMatchObject({
        error: { code: "unreadable_output" },
      });
    }
  } finally {
    await harness.close();
  }
});

it("routes address naming to Ghidra with compact per-address results", async () => {
  const requests: { operation: string; input: unknown }[] = [];
  let output: unknown = null;
  const harness = await connectGhidraMcp(
    "ghidra-address-naming",
    (operation, input) => {
      requests.push({ operation, input });
      return Promise.resolve(ok(jsonValueSchema.parse(output)));
    },
  );
  try {
    output = true;
    const single = await harness.mcp.callTool({
      name: "set_address_name",
      arguments: { address: "0x1000", name: "fixture_entry" },
    });
    expect(single.isError).not.toBe(true);
    expect(single.structuredContent).toMatchObject({ normalized_result: true });
    output = { "0x1000": true, "0x2000": false };
    const batch = await harness.mcp.callTool({
      name: "set_addresses_names",
      arguments: { names: { "0x1000": "fixture_entry", "0x2000": "g_value" } },
    });
    expect(batch.isError).not.toBe(true);
    expect(batch.structuredContent).toMatchObject({
      normalized_result: { "0x1000": true, "0x2000": false },
    });
    expect(requests).toEqual([
      {
        operation: "set_address_name",
        input: { document: null, address: "0x1000", name: "fixture_entry" },
      },
      {
        operation: "set_addresses_names",
        input: {
          document: null,
          names: { "0x1000": "fixture_entry", "0x2000": "g_value" },
        },
      },
    ]);
    const empty = await harness.mcp.callTool({
      name: "set_addresses_names",
      arguments: { names: {} },
    });
    expect(empty.isError).toBe(true);
    expect(requests).toHaveLength(2);
    output = "fixture_entry";
    const malformed = await harness.mcp.callTool({
      name: "set_address_name",
      arguments: { address: "0x1000", name: "fixture_entry" },
    });
    expect(malformed.isError).toBe(true);
    expect(parseMcpToolError(malformed)).toMatchObject({
      error: { code: "unreadable_output" },
    });
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
