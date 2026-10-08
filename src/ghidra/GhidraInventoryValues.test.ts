import { describe, expect, it } from "vitest";

import { parseGhidraInventoryResult } from "./GhidraInventoryValues.js";

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
});
