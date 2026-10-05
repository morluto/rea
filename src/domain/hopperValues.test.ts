import { describe, expect, it } from "vitest";

import {
  functionBodySchema,
  procedureIdentitySchema,
  parseDocuments,
  parseListCount,
  parseNames,
  parseProcedures,
  parseRelatedAddresses,
  parseSegments,
} from "./hopperValues.js";

describe("Hopper boundary values", () => {
  it("parses Hopper's address-keyed name and string maps", () => {
    expect(parseNames({ "0x1000": "_main" })).toEqual({
      ok: true,
      value: [{ address: "0x1000", name: "_main" }],
    });
    expect(
      parseListCount({ "0x1000": "hello", "0x2000": "world" }, "strings"),
    ).toEqual({ ok: true, value: 2 });
  });

  it("parses direct and wrapped protocol shapes", () => {
    expect(parseProcedures({ procedures: { "0x1": "main" } })).toEqual({
      ok: true,
      value: [{ address: "0x1", name: "main" }],
    });
    expect(parseNames({ names: [{ address: "0x2", name: "label" }] }).ok).toBe(
      true,
    );
    expect(parseNames({ items: [{ address: "0x2", value: "label" }] }).ok).toBe(
      false,
    );
    expect(parseRelatedAddresses({ callers: ["0x3"] }, "callers")).toEqual({
      ok: true,
      value: ["0x3"],
    });
    expect(
      parseSegments([
        {
          name: "__TEXT",
          start: "0x1",
          end: "0x2",
          readable: true,
          writable: false,
          executable: null,
        },
      ]),
    ).toEqual({
      ok: true,
      value: [
        {
          name: "__TEXT",
          start: "0x1",
          end: "0x2",
          readable: true,
          writable: false,
          executable: null,
        },
      ],
    });
    expect(parseDocuments(["fixture"])).toEqual({
      ok: true,
      value: ["fixture"],
    });
  });

  it.each([
    ["procedures", () => parseProcedures(["not-a-map"])],
    ["names", () => parseNames([{ address: 1, name: "bad" }])],
    ["relations", () => parseRelatedAddresses([1], "callees")],
    ["segments", () => parseSegments([{ name: 1 }])],
    ["documents", () => parseDocuments([1])],
  ])(
    "rejects malformed %s instead of manufacturing empty output",
    (_label, parse) => {
      const result = parse();
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error._tag).toBe("HopperProtocolError");
    },
  );
});

describe("provider-neutral inclusive function body evidence", () => {
  const observed = () => ({
    available: true,
    provenance: "test-address-set",
    ranges: [
      { start: "0x1000", end: "0x1002" },
      { start: "0x1010", end: "0x1011" },
    ],
    total_bytes: 5,
    span_bytes: 18,
    non_contiguous: true,
    contains_entry: true,
  });
  it("represents missing Hopper extent explicitly as unknown", () => {
    expect(
      procedureIdentitySchema.parse({ address: "0x1000", name: "main" }).body,
    ).toEqual({
      available: false,
      reason: "The provider did not report complete function body ranges.",
    });
  });
  it("counts inclusive one-byte ranges without assuming an enclosing continuous body", () => {
    expect(
      functionBodySchema.safeParse({
        ...observed(),
        ranges: [{ start: "0x1000", end: "0x1000" }],
        total_bytes: 1,
        span_bytes: 1,
        non_contiguous: false,
      }).success,
    ).toBe(true);
    expect(functionBodySchema.parse(observed())).toMatchObject({
      total_bytes: 5,
      span_bytes: 18,
    });
  });
  it("preserves address-space identity and leaves a multi-space span unknown", () => {
    expect(
      functionBodySchema.safeParse({
        ...observed(),
        ranges: [
          { start: "a:0x1000", end: "a:0x1000" },
          { start: "b:0x1000", end: "b:0x1001" },
        ],
        total_bytes: 3,
        span_bytes: null,
      }).success,
    ).toBe(true);
    expect(
      functionBodySchema.safeParse({
        ...observed(),
        ranges: [{ start: "a:0x1000", end: "b:0x1000" }],
      }).success,
    ).toBe(false);
  });
  it("allows an observed empty set without manufacturing entry membership", () => {
    expect(
      procedureIdentitySchema.safeParse({
        address: "0x1000",
        name: "external",
        body: {
          ...observed(),
          ranges: [],
          total_bytes: 0,
          span_bytes: 0,
          non_contiguous: false,
          contains_entry: false,
        },
      }).success,
    ).toBe(true);
  });
  it("checks entry membership using address space and inclusive endpoints", () => {
    expect(
      procedureIdentitySchema.safeParse({
        address: "0x1002",
        name: "last",
        body: observed(),
      }).success,
    ).toBe(true);
    expect(
      procedureIdentitySchema.safeParse({
        address: "0x1003",
        name: "gap",
        body: observed(),
      }).success,
    ).toBe(false);
    expect(
      procedureIdentitySchema.safeParse({
        address: "other:0x1000",
        name: "other",
        body: observed(),
      }).success,
    ).toBe(false);
  });
  it.each([
    { total_bytes: 18 },
    { span_bytes: 5 },
    { non_contiguous: false },
    {
      ranges: [
        { start: "0x1000", end: "0x1002" },
        { start: "0x1003", end: "0x1004" },
      ],
    },
    {
      ranges: [
        { start: "0x1000", end: "0x1002" },
        { start: "0x1002", end: "0x1004" },
      ],
    },
    {
      ranges: [
        { start: "0x1010", end: "0x1011" },
        { start: "0x1000", end: "0x1002" },
      ],
    },
    {
      ranges: [{ start: "0x0", end: "0x20000000000000" }],
      total_bytes: Number.MAX_SAFE_INTEGER,
      span_bytes: Number.MAX_SAFE_INTEGER,
      non_contiguous: false,
    },
  ])("rejects contradictory or unsafe range facts %j", (change) => {
    expect(
      functionBodySchema.safeParse({ ...observed(), ...change }).success,
    ).toBe(false);
  });
});
