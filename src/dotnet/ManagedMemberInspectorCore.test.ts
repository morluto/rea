import { fc, it } from "@fast-check/vitest";
import { describe, expect } from "vitest";

import {
  createDeclaringTypeLookup,
  declaringType,
  type TypeRange,
} from "./ManagedMemberInspectorCore.js";

const range = (
  name: string,
  fieldStart: number,
  fieldEnd: number,
  methodStart = fieldStart,
  methodEnd = fieldEnd,
): TypeRange => ({
  token: name,
  fullName: name,
  fieldStart,
  fieldEnd,
  methodStart,
  methodEnd,
});

describe("managed declaring type ownership", () => {
  it("resolves field and method boundaries independently, including empty types and gaps", () => {
    const ranges = [
      range("first", 1, 3, 1, 1),
      range("empty", 3, 3, 1, 1),
      range("last", 5, 7, 1, 4),
    ];
    const field = createDeclaringTypeLookup(ranges, "field");
    const method = createDeclaringTypeLookup(ranges, "method");
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(field)).toEqual([
      null,
      { token: "first", fullName: "first" },
      { token: "first", fullName: "first" },
      null,
      null,
      { token: "last", fullName: "last" },
      { token: "last", fullName: "last" },
      null,
    ]);
    expect([0, 1, 2, 3, 4].map(method)).toEqual([
      null,
      { token: "last", fullName: "last" },
      { token: "last", fullName: "last" },
      { token: "last", fullName: "last" },
      null,
    ]);
  });

  it("retains the first observed owner for overlapping, reversed, or out-of-order ranges", () => {
    const ranges = [
      range("first", 5, 9),
      range("overlap", 1, 7),
      range("reversed", 10, 2),
    ];
    const lookup = createDeclaringTypeLookup(ranges, "method");
    expect(lookup(6)).toEqual({ token: "first", fullName: "first" });
    expect(lookup(2)).toEqual({ token: "overlap", fullName: "overlap" });
    expect(lookup(10)).toBeNull();
    expect(createDeclaringTypeLookup([], "method")(1)).toBeNull();
  });

  it.prop([
    fc.array(
      fc.record({
        fieldStart: fc.integer({ min: 0, max: 30 }),
        fieldEnd: fc.integer({ min: 0, max: 30 }),
        methodStart: fc.integer({ min: 0, max: 30 }),
        methodEnd: fc.integer({ min: 0, max: 30 }),
      }),
      { maxLength: 20 },
    ),
  ])(
    "agrees with observed first-match ownership for arbitrary metadata ranges",
    (raw) => {
      const ranges = raw.map((value, index) => ({
        ...value,
        token: String(index),
        fullName: `Type${String(index)}`,
      }));
      for (const table of ["field", "method"] as const) {
        const lookup = createDeclaringTypeLookup(ranges, table);
        for (const row of [
          NaN,
          -Infinity,
          Infinity,
          ...Array.from({ length: 32 }, (_, i) => i),
        ])
          expect(lookup(row)).toEqual(declaringType(ranges, table, row));
      }
    },
  );
});
