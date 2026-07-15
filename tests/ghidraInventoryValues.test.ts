import { describe, expect, it } from "vitest";

import {
  GHIDRA_INVENTORY_OPERATIONS,
  isGhidraInventoryOperation,
  parseGhidraInventoryInput,
  parseGhidraInventoryResult,
  type GhidraInventoryOperation,
} from "../src/ghidra/GhidraInventoryValues.js";
import type { JsonValue } from "../src/domain/jsonValue.js";

describe("Ghidra inventory boundary values", () => {
  it("defaults bounded provider inputs without accepting undeclared fields", () => {
    expect(parseGhidraInventoryInput("list_procedures", {})).toEqual({
      ok: true,
      value: { document: null, offset: 0, limit: 100 },
    });
    expect(
      parseGhidraInventoryInput("search_strings", { pattern: "needle" }),
    ).toEqual({
      ok: true,
      value: {
        pattern: "needle",
        mode: "literal",
        case_sensitive: false,
        offset: 0,
        limit: 100,
        document: null,
      },
    });
    expect(
      parseGhidraInventoryInput("list_documents", { extra: true }),
    ).toMatchObject({ ok: false, error: { _tag: "AnalysisInputError" } });
    expect(parseGhidraInventoryInput("address_name", {})).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisInputError" },
    });
    expect(
      parseGhidraInventoryInput("procedure_address", {
        procedure: "x".repeat(4097),
      }),
    ).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisInputError" },
    });
  });

  it("keeps the admitted operation set closed", () => {
    expect(GHIDRA_INVENTORY_OPERATIONS).toHaveLength(10);
    expect(isGhidraInventoryOperation("list_names")).toBe(true);
    expect(isGhidraInventoryOperation("goto_address")).toBe(false);
    expect(isGhidraInventoryOperation("set_comment")).toBe(false);
  });

  it("parses primary, dynamic, and external symbol facts", () => {
    const items = [
      {
        address: "EXTERNAL:0x1",
        value: "libc::puts",
        value_truncated: false,
        symbol: {
          primary: true,
          dynamic: false,
          external: true,
          type: "function",
          source: "imported",
        },
      },
      {
        address: "0x401000",
        value: "LAB_00401000",
        value_truncated: false,
        symbol: {
          primary: true,
          dynamic: true,
          external: false,
          type: "label",
          source: "default",
        },
      },
    ] satisfies readonly JsonValue[];
    expect(parseGhidraInventoryResult("list_names", page(items))).toEqual({
      ok: true,
      value: page(items),
    });
  });

  it("parses thunk, string-layout, and memory-permission observations", () => {
    expect(
      parseGhidraInventoryResult(
        "list_procedures",
        page([
          {
            address: "0x401020",
            value: "puts",
            value_truncated: false,
            procedure: {
              external: false,
              thunk: true,
              thunk_target: "EXTERNAL:0x1",
            },
          },
        ]),
      ),
    ).toMatchObject({ ok: true });
    expect(
      parseGhidraInventoryResult(
        "list_strings",
        page([
          {
            address: "0x402000",
            value: "fixture",
            value_truncated: false,
            string: {
              encoding: "UTF-8",
              termination: "missing",
              byte_length: 7,
            },
          },
        ]),
      ),
    ).toMatchObject({ ok: true });
    expect(
      parseGhidraInventoryResult("list_segments", [
        {
          name: ".text",
          start: "0x401000",
          end: "0x402000",
          readable: true,
          writable: false,
          executable: true,
          permissions: { available: true, source: "ghidra-memory-block" },
          provenance: "ghidra-memory-block",
          address_space: "ram",
          image_base: "0x400000",
          initialized: true,
          overlay: false,
          sections: [],
        },
      ]),
    ).toMatchObject({ ok: true });
  });

  it.each(malformedOutputs())(
    "rejects malformed %s output",
    (_name, operation, value) => {
      expect(parseGhidraInventoryResult(operation, value)).toMatchObject({
        ok: false,
        error: { _tag: "AnalysisOutputError" },
      });
    },
  );
});

function malformedOutputs(): Array<
  [string, GhidraInventoryOperation, JsonValue]
> {
  return [
    [
      "non-canonical address",
      "list_procedures",
      page([
        {
          address: "00401000",
          value: "main",
          value_truncated: false,
          procedure: {
            external: false,
            thunk: false,
            thunk_target: null,
          },
        },
      ]),
    ],
    [
      "missing external metadata",
      "list_names",
      page([{ address: "0x401000", value: "main", value_truncated: false }]),
    ],
    [
      "contradictory continuation",
      "search_strings",
      {
        ...page([]),
        total: 1,
        has_more: false,
        next_offset: null,
      },
    ],
    [
      "non-advancing continuation",
      "list_procedures",
      {
        ...page([]),
        total: 1,
        has_more: true,
        next_offset: 0,
      },
    ],
    [
      "items beyond exact total",
      "list_procedures",
      { ...page([procedureItem()]), total: 0 },
    ],
    ["provider limit", "search_procedures", { ...page([]), limit: 101 }],
    ["multiple programs", "list_documents", ["first", "second"]],
  ];
}

function procedureItem(): JsonValue {
  return {
    address: "0x401000",
    value: "main",
    value_truncated: false,
    procedure: {
      external: false,
      thunk: false,
      thunk_target: null,
    },
  };
}

function page(items: readonly JsonValue[]) {
  return {
    items: [...items],
    offset: 0,
    limit: 500,
    total: items.length,
    next_offset: null,
    has_more: false,
  };
}
