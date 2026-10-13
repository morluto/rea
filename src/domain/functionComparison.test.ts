import { describe, expect, it } from "vitest";

import { FUNCTION_COMPARISON_EXAMPLE } from "../contracts/functionComparisonExample.js";
import { enhancedInputSchemas } from "../contracts/enhancedInputs.js";
import { functionComparisonResultSchema } from "./functionComparisonSchemas.js";
import { createEvidence, type Evidence } from "./evidence.js";
import { functionDossierSchema } from "./hopperValues.js";
import { canonicalJson } from "./comparisonSemantics.js";
import { digestCanonicalValue } from "./canonicalDigest.js";
import { compareUnicodeCodePoints } from "./unicodeCodePointOrder.js";
import { jsonValueSchema } from "./jsonValue.js";

import { compareFunctions } from "./functionComparison.js";
import type { RelationshipCoverage } from "./relationshipCoverage.js";
const procedure = (address: string, name: string) => ({
  address,
  name,
  classification: null,
  body: {
    available: false as const,
    reason:
      "Hopper's public Python API does not expose complete function body ranges",
  },
});
const dossier = (
  text: string,
  base: "0x1000" | "0x2000",
  successors: readonly string[] = [],
) =>
  functionDossierSchema.parse({
    procedure: {
      ...procedure(base, "main"),
      signature: "int main(void)",
      locals: [],
    },
    pseudocode: text,
    assembly: ["ret"],
    comments: [],
    callers: [],
    callees: [],
    incoming_references: [],
    outgoing_references: [],
    referenced_strings: [],
    referenced_names: [],
    native_api: null,
    native_value_flow: null,
    facet_availability: {
      pseudocode: { available: true },
      assembly: { available: true },
      comments: { available: true },
      callers: { available: true },
      callees: { available: true },
      references: { available: true },
      strings_names: { available: true },
      cfg: { available: true },
    },
    basic_blocks: [
      {
        start: base,
        end: base === "0x1000" ? "0x1001" : "0x2001",
        successors,
      },
    ],
    limitations: [],
  });

const dossierWithReference = (
  base: "0x1000" | "0x2000",
  kind: "call" | "data" | "unavailable",
) => {
  const target = base === "0x1000" ? "0x1010" : "0x2010";
  return functionDossierSchema.parse({
    ...dossier("return helper();", base),
    outgoing_references: [
      {
        source_address: base,
        target_address: target,
        source_procedure: procedure(base, "main"),
        target_procedure: procedure(target, "helper"),
        kind:
          kind === "unavailable"
            ? { available: false, reason: "provider has no kind authority" }
            : {
                available: true,
                provenance: "ghidra-reference-manager",
                type: kind === "call" ? "UNCONDITIONAL_CALL" : "READ",
                flow: kind === "call",
                call: kind === "call",
                jump: false,
                data: kind === "data",
                read: kind === "data",
                write: false,
                indirect: false,
                computed: false,
                conditional: false,
                terminal: false,
                primary: true,
                operand_index: 0,
                external: false,
              },
      },
    ],
  });
};

const observe = (
  digit: string,
  value: ReturnType<typeof dossier>,
  providerId = "rea-workflow",
  relationshipCoverage: RelationshipCoverage | null = { status: "complete" },
): Evidence =>
  createEvidence(
    {
      path: `/tmp/function-${digit}`,
      sha256: digit.repeat(64),
      format: "mach-o",
    },
    { id: providerId, name: providerId, version: "1" },
    {
      operation: "analyze_function",
      parameters: enhancedInputSchemas.analyze_function.parse({
        procedure: "main",
      }),
      result: jsonValueSchema.parse(value),
      confidence: "derived",
      authority: "shipped-artifact",
      ...(relationshipCoverage === null ? {} : { relationshipCoverage }),
    },
  );

const rejectsMalformedFacetAvailability = (): void => {
  expect(
    functionDossierSchema.safeParse({
      ...dossier("return 0;", "0x1000"),
      facet_availability: { cfg: { available: false, reason: "" } },
    }).success,
  ).toBe(false);
  expect(
    functionDossierSchema.safeParse({
      ...dossier("return 0;", "0x1000"),
      facet_availability: { cfg: undefined },
    }).success,
  ).toBe(false);
};

const keepsGeneratedNamesAmbiguous = (): void => {
  const named = (base: "0x1000" | "0x2000", name: string) =>
    functionDossierSchema.parse({
      ...dossier("return 0;", base),
      procedure: {
        ...procedure(base, name),
        signature: "int helper(void)",
        locals: [],
      },
    });
  const generated = compareFunctions(
    observe("1", named("0x1000", "sub_1000")),
    observe("2", named("0x2000", "sub_2000")),
  );
  expect(generated.function_match.status).toBe("ambiguous");
  expect(generated.status).toBe("unknown");
  expect(
    generated.dimensions.find(({ dimension }) => dimension === "identity"),
  ).toMatchObject({ status: "unknown" });

  const stable = compareFunctions(
    observe("3", named("0x1000", "firstFunction")),
    observe("4", named("0x2000", "secondFunction")),
  );
  expect(stable.function_match.status).toBe("mismatched");
  expect(stable.status).toBe("changed");
};

describe("function comparison normalized identity", () => {
  it("retains unresolved call details alongside missing facet coverage", () => {
    const value: Record<string, unknown> = {
      ...dossier("return 0;", "0x1000"),
      unresolved_calls: [{ address: "0x1010", reason: "Unknown indirect target" }],
    };
    delete value.facet_availability;
    const legacy = observe("a", functionDossierSchema.parse(value), "ida");
    const calls = compareFunctions(legacy, legacy).dimensions.find(
      ({ dimension }) => dimension === "calls",
    );
    expect(calls).toMatchObject({
      status: "unknown",
      limitations: expect.arrayContaining([
        "Left: Unresolved call at 0x1010: Unknown indirect target",
        "Left: callers: Provider did not declare coverage for this empty facet.",
      ]),
    });
  });
  it("keeps empty legacy facets without coverage declarations unknown", () => {
    const value: Record<string, unknown> = {
      ...dossier("return 0;", "0x1000"),
      basic_blocks: [],
    };
    delete value.facet_availability;
    const legacy = observe("a", functionDossierSchema.parse(value), "ida");
    const result = compareFunctions(legacy, legacy);
    for (const dimension of [
      "comments",
      "references",
      "strings_names",
      "cfg",
      "calls",
    ]) {
      expect(
        result.dimensions.find((item) => item.dimension === dimension),
      ).toMatchObject({ status: "unknown" });
    }
  });
  it("keeps unavailable facets unknown even when one side supplies values", () => {
    const left = observe(
      "a",
      functionDossierSchema.parse({
        ...dossier("return 0;", "0x1000"),
        facet_availability: {
          comments: { available: false, reason: "Not collected" },
        },
        comments: [
          { address: "0x1000", kind: "comment", text: "partial record" },
        ],
      }),
    );
    const right = observe("b", dossier("return 0;", "0x2000"));
    expect(
      compareFunctions(left, right).dimensions.find(
        ({ dimension }) => dimension === "comments",
      ),
    ).toMatchObject({ status: "unknown", left_count: null, right_count: null });
  });
  it(
    "rejects malformed facet availability instead of treating it as absence",
    rejectsMalformedFacetAvailability,
  );
  it(
    "keeps differing generated names ambiguous and stable names mismatched",
    keepsGeneratedNamesAmbiguous,
  );

  it.each(["sub_deallocate", "sub_deadbeef_handler", "fcn.dispatch"])(
    "recognizes the explicit symbol %s without a generated-name prefix false positive",
    (name) => {
      const named = (base: "0x1000" | "0x2000") =>
        functionDossierSchema.parse({
          ...dossier("return 0;", base),
          procedure: {
            ...procedure(base, name),
            name,
            signature: "int helper(void)",
            locals: [],
          },
        });
      const result = compareFunctions(
        observe("b", named("0x1000")),
        observe("c", named("0x2000")),
      );
      expect(result.function_match).toMatchObject({
        status: "matched",
        method: "symbol",
      });
      expect(
        result.dimensions.find(({ dimension }) => dimension === "identity"),
      ).toMatchObject({ status: "unchanged" });
    },
  );

  it.each(["sub_deadbeef", "fcn.00401000", "FUN_deadBEEF"])(
    "keeps %s as an address-derived name",
    (name) => {
      const generated = (base: "0x1000" | "0x2000") =>
        functionDossierSchema.parse({
          ...dossier("return 0;", base),
          procedure: {
            ...procedure(base, name),
            name,
            signature: "int helper(void)",
            locals: [],
          },
        });
      const result = compareFunctions(
        observe("d", generated("0x1000")),
        observe("e", generated("0x2000")),
      );
      expect(result.function_match.status).toBe("ambiguous");
      expect(
        result.dimensions.find(({ dimension }) => dimension === "identity"),
      ).toMatchObject({ status: "unknown" });
    },
  );
  it.each([
    { name: "sub_deallocate", status: "unchanged" },
    { name: "sub_deadbeef", status: "unknown" },
    { name: "FUN_00401000", status: "unknown" },
    { name: "FUN_initialize", status: "unchanged" },
  ])("preserves the calls dimension for callee $name", ({ name, status }) => {
    const calling = (base: "0x1000" | "0x2000") =>
      functionDossierSchema.parse({
        ...dossier("return helper();", base),
        callees: [procedure(base === "0x1000" ? "0x1010" : "0x2010", name)],
      });
    const result = compareFunctions(
      observe("6", calling("0x1000")),
      observe("7", calling("0x2000")),
    );
    expect(
      result.dimensions.find(({ dimension }) => dimension === "calls"),
    ).toMatchObject({ status });
  });
});

describe("function call relationship coverage", () => {
  const coverageCases: {
    readonly label: string;
    readonly coverage: RelationshipCoverage | null;
    readonly limitation: string;
  }[] = [
    {
      label: "missing",
      coverage: null,
      limitation: "Provider did not report relationship coverage.",
    },
    {
      label: "partial",
      coverage: {
        status: "partial",
        limitations: ["Call graph stopped at the read limit."],
      },
      limitation: "Call graph stopped at the read limit.",
    },
  ];
  it.each(coverageCases)(
    "keeps equal empty calls unknown for $label coverage",
    ({ coverage, limitation }) => {
      const left = observe("a", dossier("return 0;", "0x1000"));
      const right = observe(
        "b",
        dossier("return 0;", "0x2000"),
        "rea-workflow",
        coverage,
      );
      const result = compareFunctions(left, right);
      const calls = result.dimensions.find(
        ({ dimension }) => dimension === "calls",
      );
      expect(calls).toMatchObject({
        status: "unknown",
        conclusion_kind: "unresolved_branch",
        left_count: 0,
        right_count: 0,
        limitations: [`Right: ${limitation}`],
      });
      expect(result.status).toBe("unknown");
    },
  );

  it("retains complete observations with execution diagnostics as comparable", () => {
    const coverage = {
      status: "complete" as const,
      diagnostics: ["Provider reported a non-call xref warning."],
    };
    const left = observe(
      "c",
      dossier("return 0;", "0x1000"),
      "rea-workflow",
      coverage,
    );
    const right = observe(
      "d",
      dossier("return 0;", "0x2000"),
      "rea-workflow",
      coverage,
    );
    expect(
      compareFunctions(left, right).dimensions.find(
        ({ dimension }) => dimension === "calls",
      ),
    ).toMatchObject({ status: "unchanged", left_count: 0, right_count: 0 });
  });

  it("keeps unresolved call sites unknown despite complete resolved-set coverage", () => {
    const left = observe("e", dossier("return 0;", "0x1000"));
    const rightDossier = functionDossierSchema.parse({
      ...dossier("return 0;", "0x2000"),
      unresolved_calls: [
        {
          address: "0x2010",
          reason: "Indirect dispatch target could not be resolved.",
        },
      ],
    });
    const right = observe("f", rightDossier);
    expect(
      compareFunctions(left, right).dimensions.find(
        ({ dimension }) => dimension === "calls",
      ),
    ).toMatchObject({
      status: "unknown",
      limitations: [
        "Right: Unresolved call at 0x2010: Indirect dispatch target could not be resolved.",
      ],
    });
  });
});

describe("function collection collation ties", () => {
  const composed = procedure("0x2000", "caf\u00e9");
  const decomposed = procedure("0x3000", "cafe\u0301");
  const calling = (callees: readonly ReturnType<typeof procedure>[]) =>
    functionDossierSchema.parse({
      ...dossier("return 0;", "0x1000"),
      callees,
    });

  it("ignores reordered callees whose distinct names collate equally", () => {
    const result = compareFunctions(
      observe("b", calling([composed, decomposed])),
      observe("c", calling([decomposed, composed])),
    );
    expect(result.status).toBe("unchanged");
    const calls = result.dimensions.find(
      ({ dimension }) => dimension === "calls",
    );
    expect(calls).toMatchObject({
      status: "unchanged",
      left_count: 2,
      right_count: 2,
    });
    expect(calls?.left_digest).toBe(calls?.right_digest);
  });

  it.each([
    ["remove composed", [decomposed]],
    ["remove decomposed", [composed]],
    ["replace composed", [decomposed, decomposed]],
    ["replace decomposed", [composed, composed]],
  ] as const)("preserves an exact name change: %s", (_label, changed) => {
    const result = compareFunctions(
      observe("b", calling([composed, decomposed])),
      observe("c", calling(changed)),
    );
    expect(result.status).toBe("changed");
    const calls = result.dimensions.find(
      ({ dimension }) => dimension === "calls",
    );
    expect(calls).toMatchObject({ status: "changed" });
    expect(calls?.left_digest).not.toBe(calls?.right_digest);
  });

  it("uses canonical code-point ordering for collection digests", () => {
    const callees = ["zeta", "Alpha", "alpha", "_helper", "beta"].map(
      (name, index) => procedure(`0x${(0x2000 + index).toString(16)}`, name),
    );
    const canonicalProjection = callees
      .map(({ name }) => ({ direction: "out", name }))
      .sort((left, right) =>
        compareUnicodeCodePoints(canonicalJson(left), canonicalJson(right)),
      );
    const result = compareFunctions(
      observe("b", calling(callees)),
      observe("c", calling([...callees].reverse())),
    );
    const calls = result.dimensions.find(
      ({ dimension }) => dimension === "calls",
    );
    expect(calls).toMatchObject({
      status: "unchanged",
      left_digest: digestCanonicalValue(canonicalProjection),
      right_digest: digestCanonicalValue(canonicalProjection),
    });
  });
});

describe("function comparison ordering controls", () => {
  const composed = procedure("0x2000", "caf\u00e9");
  const decomposed = procedure("0x3000", "cafe\u0301");

  it("preserves duplicate Unicode collections and nullable endpoints", () => {
    const controlled = (base: "0x1000" | "0x2000", reverse: boolean) => {
      const endpoint = base === "0x1000" ? "0x1010" : "0x2010";
      const edges = [
        {
          source_address: base,
          target_address: endpoint,
          source_procedure: null,
          target_procedure: procedure(endpoint, "caf\u00e9"),
          kind: {
            available: true,
            provenance: "provider-reference-manager",
            type: "UNCONDITIONAL_CALL",
            flow: true,
            call: true,
            jump: false,
            data: false,
            read: false,
            write: false,
            indirect: false,
            computed: false,
            conditional: false,
            terminal: false,
            primary: true,
            operand_index: 0,
            external: false,
          },
        },
        {
          source_address: base,
          target_address: endpoint,
          source_procedure: procedure(base, "dispatch"),
          target_procedure: null,
          kind: {
            available: true,
            provenance: "provider-reference-manager",
            type: "READ",
            flow: false,
            call: false,
            jump: false,
            data: true,
            read: true,
            write: false,
            indirect: false,
            computed: false,
            conditional: false,
            terminal: false,
            primary: true,
            operand_index: 1,
            external: false,
          },
        },
      ];
      const strings = [
        { address: endpoint, source_address: base, value: "caf\u00e9" },
        { address: endpoint, source_address: base, value: "cafe\u0301" },
        { address: endpoint, source_address: base, value: "cafe\u0301" },
      ];
      return functionDossierSchema.parse({
        ...dossier("return 0;", base),
        callees: [composed, decomposed, composed],
        incoming_references: reverse ? [...edges].reverse() : edges,
        outgoing_references: reverse ? [...edges].reverse() : edges,
        referenced_strings: reverse ? [...strings].reverse() : strings,
        referenced_names: reverse ? [...strings].reverse() : strings,
      });
    };
    const makeEvidence = (digit: string, result: unknown): Evidence =>
      createEvidence(
        {
          path: `/tmp/function-${digit}`,
          sha256: digit.repeat(64),
          format: "mach-o",
        },
        { id: "rea-workflow", name: "REA workflow", version: "1" },
        {
          operation: "analyze_function",
          parameters: enhancedInputSchemas.analyze_function.parse({
            procedure: "dispatch",
          }),
          result: jsonValueSchema.parse(result),
          confidence: "derived",
          authority: "shipped-artifact",
          relationshipCoverage: { status: "complete" },
        },
      );
    const left = controlled("0x1000", false);
    const right = controlled("0x2000", true);
    const rightWithoutNativeApi = { ...right, native_api: null };

    const comparison = compareFunctions(
      makeEvidence("d", left),
      makeEvidence("e", rightWithoutNativeApi),
    );

    expect(comparison.status).toBe("unchanged");
    for (const dimension of ["calls", "references", "strings_names"] as const)
      expect(
        comparison.dimensions.find((item) => item.dimension === dimension),
      ).toMatchObject({ status: "unchanged" });
  });
});

describe("function comparison CFG address normalization", () => {
  it("matches CFG successors by numeric address", () => {
    const make = (base: "0x1000" | "0x2000") =>
      functionDossierSchema.parse({
        ...dossier("return 0;", base),
        basic_blocks: [
          {
            start: base,
            end: base === "0x1000" ? "0x1004" : "0x2004",
            successors: [base === "0x1000" ? "0X01004" : "0x2004"],
          },
          {
            start: base === "0x1000" ? "0x1004" : "0x2004",
            end: base === "0x1000" ? "0x1008" : "0x2008",
            successors: [],
          },
        ],
      });
    expect(
      compareFunctions(
        observe("b", make("0x1000")),
        observe("c", make("0x2000")),
      ).dimensions.find(({ dimension }) => dimension === "cfg"),
    ).toMatchObject({ status: "unchanged" });
  });

  it("keeps duplicate numeric block starts unknown", () => {
    const duplicate = functionDossierSchema.parse({
      ...dossier("return 0;", "0x1000"),
      basic_blocks: [
        { start: "0x1000", end: "0x1004", successors: [] },
        { start: "0X01000", end: "0x1008", successors: [] },
      ],
    });
    expect(
      compareFunctions(
        observe("d", duplicate),
        observe("e", duplicate),
      ).dimensions.find(({ dimension }) => dimension === "cfg"),
    ).toMatchObject({ status: "unknown" });
  });
});

describe("function comparison unresolved text", () => {
  it("counts Unicode text consistently for unresolved provider comparisons", () => {
    const left = observe("b", dossier("return '😀';", "0x1000"), "provider-a");
    const right = observe("c", dossier("return '😀';", "0x2000"), "provider-b");
    const comparison = compareFunctions(left, right);
    expect(
      comparison.dimensions.find(({ dimension }) => dimension === "pseudocode"),
    ).toMatchObject({ status: "unknown", left_count: 11, right_count: 11 });
    expect(comparison.summary).toEqual({
      unchanged: 6,
      changed: 0,
      unknown: 2,
    });
    expect(
      functionComparisonResultSchema.safeParse({
        ...comparison,
        status: "truncated",
      }).success,
    ).toBe(false);
  });
});

describe("function comparison", () => {
  it("preserves text changes alongside complete inline dossier facets", () => {
    const result = compareFunctions(
      FUNCTION_COMPARISON_EXAMPLE.left,
      FUNCTION_COMPARISON_EXAMPLE.right,
    );
    expect(functionComparisonResultSchema.parse(result)).toMatchObject({
      status: "changed",
      function_match: { status: "matched", method: "symbol" },
    });
    expect(result.dimensions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ dimension: "pseudocode", status: "changed" }),
        expect.objectContaining({ dimension: "assembly", status: "unchanged" }),
        expect.objectContaining({
          dimension: "references",
          status: "unchanged",
        }),
      ]),
    );
    expectInlineComparisonEvidence(result);
    expectFunctionDimensionAlgebra(result);
  });

  it("normalizes CFG relocation but preserves changed edges and constants", () => {
    const left = observe("2", dossier("return 0x10;", "0x1000"));
    const relocated = observe("3", dossier("return 0x10;", "0x2000"));
    const same = compareFunctions(left, relocated);
    expect(
      same.dimensions.find(({ dimension }) => dimension === "cfg"),
    ).toMatchObject({
      status: "unchanged",
    });
    expect(
      same.dimensions.find(({ dimension }) => dimension === "pseudocode"),
    ).toMatchObject({ status: "unchanged" });

    const changed = observe("4", dossier("return 0x20;", "0x2000", ["0x2000"]));
    const comparison = compareFunctions(left, changed);
    expect(
      comparison.dimensions.find(({ dimension }) => dimension === "cfg"),
    ).toMatchObject({ status: "changed" });
    expect(
      comparison.dimensions.find(({ dimension }) => dimension === "pseudocode"),
    ).toMatchObject({ status: "changed" });
  });

  it("treats provider-specific text as unknown and validates Evidence", () => {
    const left = observe("5", dossier("return 0;", "0x1000"), "provider-a");
    const right = observe("6", dossier("return 1;", "0x2000"), "provider-b");
    const comparison = compareFunctions(left, right);
    expect(
      comparison.dimensions.find(({ dimension }) => dimension === "pseudocode"),
    ).toMatchObject({ status: "unknown" });
    expect(comparison.changes).toHaveLength(2);
    expect(() =>
      compareFunctions({ ...left, operation: "binary_overview" }, right),
    ).toThrow(/identifier/u);
  });

  it("reports fully observed identical dossiers as unchanged", () => {
    const left = observe("7", dossier("return 0;\n", "0x1000"));
    const right = observe("8", dossier("return 0;\n", "0x2000"));
    const comparison = compareFunctions(left, right);
    expect(comparison.status).toBe("unchanged");
    expect(
      comparison.dimensions.every(({ status }) => status === "unchanged"),
    ).toBe(true);
  });

  it("compares exact reference kinds only when both providers expose them", () => {
    const left = observe("d", dossierWithReference("0x1000", "call"));
    const same = observe("e", dossierWithReference("0x2000", "call"));
    expect(
      compareFunctions(left, same).dimensions.find(
        ({ dimension }) => dimension === "references",
      ),
    ).toMatchObject({ status: "unchanged" });

    const changed = observe("f", dossierWithReference("0x2000", "data"));
    expect(
      compareFunctions(left, changed).dimensions.find(
        ({ dimension }) => dimension === "references",
      ),
    ).toMatchObject({ status: "changed" });

    const unavailable = observe(
      "1",
      dossierWithReference("0x2000", "unavailable"),
    );
    expect(
      compareFunctions(left, unavailable).dimensions.find(
        ({ dimension }) => dimension === "references",
      ),
    ).toMatchObject({
      status: "unknown",
      limitations: [expect.stringContaining("did not expose reference kinds")],
    });
  });
});

describe("function comparison identity and malformed CFG", () => {
  it("does not promote address-derived names through equal signatures", () => {
    const autoDossier = (base: "0x1000" | "0x2000") =>
      functionDossierSchema.parse({
        ...dossier("return 0;", base),
        procedure: {
          ...procedure(base, "sub_1000"),
          name: "sub_1000",
          signature: "int helper(void)",
          locals: [],
        },
      });
    const comparison = compareFunctions(
      observe("9", autoDossier("0x1000")),
      observe("a", autoDossier("0x2000")),
    );
    expect(comparison.function_match.status).toBe("ambiguous");
    expect(
      comparison.dimensions.find(({ dimension }) => dimension === "identity"),
    ).toMatchObject({ status: "unknown" });
    expect(comparison.status).toBe("unknown");
    const changedText = compareFunctions(
      observe("b", autoDossier("0x1000")),
      observe(
        "c",
        functionDossierSchema.parse({
          ...autoDossier("0x2000"),
          pseudocode: "return 1;",
        }),
      ),
    );
    expect(changedText.dimensions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ dimension: "pseudocode", status: "changed" }),
      ]),
    );
    expect(changedText.status).toBe("unknown");
  });

  it("rejects invalid CFG normalization and preserves newline differences", () => {
    const leftDossier = dossier("line\r\n", "0x1000");
    const invalidCfg = functionDossierSchema.parse({
      ...dossier("line\n", "0x2000"),
      basic_blocks: [
        { start: "0x2000", end: "0x2001", successors: [] },
        { start: "0x2000", end: "0x2002", successors: [] },
      ],
    });
    const comparison = compareFunctions(
      observe("b", leftDossier),
      observe("c", invalidCfg),
    );
    expect(
      comparison.dimensions.find(({ dimension }) => dimension === "cfg"),
    ).toMatchObject({ status: "unknown" });
    const pseudocode = comparison.dimensions.find(
      ({ dimension }) => dimension === "pseudocode",
    );
    expect(pseudocode).toMatchObject({ status: "changed" });
    expect(pseudocode?.left_digest).not.toBe(pseudocode?.right_digest);
  });
});

const withLiterals = (base: "0x1000" | "0x2000", values: readonly string[]) =>
  functionDossierSchema.parse({
    ...dossier("return 0;", base),
    swift_string_literals: values.map((value) => ({
      source_address: base,
      value,
      representation: "small" as const,
      address: null,
      registers: ["x0", "x1"] as const,
      words: ["0x0", "0xe"] as const,
    })),
  });
const stringsDimension = (
  leftDigit: string,
  left: ReturnType<typeof withLiterals> | ReturnType<typeof dossier>,
  rightDigit: string,
  right: ReturnType<typeof withLiterals> | ReturnType<typeof dossier>,
) =>
  compareFunctions(
    observe(leftDigit, left),
    observe(rightDigit, right),
  ).dimensions.find(({ dimension }) => dimension === "strings_names");

describe("function comparison Swift string literals", () => {
  it("treats differing decoded literals as a strings and names change", () => {
    expect(
      stringsDimension(
        "1",
        withLiterals("0x1000", ["SleepDisabled"]),
        "2",
        withLiterals("0x2000", ["Holding awake"]),
      ),
    ).toMatchObject({ status: "changed" });
  });

  it("matches the same decoded literal after the function is relocated", () => {
    expect(
      stringsDimension(
        "3",
        withLiterals("0x1000", ["SleepDisabled"]),
        "4",
        withLiterals("0x2000", ["SleepDisabled"]),
      ),
    ).toMatchObject({ status: "unchanged" });
  });

  it("keeps strings and names unknown when only one dossier recorded Swift literals", () => {
    expect(
      stringsDimension(
        "5",
        withLiterals("0x1000", []),
        "6",
        dossier("return 0;", "0x2000"),
      ),
    ).toMatchObject({
      status: "unknown",
      limitations: [
        "Swift String literal coverage differs or is partial; referenced strings and names match, and complete coverage does not establish a differing literal.",
      ],
    });
  });

  it("reports a referenced name change even when Swift literal coverage differs", () => {
    const named = functionDossierSchema.parse({
      ...dossier("return 0;", "0x2000"),
      referenced_names: [
        { address: "0x3000", value: "helper", source_address: "0x2000" },
      ],
    });
    expect(
      stringsDimension("7", withLiterals("0x1000", []), "8", named),
    ).toMatchObject({ status: "changed" });
  });
});

describe("function comparison partial Swift literal coverage", () => {
  it("does not equate a partial literal record with a complete one", () => {
    const partial = functionDossierSchema.parse({
      ...withLiterals("0x2000", ["SleepDisabled"]),
      swift_string_literal_omissions: [
        {
          source_address: "0x2000",
          representation: "large",
          address: "0x3000",
          byte_length: 64,
          reason: "capacity",
          registers: ["x0", "x1"],
          words: ["0xd000000000000040", "0x8000000000002fe0"],
        },
      ],
    });
    expect(
      stringsDimension(
        "9",
        withLiterals("0x1000", ["SleepDisabled"]),
        "a",
        partial,
      ),
    ).toMatchObject({ status: "unknown" });
  });

  it("reports a literal that a complete dossier shows absent at a site the partial one decoded", () => {
    const partial = functionDossierSchema.parse({
      ...withLiterals("0x2000", ["SleepDisabled"]),
      swift_string_literal_omissions: [
        {
          source_address: "0x2004",
          representation: "small",
          address: null,
          byte_length: 4,
          reason: "capacity",
          registers: ["x0", "x1"],
          words: ["0x732f4220", "0xe400000000000000"],
        },
      ],
    });
    expect(
      stringsDimension("d", withLiterals("0x1000", []), "e", partial),
    ).toMatchObject({ status: "changed" });
  });

  it("does not interpret an unexamined path as a missing literal at a retained site", () => {
    const partial = functionDossierSchema.parse({
      ...withLiterals("0x2000", ["A"]),
      swift_string_literal_omissions: [
        {
          source_address: "0x2004",
          representation: "small",
          address: null,
          byte_length: 0,
          reason: "capacity",
          registers: ["x0", "x1"],
          words: ["0x0", "0xe000000000000000"],
        },
      ],
    });
    const complete = withLiterals("0x1000", ["A", "B"]);
    expect(stringsDimension("1", complete, "2", partial)).toMatchObject({
      status: "unknown",
    });
    expect(stringsDimension("3", partial, "4", complete)).toMatchObject({
      status: "unknown",
    });
    expect(
      stringsDimension("5", withLiterals("0x1000", []), "6", partial),
    ).toMatchObject({ status: "changed" });
  });

  it("treats an omission record without decoded literals as partial coverage", () => {
    const omissionOnly = functionDossierSchema.parse({
      ...dossier("return 0;", "0x2000"),
      swift_string_literal_omissions: [
        {
          source_address: "0x2004",
          representation: "small",
          address: null,
          byte_length: 4,
          reason: "capacity",
          registers: ["x0", "x1"],
          words: ["0x732f4220", "0xe400000000000000"],
        },
      ],
    });
    expect(
      stringsDimension("f", dossier("return 0;", "0x1000"), "0", omissionOnly),
    ).toMatchObject({ status: "unknown" });
  });

  it("keeps different retained representations unknown when both dossiers are partial", () => {
    const omission = {
      source_address: "0x1004",
      representation: "small",
      address: null,
      byte_length: 4,
      reason: "capacity",
      registers: ["x0", "x1"],
      words: ["0x732f4220", "0xe400000000000000"],
    } as const;
    const small = functionDossierSchema.parse({
      ...withLiterals("0x1000", ["SleepDisabled"]),
      swift_string_literal_omissions: [omission],
    });
    const large = functionDossierSchema.parse({
      ...dossier("return 0;", "0x2000"),
      swift_string_literals: [
        {
          source_address: "0x2000",
          value: "SleepDisabled",
          representation: "large",
          address: "0x3000",
          registers: ["x0", "x1"],
          words: ["0xd00000000000000d", "0x8000000000002fe0"],
        },
      ],
      swift_string_literal_omissions: [
        { ...omission, source_address: "0x2004" },
      ],
    });
    expect(stringsDimension("1", small, "2", large)).toMatchObject({
      status: "unknown",
    });
  });

  it("keeps different retained literals unknown when both dossiers are partial", () => {
    const partial = (base: "0x1000" | "0x2000", value: string) =>
      functionDossierSchema.parse({
        ...withLiterals(base, [value]),
        swift_string_literal_omissions: [
          {
            source_address: base === "0x1000" ? "0x1004" : "0x2004",
            representation: "large",
            address: "0x3000",
            byte_length: 64,
            reason: "capacity",
            registers: ["x0", "x1"],
            words: ["0xd000000000000040", "0x8000000000002fe0"],
          },
        ],
      });
    expect(
      stringsDimension(
        "b",
        partial("0x1000", "SleepDisabled"),
        "c",
        partial("0x2000", "Holding awake"),
      ),
    ).toMatchObject({ status: "unknown" });
  });
});

const expectInlineComparisonEvidence = (
  result: ReturnType<typeof compareFunctions>,
): void => {
  for (const dimension of result.dimensions)
    expect(dimension.evidence_links).toEqual([
      FUNCTION_COMPARISON_EXAMPLE.left.evidence_id,
      FUNCTION_COMPARISON_EXAMPLE.right.evidence_id,
    ]);
  const firstDimension = result.dimensions[0];
  expect(firstDimension).toBeDefined();
  if (firstDimension === undefined) return;
  expect(
    functionComparisonResultSchema.safeParse({
      ...result,
      dimensions: result.dimensions.map((dimension, index) =>
        index === 0
          ? {
              ...dimension,
              evidence_links: Array.from(
                { length: 201 },
                () => FUNCTION_COMPARISON_EXAMPLE.left.evidence_id,
              ),
            }
          : dimension,
      ),
    }).success,
  ).toBe(true);
};

const expectFunctionDimensionAlgebra = (
  result: ReturnType<typeof compareFunctions>,
): void => {
  const observed = result.dimensions.find(
    ({ status }) => status === "unchanged" || status === "changed",
  );
  expect(observed).toBeDefined();
  if (observed === undefined) return;
  expect(
    functionComparisonResultSchema.safeParse({
      ...result,
      dimensions: [
        { ...observed, left_digest: null, right_digest: null },
        ...result.dimensions.slice(1),
      ],
    }).success,
  ).toBe(false);
  expect(
    functionComparisonResultSchema.safeParse({
      ...result,
      function_match: { ...result.function_match, method: "explicit" },
    }).success,
  ).toBe(false);
};

it.each([
  { match: "mismatched", changedDimensions: false, expected: "changed" },
  { match: "ambiguous", changedDimensions: false, expected: "unknown" },
  { match: "ambiguous", changedDimensions: true, expected: "unknown" },
] as const)(
  "validates $match match precedence with changed dimensions=$changedDimensions",
  ({ match, changedDimensions, expected }) => {
    const result = compareFunctions(
      FUNCTION_COMPARISON_EXAMPLE.left,
      changedDimensions
        ? FUNCTION_COMPARISON_EXAMPLE.right
        : FUNCTION_COMPARISON_EXAMPLE.left,
    );
    const candidate = {
      ...result,
      function_match: {
        status: match,
        method: "explicit",
        left_name: "main",
        right_name: "other",
      },
    };
    expect(
      functionComparisonResultSchema.safeParse({
        ...candidate,
        status: expected,
      }).success,
    ).toBe(true);
    for (const status of ["unchanged", "changed", "unknown"] as const) {
      if (status === expected) continue;
      const parsed = functionComparisonResultSchema.safeParse({
        ...candidate,
        status,
      });
      expect(parsed.success).toBe(false);
      if (!parsed.success)
        expect(parsed.error.issues).toMatchObject([
          {
            path: ["status"],
            code: "custom",
            message:
              "Function comparison status contradicts its dimensions or function match.",
          },
        ]);
    }
  },
);
