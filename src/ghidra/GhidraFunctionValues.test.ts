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
  ghidraFunctionBody,
  ghidraFunctionDossier,
  ghidraFunctionIdentity,
  ghidraNativeApiBoundary,
  ghidraReferenceEdge,
} from "../domain/ghidraValues.fixture.js";

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
        body: ghidraFunctionBody(),
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
  it("preserves evidenced defaults separately from cases and unresolved targets", () => {
    const dossier = functionDossierSchema.parse(ghidraFunctionDossier());
    const boundary = dossier.native_api;
    if (boundary?.available !== true)
      throw new TypeError("Ghidra native API fixture is unavailable");
    const table = boundary.jump_tables[0];
    const mapping = table?.mappings[0];
    if (table === undefined || mapping === undefined)
      throw new TypeError("Ghidra jump-table fixture is unavailable");
    const defaults = [
      {
        target_address: mapping.target_address,
        confidence: "high",
        evidence: [
          {
            kind: "jump-table",
            source: "ghidra-clang-case-token",
            detail: "Default label reaches this recovered destination.",
          },
        ],
      },
    ];
    const parsed = parseGhidraFunctionResult("analyze_function", {
      ...dossier,
      native_api: {
        ...boundary,
        jump_tables: [
          {
            ...table,
            default_targets: defaults,
            mappings: [
              mapping,
              { ...mapping, case_value: null, target_address: "0x401030" },
            ],
          },
        ],
      },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw parsed.error;
    const output = functionDossierSchema.parse(parsed.value).native_api;
    if (output?.available !== true)
      throw new TypeError("Ghidra native API fixture is unavailable");
    expect(output.jump_tables[0]).toMatchObject({
      default_targets: defaults,
      mappings: [
        { case_value: 0, target_address: "0x401020" },
        { case_value: null, target_address: "0x401030" },
      ],
    });
  });

  it("normalizes legacy missing defaults without promoting unknown cases", () => {
    const dossier = functionDossierSchema.parse(ghidraFunctionDossier());
    const boundary = dossier.native_api;
    if (boundary?.available !== true)
      throw new TypeError("Ghidra native API fixture is unavailable");
    const table = boundary.jump_tables[0];
    const mapping = table?.mappings[0];
    if (table === undefined || mapping === undefined)
      throw new TypeError("Ghidra jump-table fixture is unavailable");
    const { default_targets: _legacyDefaults, ...legacy } = table;
    const parsed = parseGhidraFunctionResult("analyze_function", {
      ...dossier,
      native_api: {
        ...boundary,
        jump_tables: [
          { ...legacy, mappings: [{ ...mapping, case_value: null }] },
        ],
      },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw parsed.error;
    expect(functionDossierSchema.parse(parsed.value).native_api).toMatchObject({
      jump_tables: [{ default_targets: [], mappings: [{ case_value: null }] }],
    });
  });

  it("rejects non-canonical default destinations and defaults without evidence", () => {
    const dossier = functionDossierSchema.parse(ghidraFunctionDossier());
    const boundary = dossier.native_api;
    if (boundary?.available !== true)
      throw new TypeError("Ghidra native API fixture is unavailable");
    const table = boundary.jump_tables[0];
    const mapping = table?.mappings[0];
    if (table === undefined || mapping === undefined)
      throw new TypeError("Ghidra jump-table fixture is unavailable");
    for (const destination of [
      {
        target_address: "0X401020",
        confidence: "high",
        evidence: mapping.evidence,
      },
      { target_address: "0x401020", confidence: "high", evidence: [] },
    ]) {
      expect(
        parseGhidraFunctionResult("analyze_function", {
          ...dossier,
          native_api: {
            ...boundary,
            jump_tables: [{ ...table, default_targets: [destination] }],
          },
        }),
      ).toMatchObject({ ok: false, error: { _tag: "AnalysisOutputError" } });
    }
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

// Inclusive ranges are a wire-boundary fixture, not a claim of real-provider acceptance.
describe("complete Ghidra function body range evidence", () => {
  const body = () => ({
    available: true,
    provenance: "ghidra-function-body-address-set",
    ranges: [
      { start: "0x401000", end: "0x401002" },
      { start: "0x401010", end: "0x401011" },
    ],
    total_bytes: 5,
    span_bytes: 18,
    non_contiguous: true,
    contains_entry: true,
  });
  const info = () => ({
    name: "fixture_main",
    entrypoint: "0x401000",
    basicblock_count: 2,
    length: 5,
    signature: null,
    locals: [],
    classification: ghidraFunctionClassification(),
    body: body(),
  });
  it("preserves inclusive disjoint ranges and distinguishes owned bytes from enclosing span", () => {
    expect(parseGhidraFunctionResult("procedure_info", info())).toMatchObject({
      ok: true,
      value: { body: body(), length: 5 },
    });
  });
  it("rejects omitted body evidence instead of accepting a length as complete coverage", () => {
    const { body: omitted, ...withoutBody } = info();
    expect(omitted.total_bytes).toBe(5);
    expect(parseGhidraFunctionResult("procedure_info", withoutBody).ok).toBe(
      false,
    );
  });
  it("requires local entry coverage but permits an observed empty external body", () => {
    const empty = {
      ...body(),
      ranges: [],
      total_bytes: 0,
      span_bytes: 0,
      non_contiguous: false,
      contains_entry: false,
    };
    expect(
      parseGhidraFunctionResult("procedure_info", {
        ...info(),
        body: empty,
        length: 0,
      }).ok,
    ).toBe(false);
    expect(
      parseGhidraFunctionResult("procedure_info", {
        ...info(),
        classification: { ...ghidraFunctionClassification(), external: true },
        body: empty,
        length: 0,
      }).ok,
    ).toBe(true);
  });
  it("rejects a missing body on nested dossier identities", () => {
    const dossier = functionDossierSchema.parse(ghidraFunctionDossier());
    const { body: omitted, ...identity } = ghidraFunctionIdentity();
    expect(omitted.total_bytes).toBe(6);
    expect(
      parseGhidraFunctionResult("analyze_function", {
        ...dossier,
        callers: [identity],
      }).ok,
    ).toBe(false);
  });
  it("requires body length and Ghidra-specific body provenance", () => {
    expect(
      parseGhidraFunctionResult("procedure_info", { ...info(), length: 18 }).ok,
    ).toBe(false);
    expect(
      parseGhidraFunctionResult("procedure_info", {
        ...info(),
        body: { ...body(), provenance: "unreviewed" },
      }).ok,
    ).toBe(false);
  });
  it.each([
    { total_bytes: 18 },
    { span_bytes: 5 },
    { non_contiguous: false },
    { contains_entry: false },
    {
      ranges: [
        { start: "0x401000", end: "0x401002" },
        { start: "0x401002", end: "0x401004" },
      ],
    },
    { ranges: [{ start: "0x401002", end: "0x401000" }] },
  ])("rejects contradictory complete body facts %j", (change) => {
    expect(
      parseGhidraFunctionResult("procedure_info", {
        ...info(),
        body: { ...body(), ...change },
      }).ok,
    ).toBe(false);
  });
});
