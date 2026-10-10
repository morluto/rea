import { describe, expect, it } from "vitest";

import type { JsonValue } from "../domain/jsonValue.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import { functionDossierSchema } from "../domain/hopperValues.js";
import {
  compactReference,
  compactInstruction,
  compactCallTargets,
} from "../domain/native/nativeInstruction.fixture.js";
import {
  parseGhidraFunctionResult,
  type GhidraFunctionOperation,
} from "./GhidraFunctionValues.js";
import {
  ghidraFunctionClassification,
  ghidraFunctionDossier,
  ghidraFunctionIdentity,
  ghidraNativeApiBoundary,
  ghidraReferenceEdge,
} from "../domain/ghidraValues.fixture.js";

describe("Ghidra function-analysis result values", () => {
  it.each(["reference_kinds_available", "unresolved_calls"])(
    "rejects omitted %s instead of inventing complete reference observations",
    (field) => {
      const output = {
        procedure: ghidraFunctionIdentity(),
        direction: "outgoing",
        references: [ghidraReferenceEdge()],
        reference_kinds_available: true,
        unresolved_calls: [],
      };
      const incomplete = Object.fromEntries(
        Object.entries(output).filter(([key]) => key !== field),
      );
      expect(
        parseGhidraFunctionResult("procedure_references", output),
      ).toMatchObject({ ok: true });
      expect(
        parseGhidraFunctionResult("procedure_references", incomplete),
      ).toMatchObject({ ok: false, error: { _tag: "AnalysisOutputError" } });
    },
  );

  it.each(["block_membership", "parameters", "parameter_uses"])(
    "rejects a value-flow result missing %s",
    (field) => {
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
      if (!Array.isArray(flow.operations))
        throw new TypeError("Ghidra operation fixture is invalid");
      const incompleteFlow =
        field === "block_membership"
          ? {
              ...flow,
              operations: flow.operations.map((operation, index) =>
                index !== 0 ||
                typeof operation !== "object" ||
                operation === null ||
                Array.isArray(operation)
                  ? operation
                  : Object.fromEntries(
                      Object.entries(operation).filter(
                        ([key]) => key !== field,
                      ),
                    ),
              ),
            }
          : Object.fromEntries(
              Object.entries(flow).filter(([key]) => key !== field),
            );

      expect(
        parseGhidraFunctionResult(
          "analyze_function",
          jsonValueSchema.parse({
            ...dossier,
            native_value_flow: incompleteFlow,
          }),
        ),
      ).toMatchObject({ ok: false, error: { _tag: "AnalysisOutputError" } });
    },
  );

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

describe("Ghidra compact reference provenance", () => {
  const operations = [
    ["inspect_native_instruction", compactInstruction],
    ["resolve_native_call_targets", compactCallTargets],
  ] as const;

  it.each(operations)(
    "preserves complete, legacy and unknown facts in %s",
    (operation, output) => {
      const complete = compactReference();
      const legacy = Object.fromEntries(
        Object.entries(complete).filter(
          ([key]) =>
            ![
              "source_address",
              "data",
              "read",
              "write",
              "primary",
              "provenance",
              "source",
            ].includes(key),
        ),
      );
      const unknown = {
        ...legacy,
        source_address: null,
        data: null,
        read: null,
        write: null,
        primary: null,
        provenance: null,
        source: null,
      };
      for (const reference of [complete, legacy, unknown]) {
        const expected = output([reference]);
        const parsed = parseGhidraFunctionResult(operation, expected);
        if (!parsed.ok) throw parsed.error;
        expect(parsed.value).toEqual(expected);
      }
    },
  );

  it.each(operations)(
    "rejects malformed present provenance in %s",
    (operation, output) => {
      for (const [field, value] of [
        ["source_address", 1],
        ["data", "true"],
        ["read", 1],
        ["write", 0],
        ["primary", "false"],
        ["provenance", ""],
        ["source", false],
      ] as const) {
        expect(
          parseGhidraFunctionResult(
            operation,
            output([{ ...compactReference(), [field]: value }]),
          ),
        ).toMatchObject({
          ok: false,
          error: { _tag: "AnalysisOutputError" },
        });
      }
    },
  );
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

  it("rejects omitted default observations instead of repairing obsolete bridge output", () => {
    const dossier = functionDossierSchema.parse(ghidraFunctionDossier());
    const boundary = dossier.native_api;
    if (boundary?.available !== true)
      throw new TypeError("Ghidra native API fixture is unavailable");
    const table = boundary.jump_tables[0];
    const mapping = table?.mappings[0];
    if (table === undefined || mapping === undefined)
      throw new TypeError("Ghidra jump-table fixture is unavailable");
    const { default_targets: omittedDefaults, ...withoutDefaults } = table;
    expect(omittedDefaults).toHaveLength(1);
    const parsed = parseGhidraFunctionResult("analyze_function", {
      ...dossier,
      native_api: {
        ...boundary,
        jump_tables: [
          { ...withoutDefaults, mappings: [{ ...mapping, case_value: null }] },
        ],
      },
    });
    expect(parsed).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisOutputError" },
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
