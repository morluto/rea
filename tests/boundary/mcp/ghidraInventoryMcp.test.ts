import { expect, it } from "vitest";
import { jsonValueSchema } from "../../../src/domain/jsonValue.js";
import { ok } from "../../../src/domain/result.js";
import { ghidraFunctionIdentity } from "../../../src/domain/ghidraValues.fixture.js";
import { connectGhidraMcp } from "./ghidraMcpHarness.js";

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
    expect(accepted.structuredContent).toMatchObject({ result: bytes });
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
      expect(rejected.structuredContent).toMatchObject({
        error: { code: "unreadable_output" },
      });
      expect(rejected.structuredContent).not.toHaveProperty("evidence_id");
      expect(rejected.structuredContent).not.toHaveProperty("result");
    }
  } finally {
    await harness.close();
  }
});
