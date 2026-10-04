import { describe, expect, it } from "vitest";

import type { JsonValue } from "../domain/jsonValue.js";
import { functionDossierSchema } from "../domain/hopperValues.js";
import {
  parseGhidraFunctionInput,
  parseGhidraFunctionResult,
  type GhidraFunctionOperation,
} from "./GhidraFunctionValues.js";
import {
  ghidraFunctionClassification,
  ghidraFunctionDossier,
  ghidraFunctionIdentity,
  ghidraNativeApiBoundary,
  ghidraReferenceEdge,
} from "../domain/hopperValues.fixture.js";

describe("Ghidra function-analysis boundary values", () => {
  it("defaults inputs and rejects undeclared or implicit addresses", () => {
    expect(
      parseGhidraFunctionInput("procedure_info", { procedure: "main" }),
    ).toEqual({
      ok: true,
      value: { document: null, procedure: "main" },
    });
    expect(
      parseGhidraFunctionInput("procedure_references", { procedure: "main" }),
    ).toEqual({
      ok: true,
      value: {
        document: null,
        procedure: "main",
        direction: "outgoing",
      },
    });
    expect(
      parseGhidraFunctionInput("analyze_function", { procedure: "main" }),
    ).toMatchObject({
      ok: true,
      value: { procedure: "main" },
    });
    expect(
      parseGhidraFunctionInput("read_function_instructions", {
        procedure: "main",
      }),
    ).toEqual({
      ok: true,
      value: { document: null, procedure: "main" },
    });
    expect(parseGhidraFunctionInput("xrefs", {})).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisInputError" },
    });
    expect(
      parseGhidraFunctionInput("procedure_info", {
        procedure: "main",
        extra: true,
      }),
    ).toMatchObject({ ok: false, error: { _tag: "AnalysisInputError" } });
  });
});

describe("Ghidra function-analysis result values", () => {
  it("parses provider-classified function facts and reference kinds", () => {
    expect(
      parseGhidraFunctionResult("read_function_instructions", {
        procedure: ghidraFunctionIdentity(),
        instructions: ["0x401000: push rbp"],
        limitations: ["Ghidra-specific instruction text."],
      }),
    ).toMatchObject({ ok: true });
    expect(
      parseGhidraFunctionResult("read_function_instructions", {
        procedure: {
          ...ghidraFunctionIdentity(),
          address: "0X401000",
        },
        instructions: ["0x401000: push rbp"],
        limitations: ["Ghidra-specific instruction text."],
      }),
    ).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisOutputError" },
    });
    expect(
      parseGhidraFunctionResult("procedure_info", {
        name: "fixture_main",
        entrypoint: "0x401000",
        basicblock_count: 1,
        length: 6,
        signature: "int fixture_main(void)",
        locals: [
          {
            description: "int local @ Stack[-0x4]:4",
            provenance: "ghidra-function-database",
          },
        ],
        classification: ghidraFunctionClassification(),
      }),
    ).toMatchObject({ ok: true });
    expect(
      parseGhidraFunctionResult("procedure_references", {
        procedure: ghidraFunctionIdentity(),
        direction: "outgoing",
        references: [ghidraReferenceEdge()],
      }),
    ).toMatchObject({
      ok: true,
      value: {
        references: [
          {
            kind: {
              available: true,
              provenance: "ghidra-reference-manager",
              data: true,
            },
          },
        ],
      },
    });
    expect(
      parseGhidraFunctionResult("analyze_function", ghidraFunctionDossier()),
    ).toMatchObject({
      ok: true,
      value: {
        native_api: {
          available: true,
          provenance: "ghidra-high-function",
          return_type: {
            data_type: "int",
            confidence: "medium",
          },
          jump_tables: [
            {
              dispatch_address: "0x401010",
              data_sources: [{ address: "0x403000" }],
              mappings: [
                {
                  target_address: "0x401020",
                },
              ],
            },
          ],
          pseudocode: {
            classification: "decompiler-generated-non-source",
            compilable: false,
          },
        },
        native_value_flow: {
          available: true,
          provenance: "ghidra-high-pcode",
          operations: [
            expect.objectContaining({ id: "0x401000#0", opcode: "COPY" }),
          ],
          truncated: false,
        },
      },
    });
  });

  it("rejects p-code relationships that refer to omitted operation IDs", () => {
    const dossier = ghidraFunctionDossier();
    if (
      typeof dossier !== "object" ||
      dossier === null ||
      Array.isArray(dossier)
    )
      throw new TypeError("Ghidra dossier fixture is invalid");
    const flow = dossier.native_value_flow;
    if (typeof flow !== "object" || flow === null || Array.isArray(flow))
      throw new TypeError("Ghidra p-code fixture is invalid");
    expect(
      parseGhidraFunctionResult("analyze_function", {
        ...dossier,
        native_value_flow: {
          ...flow,
          def_use: [
            {
              definition: "0x401000#missing",
              use: "0x401000#0",
              input_index: 0,
            },
          ],
        },
      }),
    ).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisOutputError" },
    });
  });
});

describe("Ghidra jump-table mapping contract", () => {
  it("keeps jump-table sources separate from case-to-target mappings", () => {
    const parsed = parseGhidraFunctionResult(
      "analyze_function",
      ghidraFunctionDossier(),
    );
    if (!parsed.ok) throw parsed.error;
    const boundary = functionDossierSchema.parse(parsed.value).native_api;
    if (boundary?.available !== true)
      throw new TypeError("Ghidra native API fixture is unavailable");
    const mapping = boundary.jump_tables[0]?.mappings[0];
    expect(mapping).toMatchObject({
      case_value: 0,
      target_address: "0x401020",
    });
    expect(mapping).not.toHaveProperty("data_addresses");
  });
});

describe("Ghidra function-analysis malformed results", () => {
  it.each(malformedOutputs())(
    "rejects malformed %s output",
    (_name, operation, value) => {
      expect(parseGhidraFunctionResult(operation, value)).toMatchObject({
        ok: false,
        error: { _tag: "AnalysisOutputError" },
      });
    },
  );
});

const malformedOutputs = (): Array<
  [string, GhidraFunctionOperation, JsonValue]
> => {
  const dossier = ghidraFunctionDossier();
  if (typeof dossier !== "object" || dossier === null || Array.isArray(dossier))
    throw new TypeError("Ghidra dossier fixture is invalid");
  const edge = ghidraReferenceEdge();
  const nativeApi = ghidraNativeApiBoundary();
  const jumpTable = nativeApi.jump_tables[0];
  const mapping = jumpTable?.mappings[0];
  if (jumpTable === undefined || mapping === undefined)
    throw new TypeError("Ghidra native API fixture is invalid");
  return [
    ["non-canonical address", "procedure_callers", ["401000"]],
    [
      "missing classification",
      "procedure_info",
      {
        name: "main",
        entrypoint: "0x401000",
        basicblock_count: 1,
        length: 1,
        signature: null,
        locals: [],
      },
    ],
    [
      "unavailable Ghidra reference kind",
      "procedure_references",
      {
        procedure: ghidraFunctionIdentity(),
        direction: "outgoing",
        references: [
          { ...edge, kind: { available: false, reason: "unknown" } },
        ],
      },
    ],
    [
      "missing native API boundary",
      "analyze_function",
      Object.fromEntries(
        Object.entries(dossier).filter(([key]) => key !== "native_api"),
      ),
    ],
    [
      "non-canonical native API target",
      "analyze_function",
      {
        ...dossier,
        native_api: {
          ...nativeApi,
          jump_tables: [
            {
              ...jumpTable,
              mappings: [
                {
                  ...mapping,
                  target_address: "401020",
                },
              ],
            },
          ],
        },
      },
    ],
    [
      "Hopper local provenance",
      "analyze_function",
      {
        ...dossier,
        procedure: {
          ...ghidraFunctionIdentity(),
          signature: null,
          locals: [
            {
              description: "opaque",
              provenance: "hopper-public-python-api",
            },
          ],
        },
      },
    ],
    [
      "inconsistent dossier bound",
      "analyze_function",
      {
        ...dossier,
        instruction_scan: { scanned: -1, truncated: false },
      },
    ],
    [
      "missing uncertainty limitations",
      "analyze_function",
      {
        ...dossier,
        limitations: [],
      },
    ],
  ];
};
