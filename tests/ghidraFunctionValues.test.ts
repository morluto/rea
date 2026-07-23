import { describe, expect, it } from "vitest";

import type { JsonValue } from "../src/domain/jsonValue.js";
import {
  GHIDRA_FUNCTION_OPERATIONS,
  isGhidraFunctionOperation,
  parseGhidraFunctionInput,
  parseGhidraFunctionResult,
  type GhidraFunctionOperation,
} from "../src/ghidra/GhidraFunctionValues.js";
import {
  ghidraBounded,
  ghidraFunctionClassification,
  ghidraFunctionDossier,
  ghidraFunctionIdentity,
  ghidraReferenceEdge,
} from "./fixtures/ghidraFunction.js";

describe("Ghidra function-analysis boundary values", () => {
  it("defaults bounded inputs and rejects undeclared or implicit addresses", () => {
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
        offset: 0,
        limit: 100,
        max_instructions: 500,
      },
    });
    expect(
      parseGhidraFunctionInput("analyze_function", { procedure: "main" }),
    ).toMatchObject({
      ok: true,
      value: {
        procedure: "main",
        include_assembly: false,
        limit: 100,
        max_pseudocode_chars: 20_000,
        max_instructions: 500,
        pseudocode_offset: 0,
        assembly_offset: 0,
        collection_offset: { basic_blocks: 0, outgoing_references: 0 },
      },
    });
    expect(
      parseGhidraFunctionInput("read_function_instructions", {
        procedure: "main",
      }),
    ).toEqual({
      ok: true,
      value: {
        document: null,
        procedure: "main",
        offset: 0,
        limit: 64,
      },
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

  it("keeps the admitted operation set closed", () => {
    expect(GHIDRA_FUNCTION_OPERATIONS).toHaveLength(9);
    expect(isGhidraFunctionOperation("analyze_function")).toBe(true);
    expect(isGhidraFunctionOperation("read_function_instructions")).toBe(true);
    expect(isGhidraFunctionOperation("procedure_pseudo_code")).toBe(true);
    expect(isGhidraFunctionOperation("list_procedures")).toBe(false);
    expect(isGhidraFunctionOperation("set_comment")).toBe(false);
  });

  it("parses provider-classified function facts and reference kinds", () => {
    expect(
      parseGhidraFunctionResult("read_function_instructions", {
        procedure: ghidraFunctionIdentity(),
        instructions: ghidraBounded(["0x401000: push rbp"]),
        instructions_scanned: 1,
        instruction_scan_truncated: false,
        limitations: ["Ghidra-specific instruction text."],
      }),
    ).toMatchObject({ ok: true });
    expect(
      parseGhidraFunctionResult("read_function_instructions", {
        procedure: {
          ...ghidraFunctionIdentity(),
          address: "0X401000",
        },
        instructions: ghidraBounded(["0x401000: push rbp"]),
        instructions_scanned: 1,
        instruction_scan_truncated: false,
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
        references: ghidraBounded([ghidraReferenceEdge()]),
        instructions_scanned: 2,
        instruction_scan_truncated: false,
      }),
    ).toMatchObject({
      ok: true,
      value: {
        references: {
          items: [
            {
              kind: {
                available: true,
                provenance: "ghidra-reference-manager",
                data: true,
              },
            },
          ],
        },
      },
    });
    expect(
      parseGhidraFunctionResult("analyze_function", ghidraFunctionDossier()),
    ).toMatchObject({ ok: true });
  });

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
        references: ghidraBounded([
          { ...edge, kind: { available: false, reason: "unknown" } },
        ]),
        instructions_scanned: 1,
        instruction_scan_truncated: false,
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
