import { describe, expect, it } from "vitest";
import { AnalysisInputError } from "../analysisErrorCore.js";
import {
  identifyLibraryFunctions,
  MAX_LIBRARY_SIGNATURE_PATTERN_TOKENS,
} from "./libraryFunctionIdentification.js";

const signature = (
  id: string,
  pattern: string,
  overrides: Record<string, unknown> = {},
) => ({
  id,
  name: id,
  library: "libc",
  pattern,
  ...overrides,
});

describe("identifyLibraryFunctions matching", () => {
  it("matches exact signatures at the function start", () => {
    expect(
      identifyLibraryFunctions(
        [{ function_id: "f1", bytes: [0x55, 0x48, 0x89, 0xe5] }],
        [signature("memcpy", "55 48 89 E5")],
      ),
    ).toEqual({
      ok: true,
      value: {
        identified: [
          {
            function_id: "f1",
            matches: [
              {
                signature_id: "memcpy",
                name: "memcpy",
                library: "libc",
                library_version: null,
                pattern_length: 4,
                wildcard_count: 0,
                score: 1,
                confidence: "exact",
              },
            ],
          },
        ],
        unknowns: [],
      },
    });
  });

  it("matches wildcards and reports pattern confidence", () => {
    const result = identifyLibraryFunctions(
      [{ function_id: "f1", bytes: [0x55, 0x48, 0x8b, 0xe5] }],
      [signature("memcpy", "55 48 ?? E5")],
    );
    if (!result.ok) throw result.error;
    expect(result.value.identified[0]?.matches[0]).toMatchObject({
      wildcard_count: 1,
      score: 0.75,
      confidence: "pattern",
    });
  });

  it("does not match a signature that is longer than the function", () => {
    const result = identifyLibraryFunctions(
      [{ function_id: "f1", bytes: [0x55] }],
      [signature("short", "55 ?? ??")],
    );
    if (!result.ok) throw result.error;
    expect(result.value.identified[0]?.matches).toEqual([]);
  });

  it("matches wildcard signatures at the exact function length", () => {
    const result = identifyLibraryFunctions(
      [{ function_id: "f1", bytes: [0x55, 0x48, 0xe5] }],
      [signature("exact-length", "55 ?? E5")],
    );
    if (!result.ok) throw result.error;
    expect(result.value.identified[0]?.matches[0]).toMatchObject({
      signature_id: "exact-length",
      pattern_length: 3,
      wildcard_count: 1,
      confidence: "pattern",
    });
  });

  it("anchors patterns at offset zero", () => {
    const result = identifyLibraryFunctions(
      [{ function_id: "f1", bytes: [0x90, 0x55, 0x48, 0x89, 0xe5] }],
      [signature("memcpy", "55 48 89 E5")],
    );
    if (!result.ok) throw result.error;
    expect(result.value.identified[0]?.matches).toEqual([]);
  });

  it("keeps all equally valid signatures with deterministic ranking", () => {
    const result = identifyLibraryFunctions(
      [{ function_id: "f1", bytes: [0x55, 0x48, 0x89, 0xe5] }],
      [
        signature("short", "55 48 ??"),
        signature("exact-z", "55 48 89 E5"),
        signature("exact-a", "55 48 89 E5"),
      ],
    );
    if (!result.ok) throw result.error;
    expect(
      result.value.identified[0]?.matches.map((match) => match.signature_id),
    ).toEqual(["exact-a", "exact-z", "short"]);
  });

  it("preserves optional library versions", () => {
    const result = identifyLibraryFunctions(
      [{ function_id: "f1", bytes: [0x90] }],
      [signature("nop", "90", { library_version: "2.39" })],
    );
    if (!result.ok) throw result.error;
    expect(result.value.identified[0]?.matches[0]?.library_version).toBe(
      "2.39",
    );
  });
});

describe("identifyLibraryFunctions budget skips", () => {
  it("reports functions beyond the function budget as unknown", () => {
    const result = identifyLibraryFunctions(
      [
        { function_id: "f1", bytes: [0x90] },
        { function_id: "f2", bytes: [0x90] },
      ],
      [signature("nop", "90")],
      { max_functions: 1 },
    );
    if (!result.ok) throw result.error;
    expect(result.value.unknowns).toEqual([
      { function_id: "f2", reason: "function_budget_exceeded" },
    ]);
  });

  it("enforces the function budget before validating skipped bytes", () => {
    const result = identifyLibraryFunctions(
      [
        { function_id: "f1", bytes: [0x90] },
        { function_id: "f2", bytes: ["not a byte"] },
      ],
      [signature("nop", "90")],
      { max_functions: 1 },
    );
    if (!result.ok) throw result.error;
    expect(result.value.unknowns).toEqual([
      { function_id: "f2", reason: "function_budget_exceeded" },
    ]);
  });

  it("does not read bytes for functions skipped by the function budget", () => {
    const result = identifyLibraryFunctions(
      [
        { function_id: "f1", bytes: [0x90] },
        {
          function_id: "f2",
          get bytes(): never {
            throw new Error("skipped bytes were read");
          },
        },
      ],
      [signature("nop", "90")],
      { max_functions: 1 },
    );
    if (!result.ok) throw result.error;
    expect(result.value.unknowns).toEqual([
      { function_id: "f2", reason: "function_budget_exceeded" },
    ]);
  });

  it("reports oversized function bytes as unknown", () => {
    const result = identifyLibraryFunctions(
      [{ function_id: "f1", bytes: [0x90, 0x90] }],
      [signature("nop", "90")],
      { max_function_bytes: 1 },
    );
    if (!result.ok) throw result.error;
    expect(result.value.unknowns).toEqual([
      { function_id: "f1", reason: "function_bytes_budget_exceeded" },
    ]);
  });

  it("enforces the byte budget before validating oversized bytes", () => {
    const result = identifyLibraryFunctions(
      [{ function_id: "f1", bytes: [0x90, "not a byte"] }],
      [signature("nop", "90")],
      { max_function_bytes: 1 },
    );
    if (!result.ok) throw result.error;
    expect(result.value.unknowns).toEqual([
      { function_id: "f1", reason: "function_bytes_budget_exceeded" },
    ]);
  });

  it("accepts functions at the exact count and byte limits", () => {
    const result = identifyLibraryFunctions(
      [
        { function_id: "f1", bytes: [0x90] },
        { function_id: "f2", bytes: [0x90] },
      ],
      [signature("nop", "90")],
      { max_functions: 2, max_function_bytes: 1 },
    );
    if (!result.ok) throw result.error;
    expect(result.value.identified.map((input) => input.function_id)).toEqual([
      "f1",
      "f2",
    ]);
    expect(result.value.unknowns).toEqual([]);
  });
});

describe("identifyLibraryFunctions signature constraints", () => {
  it("enforces the signature budget before validating signatures", () => {
    const result = identifyLibraryFunctions(
      [],
      [signature("first", "90"), { invalid: true }],
      { max_signatures: 1 },
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisInputError",
        operation: "identify_library_functions",
        issues: [
          expect.objectContaining({
            path: [],
            reason: "out_of_range",
            maximum: 1,
          }),
        ],
      },
    });
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(AnalysisInputError);
    }
  });

  it("rejects duplicate signature ids", () => {
    const result = identifyLibraryFunctions(
      [],
      [signature("duplicate", "90"), signature("duplicate", "91")],
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisInputError",
        operation: "identify_library_functions",
        issues: [
          expect.objectContaining({
            path: [1, "id"],
            reason: "invalid_value",
          }),
        ],
      },
    });
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(AnalysisInputError);
    }
  });

  it("rejects all-wildcard signatures", () => {
    const result = identifyLibraryFunctions([], [signature("wild", "?? ??")]);
    expect(result).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisInputError",
        operation: "identify_library_functions",
        issues: [
          expect.objectContaining({
            path: [0, "pattern"],
            reason: "invalid_value",
          }),
        ],
      },
    });
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(AnalysisInputError);
    }
  });

  it("enforces the total matches budget across functions", () => {
    const result = identifyLibraryFunctions(
      [
        { function_id: "f1", bytes: [0x90] },
        { function_id: "f2", bytes: [0x90] },
      ],
      [signature("first", "90"), signature("second", "90")],
      { max_matches: 3 },
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisInputError",
        operation: "identify_library_functions",
        issues: [
          expect.objectContaining({
            path: [],
            reason: "out_of_range",
            maximum: 3,
          }),
        ],
      },
    });
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(AnalysisInputError);
    }
  });
});

describe("identifyLibraryFunctions signature pattern tokens", () => {
  it("rejects patterns over the token cap", () => {
    const result = identifyLibraryFunctions(
      [],
      [
        signature(
          "long",
          "90 ".repeat(MAX_LIBRARY_SIGNATURE_PATTERN_TOKENS + 1),
        ),
      ],
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisInputError",
        operation: "identify_library_functions",
        issues: [
          expect.objectContaining({
            path: [0, "pattern"],
            reason: "invalid_value",
          }),
        ],
      },
    });
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(AnalysisInputError);
    }
  });

  it("accepts the token limit with mixed whitespace and rejects oversized tokens", () => {
    const pattern = Array.from(
      { length: MAX_LIBRARY_SIGNATURE_PATTERN_TOKENS },
      () => "90",
    ).join(" \n\t");
    const result = identifyLibraryFunctions(
      [
        {
          function_id: "f",
          bytes: Array(MAX_LIBRARY_SIGNATURE_PATTERN_TOKENS).fill(0x90),
        },
      ],
      [signature("bounded", pattern)],
    );
    if (!result.ok) throw result.error;
    expect(result.value.identified[0]?.matches[0]?.pattern_length).toBe(
      MAX_LIBRARY_SIGNATURE_PATTERN_TOKENS,
    );
    const bad = identifyLibraryFunctions(
      [],
      [signature("bad", "9".repeat(100_000))],
    );
    expect(bad).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisInputError",
        operation: "identify_library_functions",
        issues: [
          expect.objectContaining({
            path: [0, "pattern"],
            reason: "invalid_value",
          }),
        ],
      },
    });
    if (!bad.ok) {
      expect(bad.error).toBeInstanceOf(AnalysisInputError);
    }
  });

  it("rejects malformed hexadecimal patterns with an error Result", () => {
    const badHex = identifyLibraryFunctions(
      [],
      [signature("bad-hex", "ZZ 90")],
    );
    expect(badHex).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisInputError",
        operation: "identify_library_functions",
      },
    });
    if (!badHex.ok) {
      expect(badHex.error).toBeInstanceOf(AnalysisInputError);
    }

    const oddNibble = identifyLibraryFunctions([], [signature("odd", "9")]);
    expect(oddNibble).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisInputError",
        operation: "identify_library_functions",
      },
    });
  });
});

describe("identifyLibraryFunctions input errors", () => {
  it("rejects invalid resource budgets with an error Result", () => {
    const negativeFunctions = identifyLibraryFunctions([], [], {
      max_functions: -1,
    });
    expect(negativeFunctions).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisInputError",
        operation: "identify_library_functions",
      },
    });
    if (!negativeFunctions.ok) {
      expect(negativeFunctions.error).toBeInstanceOf(AnalysisInputError);
    }

    const zeroSignatures = identifyLibraryFunctions([], [], {
      max_signatures: 0,
    });
    expect(zeroSignatures).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisInputError",
        operation: "identify_library_functions",
      },
    });

    const invalidType = identifyLibraryFunctions([], [], "invalid");
    expect(invalidType).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisInputError",
        operation: "identify_library_functions",
      },
    });
  });

  it("rejects non-array inputs with an error Result", () => {
    const badFunctions = identifyLibraryFunctions("not an array" as never, []);
    expect(badFunctions).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisInputError",
        operation: "identify_library_functions",
      },
    });

    const badSignatures = identifyLibraryFunctions([], "not an array" as never);
    expect(badSignatures).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisInputError",
        operation: "identify_library_functions",
      },
    });
  });

  it("rejects invalid function inputs with an error Result", () => {
    const emptyId = identifyLibraryFunctions(
      [{ function_id: "", bytes: [0x90] }],
      [signature("nop", "90")],
    );
    expect(emptyId).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisInputError",
        operation: "identify_library_functions",
      },
    });

    const invalidBytes = identifyLibraryFunctions(
      [{ function_id: "f1", bytes: [300] }],
      [signature("nop", "90")],
    );
    expect(invalidBytes).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisInputError",
        operation: "identify_library_functions",
      },
    });
  });
});
