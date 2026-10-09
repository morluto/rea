import { describe, expect, it } from "vitest";

import { FUNCTION_COMPARISON_EXAMPLE } from "../contracts/functionComparisonExample.js";
import { enhancedInputSchemas } from "../contracts/enhancedInputs.js";
import {
  compareFunctions,
  functionComparisonResultSchema,
} from "./functionComparison.js";
import { createEvidence, type Evidence } from "./evidence.js";
import { functionDossierSchema } from "./hopperValues.js";
import { canonicalDigest, canonicalJson } from "./comparisonSemantics.js";
import { compareCodePoints } from "./canonicalOrdering.js";
import { jsonValueSchema } from "./jsonValue.js";

const dossier = (
  text: string,
  base: "0x1000" | "0x2000",
  successors: readonly string[] = [],
) =>
  functionDossierSchema.parse({
    procedure: {
      address: base,
      name: "main",
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
    basic_blocks: [
      {
        start: base,
        end: base === "0x1000" ? "0x1001" : "0x2001",
        successors,
      },
    ],
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
        source_procedure: { address: base, name: "main" },
        target_procedure: { address: target, name: "helper" },
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
    },
  );

describe("function comparison normalized identity", () => {
  it.each(["sub_deallocate", "sub_deadbeef_handler", "fcn.dispatch"])(
    "recognizes the explicit symbol %s without a generated-name prefix false positive",
    (name) => {
      const named = (base: "0x1000" | "0x2000") =>
        functionDossierSchema.parse({
          ...dossier("return 0;", base),
          procedure: {
            address: base,
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

  it.each(["sub_deadbeef", "fcn.00401000"])(
    "keeps %s as an address-derived name",
    (name) => {
      const generated = (base: "0x1000" | "0x2000") =>
        functionDossierSchema.parse({
          ...dossier("return 0;", base),
          procedure: {
            address: base,
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
  ])("preserves the calls dimension for callee $name", ({ name, status }) => {
    const calling = (base: "0x1000" | "0x2000") =>
      functionDossierSchema.parse({
        ...dossier("return helper();", base),
        callees: [{ address: base === "0x1000" ? "0x1010" : "0x2010", name }],
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

describe("function collection collation ties", () => {
  const composed = { address: "0x2000", name: "caf\u00e9" };
  const decomposed = { address: "0x3000", name: "cafe\u0301" };
  const calling = (
    callees: readonly { readonly address: string; readonly name: string }[],
  ) =>
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
      (name, index) => ({
        address: `0x${(0x2000 + index).toString(16)}`,
        name,
      }),
    );
    const canonicalProjection = callees
      .map(({ name }) => ({ direction: "out", name }))
      .sort((left, right) =>
        compareCodePoints(canonicalJson(left), canonicalJson(right)),
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
      left_digest: canonicalDigest(canonicalProjection),
      right_digest: canonicalDigest(canonicalProjection),
    });
  });
});

describe("function comparison ordering controls", () => {
  const composed = { address: "0x2000", name: "caf\u00e9" };
  const decomposed = { address: "0x3000", name: "cafe\u0301" };

  it("preserves duplicate Unicode collections and nullable endpoints", () => {
    const controlled = (base: "0x1000" | "0x2000", reverse: boolean) => {
      const endpoint = base === "0x1000" ? "0x1010" : "0x2010";
      const edges = [
        {
          source_address: base,
          target_address: endpoint,
          source_procedure: null,
          target_procedure: { address: endpoint, name: "caf\u00e9" },
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
          source_procedure: { address: base, name: "dispatch" },
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
        },
      );
    const left = controlled("0x1000", false);
    const right = controlled("0x2000", true);
    const { native_api: _nativeApi, ...rightWithoutNativeApi } = right;

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

  it("does not promote address-derived names through equal signatures", () => {
    const autoDossier = (base: "0x1000" | "0x2000") =>
      functionDossierSchema.parse({
        ...dossier("return 0;", base),
        procedure: {
          address: base,
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
