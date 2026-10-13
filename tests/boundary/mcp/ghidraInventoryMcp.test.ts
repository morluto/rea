import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { nativeAotPeFixture } from "../../fixtures/nativeaotPe.js";
import { jsonValueSchema } from "../../../src/domain/jsonValue.js";
import { ok } from "../../../src/domain/result.js";
import { ghidraFunctionIdentity } from "../../../src/domain/ghidraValues.fixture.js";
import { connectGhidraMcp, sessionEvidence } from "./ghidraMcpHarness.js";

it("retains missing PDB coverage in empty PE name-search Evidence and snapshot replay", async () => {
  const root = await createTestTempDirectory("rea-pdb-evidence-");
  const targetPath = join(root, "fixture.exe");
  await writeFile(targetPath, nativeAotPeFixture());
  // Synthetic post-analysis facts at the real provider boundary; no engine is simulated as verified.
  const pdb = {
    file: "C:\\build\\fixture.pdb",
    guid: "01234567-89AB-CDEF-0123-456789ABCDEF",
    age: "a",
    signature: null,
    version: "RSDS",
    loaded: false,
  };
  const harness = await connectGhidraMcp(
    "ghidra-pdb-coverage",
    (operation) =>
      Promise.resolve(
        ok(
          operation === "procedure_pseudo_code"
            ? {
                value: "int FUN_140001000(void) { return 0; }",
                limitations: [],
              }
            : [],
        ),
      ),
    {
      targetPath,
      pdb,
    },
  );
  try {
    const reply = await harness.mcp.callTool({
      name: "search_procedures",
      arguments: { pattern: "add_numbers" },
    });
    expect(reply.isError).not.toBe(true);
    const evidence = sessionEvidence(harness.session, reply.structuredContent);
    expect(evidence.normalized_result).toEqual([]);
    expect(evidence.analysis_profile?.parameters.pdb_observations).toBe(
      "program-info-v1",
    );
    const limitation = evidence.limitations.find((value) =>
      value.includes(pdb.file),
    );
    expect(limitation).toContain(pdb.guid);
    expect(limitation).toContain("age (hex) a");
    expect(limitation).toContain("not loaded");
    const decompiled = await harness.mcp.callTool({
      name: "procedure_pseudo_code",
      arguments: { procedure: "0x140001000", document: "fixture" },
    });
    expect(decompiled.isError).not.toBe(true);
    const functionEvidence = sessionEvidence(
      harness.session,
      decompiled.structuredContent,
    );
    expect(functionEvidence.limitations).toContain(limitation);
    const replay = await harness.session.execute(
      "procedure_pseudo_code",
      functionEvidence.parameters,
    );
    if (!replay.ok) throw replay.error;
    expect(replay.value.limitations).toContain(limitation);
    expect(replay.value.limitations).toContainEqual(
      expect.stringContaining("Loaded from a local REA analysis snapshot"),
    );
  } finally {
    await harness.close();
  }
});

it("retains defined-string coverage in empty and matching search Evidence", async () => {
  let output = jsonValueSchema.parse([]);
  const harness = await connectGhidraMcp("ghidra-string-coverage", () =>
    Promise.resolve(ok(output)),
  );
  try {
    for (const request of [
      { name: "list_strings", arguments: {} },
      { name: "search_strings", arguments: { pattern: "projection" } },
      {
        name: "search_strings",
        arguments: { pattern: "projection.*", mode: "regex" },
      },
    ]) {
      const reply = await harness.mcp.callTool(request);
      expect(reply.isError).not.toBe(true);
      const evidence = sessionEvidence(
        harness.session,
        reply.structuredContent,
      );
      expect(evidence.normalized_result).toEqual([]);
      expect(evidence.analysis_profile?.parameters).toMatchObject({
        string_inventory_evidence: "defined-data-coverage-v1",
      });
      expect(evidence.limitations).toContainEqual(
        expect.stringMatching(
          /Only Ghidra-defined string Data.*empty search does not establish/u,
        ),
      );
    }
    output = jsonValueSchema.parse([
      { address: "0x401000", value: "projection cache ignored" },
    ]);
    const matched = await harness.mcp.callTool({
      name: "search_strings",
      arguments: { pattern: "projection" },
    });
    const evidence = sessionEvidence(
      harness.session,
      matched.structuredContent,
    );
    expect(evidence.normalized_result).toEqual(output);
    expect(evidence.limitations).toContainEqual(
      expect.stringContaining("Completeness applies to that inventory"),
    );
    output = jsonValueSchema.parse([]);
    const procedures = await harness.mcp.callTool({
      name: "search_procedures",
      arguments: { pattern: "projection" },
    });
    expect(
      sessionEvidence(harness.session, procedures.structuredContent)
        .limitations,
    ).not.toContainEqual(expect.stringContaining("Ghidra-defined string Data"));
  } finally {
    await harness.close();
  }
});

it("rejects contradictory provider output before emitting MCP Evidence", async () => {
  const bytes = {
    address: "0x401000",
    requested_bytes: 4,
    returned_bytes: 2,
    bytes_hex: "0410",
    complete: false,
  };
  let output = jsonValueSchema.parse(bytes);
  const harness = await connectGhidraMcp("ghidra-invalid-inventory", () =>
    Promise.resolve(ok(output)),
  );
  try {
    const accepted = await harness.mcp.callTool({
      name: "read_bytes",
      arguments: { address: bytes.address, length: 4 },
    });
    expect(accepted.isError).not.toBe(true);
    expect(accepted.structuredContent).toMatchObject({
      normalized_result: bytes,
    });
    const cases = [
      ...[
        { complete: true },
        { returned_bytes: 4 },
        { bytes_hex: "04" },
        { requested_bytes: 1 },
      ].map((change, index) => ({
        name: "read_bytes",
        arguments: {
          address: `0x${(0x401004 + index * 4).toString(16)}`,
          length: 4,
        },
        output: { ...bytes, ...change },
      })),
      {
        name: "address_to_file_offset",
        arguments: { address: bytes.address },
        output: { address: bytes.address, file_offset: -1 },
      },
      {
        name: "list_procedures",
        arguments: {},
        output: [
          {
            address: "00401000",
            value: "main",
            procedure: { external: false, thunk: false, thunk_target: null },
          },
        ],
      },
      {
        name: "search_strings",
        arguments: { pattern: "needle" },
        output: [{ address: "0x401000" }],
      },
      {
        name: "read_function_instructions",
        arguments: { procedure: "fixture_main" },
        output: {
          procedure: { ...ghidraFunctionIdentity(), address: "0X401000" },
          instructions: ["0x401000: push rbp"],
          limitations: ["Ghidra-specific instruction text."],
        },
      },
      {
        name: "resolve_containing_procedure",
        arguments: { address: "EXTERNAL:0x2" },
        output: {
          query_address: "EXTERNAL:0x2",
          found: true,
          procedure: {
            ...ghidraFunctionIdentity(),
            address: "EXTERNAL:0x1",
            classification: {
              ...ghidraFunctionIdentity().classification,
              external: true,
            },
            body: {
              ...ghidraFunctionIdentity().body,
              ranges: [],
              total_bytes: 0,
              span_bytes: 0,
              contains_entry: false,
            },
          },
        },
      },
    ];
    for (const probe of cases) {
      output = jsonValueSchema.parse(probe.output);
      const rejected = await harness.mcp.callTool({
        name: probe.name,
        arguments: probe.arguments,
      });
      expect(rejected.isError, probe.name).toBe(true);
      expect(parseMcpToolError(rejected)).toMatchObject({
        error: { code: "unreadable_output" },
      });
      expect(parseMcpToolError(rejected)).not.toHaveProperty("evidence_id");
      expect(parseMcpToolError(rejected)).not.toHaveProperty("result");
    }
  } finally {
    await harness.close();
  }
});
