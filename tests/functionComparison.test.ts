import { describe, expect, it } from "vitest";

import { FUNCTION_COMPARISON_EXAMPLE } from "../src/contracts/functionComparisonExample.js";
import { enhancedInputSchemas } from "../src/contracts/enhancedInputs.js";
import {
  compareFunctions,
  functionComparisonResultSchema,
} from "../src/domain/functionComparison.js";
import { createEvidence, type Evidence } from "../src/domain/evidence.js";
import { functionDossierSchema } from "../src/domain/hopperValues.js";
import { jsonValueSchema } from "../src/domain/jsonValue.js";

const bounded = <Item>(items: readonly Item[]) => ({
  items,
  total: items.length,
  returned: items.length,
  truncated: false,
  next_offset: null,
});

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
    pseudocode: {
      text,
      total_chars: [...text].length,
      returned_chars: [...text].length,
      truncated: false,
      next_offset: null,
    },
    assembly: bounded(["ret"]),
    comments: bounded([]),
    callers: bounded([]),
    callees: bounded([]),
    incoming_references: bounded([]),
    outgoing_references: bounded([]),
    referenced_strings: bounded([]),
    referenced_names: bounded([]),
    basic_blocks: bounded([
      {
        start: base,
        end: base === "0x1000" ? "0x1001" : "0x2001",
        successors,
      },
    ]),
    instruction_scan: { scanned: 1, truncated: false },
  });

const dossierWithReference = (
  base: "0x1000" | "0x2000",
  kind: "call" | "data" | "unavailable",
) => {
  const target = base === "0x1000" ? "0x1010" : "0x2010";
  return functionDossierSchema.parse({
    ...dossier("return helper();", base),
    outgoing_references: bounded([
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
    ]),
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
        include_assembly: true,
      }),
      result: jsonValueSchema.parse(value),
      confidence: "derived",
      authority: "shipped-artifact",
    },
  );

describe("function comparison", () => {
  it("preserves observed text changes while unavailable facets stay unknown", () => {
    const result = compareFunctions(
      FUNCTION_COMPARISON_EXAMPLE.left,
      FUNCTION_COMPARISON_EXAMPLE.right,
      0,
      100,
    );
    expect(functionComparisonResultSchema.parse(result)).toMatchObject({
      status: "unknown",
      function_match: { status: "matched", method: "symbol" },
    });
    expect(result.dimensions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ dimension: "pseudocode", status: "changed" }),
        expect.objectContaining({ dimension: "assembly", status: "unknown" }),
        expect.objectContaining({
          dimension: "references",
          status: "unchanged",
        }),
      ]),
    );
    for (const dimension of result.dimensions)
      expect(dimension.evidence_links).toEqual([
        FUNCTION_COMPARISON_EXAMPLE.left.evidence_id,
        FUNCTION_COMPARISON_EXAMPLE.right.evidence_id,
      ]);
  });

  it("normalizes CFG relocation but preserves changed edges and constants", () => {
    const left = observe("2", dossier("return 0x10;", "0x1000"));
    const relocated = observe("3", dossier("return 0x10;", "0x2000"));
    const same = compareFunctions(left, relocated, 0, 100);
    expect(
      same.dimensions.find(({ dimension }) => dimension === "cfg"),
    ).toMatchObject({
      status: "unchanged",
    });
    expect(
      same.dimensions.find(({ dimension }) => dimension === "pseudocode"),
    ).toMatchObject({ status: "unchanged" });

    const changed = observe("4", dossier("return 0x20;", "0x2000", ["0x2000"]));
    const comparison = compareFunctions(left, changed, 0, 100);
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
    const comparison = compareFunctions(left, right, 0, 1);
    expect(
      comparison.dimensions.find(({ dimension }) => dimension === "pseudocode"),
    ).toMatchObject({ status: "unknown" });
    expect(comparison.changes).toMatchObject({ limit: 1, next_offset: 1 });
    expect(() =>
      compareFunctions({ ...left, operation: "binary_overview" }, right, 0, 10),
    ).toThrow(/identifier/u);
  });

  it("reports fully observed identical dossiers as unchanged", () => {
    const left = observe("7", dossier("return 0;\n", "0x1000"));
    const right = observe("8", dossier("return 0;\n", "0x2000"));
    const comparison = compareFunctions(left, right, 0, 100);
    expect(comparison.status).toBe("unchanged");
    expect(
      comparison.dimensions.every(({ status }) => status === "unchanged"),
    ).toBe(true);
  });

  it("compares exact reference kinds only when both providers expose them", () => {
    const left = observe("d", dossierWithReference("0x1000", "call"));
    const same = observe("e", dossierWithReference("0x2000", "call"));
    expect(
      compareFunctions(left, same, 0, 100).dimensions.find(
        ({ dimension }) => dimension === "references",
      ),
    ).toMatchObject({ status: "unchanged" });

    const changed = observe("f", dossierWithReference("0x2000", "data"));
    expect(
      compareFunctions(left, changed, 0, 100).dimensions.find(
        ({ dimension }) => dimension === "references",
      ),
    ).toMatchObject({ status: "changed" });

    const unavailable = observe(
      "1",
      dossierWithReference("0x2000", "unavailable"),
    );
    expect(
      compareFunctions(left, unavailable, 0, 100).dimensions.find(
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
      0,
      100,
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
      basic_blocks: bounded([
        { start: "0x2000", end: "0x2001", successors: [] },
        { start: "0x2000", end: "0x2002", successors: [] },
      ]),
    });
    const comparison = compareFunctions(
      observe("b", leftDossier),
      observe("c", invalidCfg),
      0,
      100,
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
