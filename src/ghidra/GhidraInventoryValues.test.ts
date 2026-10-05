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

// Wire-boundary fixture only; real-provider acceptance belongs to the DOS verifier.
describe("containing-procedure complete body evidence", () => {
  const identity = () => ({
    address: "0x1000",
    name: "fixture_function",
    classification: {
      external: false,
      thunk: false,
      thunk_target: null,
      provenance: "ghidra-function-manager",
    },
    body: {
      available: true,
      provenance: "ghidra-function-body-address-set",
      ranges: [
        { start: "0x1000", end: "0x1002" },
        { start: "0x1020", end: "0x1021" },
      ],
      total_bytes: 5,
      span_bytes: 34,
      non_contiguous: true,
      contains_entry: true,
    },
  });
  const found = () => ({
    query_address: "0x1001",
    found: true,
    procedure: identity(),
  });
  it("accepts the Java producer identity including complete inclusive body ranges", () => {
    const value = found();
    expect(
      parseGhidraInventoryResult("resolve_containing_procedure", value),
    ).toEqual({ ok: true, value });
    expect(
      parseGhidraInventoryResult("resolve_containing_procedure", {
        ...value,
        query_address: "0x1021",
      }).ok,
    ).toBe(true);
  });
  it("rejects a missing body rather than treating a legacy identity as complete", () => {
    const { body: omitted, ...legacy } = identity();
    expect(omitted.total_bytes).toBe(5);
    expect(
      parseGhidraInventoryResult("resolve_containing_procedure", {
        ...found(),
        procedure: legacy,
      }).ok,
    ).toBe(false);
  });
  it.each([
    { total_bytes: 34 },
    { span_bytes: 5 },
    { contains_entry: false },
    { provenance: "unreviewed" },
    {
      ranges: [
        { start: "0x1000", end: "0x1002" },
        { start: "bad space:0x1020", end: "bad space:0x1021" },
      ],
      span_bytes: null,
    },
    { non_contiguous: false },
    { ranges: [{ start: "0X1000", end: "0x1002" }] },
    {
      ranges: [
        { start: "0x1000", end: "0x1002" },
        { start: "0x1002", end: "0x1004" },
      ],
    },
  ])("rejects malformed or contradictory body evidence %j", (change) => {
    const procedure = identity();
    expect(
      parseGhidraInventoryResult("resolve_containing_procedure", {
        ...found(),
        procedure: { ...procedure, body: { ...procedure.body, ...change } },
      }).ok,
    ).toBe(false);
  });
  it("accepts canonically encoded address-space endpoints with an unknown enclosing span", () => {
    const procedure = identity();
    const body = {
      ...procedure.body,
      ranges: [
        { start: "0x1000", end: "0x1002" },
        { start: "other%20space:0x1020", end: "other%20space:0x1021" },
      ],
      span_bytes: null,
    };
    expect(
      parseGhidraInventoryResult("resolve_containing_procedure", {
        ...found(),
        procedure: { ...procedure, body },
      }).ok,
    ).toBe(true);
  });

  it("does not accept a found query that lies in the gap between body ranges", () => {
    expect(
      parseGhidraInventoryResult("resolve_containing_procedure", {
        ...found(),
        query_address: "0x1010",
      }).ok,
    ).toBe(false);
  });
  it("retains explicit not-found outcomes without fabricating a body", () => {
    const value = {
      query_address: "0x1010",
      found: false,
      procedure: null,
      reason: "not_in_procedure",
    };
    expect(
      parseGhidraInventoryResult("resolve_containing_procedure", value),
    ).toEqual({ ok: true, value });
  });
});
