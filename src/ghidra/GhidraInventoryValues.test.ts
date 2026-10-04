import { describe, expect, it } from "vitest";

import {
  isGhidraInventoryOperation,
  parseGhidraInventoryInput,
  parseGhidraInventoryResult,
} from "./GhidraInventoryValues.js";

describe("Ghidra inventory boundary values", () => {
  it("accepts complete inventories and searches without page controls", () => {
    expect(parseGhidraInventoryInput("list_procedures", {})).toEqual({
      ok: true,
      value: { document: null },
    });
    expect(
      parseGhidraInventoryInput("search_strings", { pattern: "needle" }),
    ).toEqual({
      ok: true,
      value: {
        pattern: "needle",
        mode: "literal",
        case_sensitive: false,
        document: null,
      },
    });
    expect(
      parseGhidraInventoryInput("list_procedures", { limit: 100 }),
    ).toMatchObject({ ok: false, error: { _tag: "AnalysisInputError" } });
    expect(
      parseGhidraInventoryInput("list_documents", { extra: true }),
    ).toMatchObject({ ok: false, error: { _tag: "AnalysisInputError" } });
  });

  it("keeps the admitted operation set closed", () => {
    expect(isGhidraInventoryOperation("list_names")).toBe(true);
    expect(isGhidraInventoryOperation("goto_address")).toBe(false);
    expect(isGhidraInventoryOperation("set_comment")).toBe(false);
  });

  it("returns complete typed inventory arrays", () => {
    const procedures = Array.from({ length: 700 }, (_, index) => ({
      address: `0x${(0x401000 + index).toString(16)}`,
      value: `sub_${index}`,
      procedure: { external: false, thunk: false, thunk_target: null },
    }));
    expect(parseGhidraInventoryResult("list_procedures", procedures)).toEqual({
      ok: true,
      value: procedures,
    });
  });

  it("rejects malformed inventory items", () => {
    expect(
      parseGhidraInventoryResult("list_procedures", [
        {
          address: "00401000",
          value: "main",
          procedure: { external: false, thunk: false, thunk_target: null },
        },
      ]),
    ).toMatchObject({ ok: false, error: { _tag: "AnalysisOutputError" } });
    expect(
      parseGhidraInventoryResult("search_strings", [{ address: "0x1000" }]),
    ).toMatchObject({ ok: false, error: { _tag: "AnalysisOutputError" } });
  });
});
