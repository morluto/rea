import { expect, it, vi } from "vitest";

import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";
import { onlyBinding } from "./javascriptSemanticAnalysis.fixture.js";
import type { JavaScriptSemanticIr } from "./javascriptSemanticIr.js";

/** Count AST ancestry lookups made while analyzing one source. */
const ancestryReads = (
  source: string,
  inspect: (ir: JavaScriptSemanticIr) => void,
): number => {
  const original = WeakMap.prototype.get;
  let reads = 0;
  const get = vi.spyOn(WeakMap.prototype, "get").mockImplementation(function (
    this: WeakMap<object, unknown>,
    key,
  ) {
    const value: unknown = original.call(this, key);
    if (
      typeof value === "object" &&
      value !== null &&
      "type" in value &&
      typeof value.type === "string"
    )
      reads++;
    return value;
  });
  try {
    inspect(analyzeJavaScriptSemantics(source));
    return reads;
  } finally {
    get.mockRestore();
  }
};

it("bounds ancestry reads for repeated deep lexical references", () => {
  const reads = (depth: number): number =>
    ancestryReads(
      `const a=1; module.exports.value=${"a+(".repeat(depth)}a${")".repeat(depth)};`,
      (ir) => {
        expect(ir.coverage).toEqual({ status: "complete", omittedCount: 0 });
        expect(onlyBinding(ir, "a").value).toEqual({
          status: "literal",
          value: 1,
        });
      },
    );

  const smaller = reads(80);
  const larger = reads(160);
  expect(smaller).toBeGreaterThan(0);
  expect(larger).toBeLessThan(3 * smaller);
});

it.each([
  [
    "object",
    (index: number) => `var s${String(index + 1)}={x:s${String(index)}};`,
  ],
  [
    "array",
    (index: number) => `var s${String(index + 1)}=[s${String(index)}];`,
  ],
  [
    "sequence-assigned object",
    (index: number) =>
      `var s${String(index + 1)}; 0, s${String(index + 1)}={x:s${String(index)}};`,
  ],
])(
  "keeps the expression depth budget across a chain of %s wrappers",
  (_, wrap) => {
    // Reusing each wrapper's value for the next would nest without limit.
    const nesting = (length: number): number => {
      const ir = analyzeJavaScriptSemantics(
        `var s0={};${Array.from({ length: length - 1 }, (unused, index) => wrap(index)).join("")}`,
      );
      let value = onlyBinding(ir, `s${String(length - 1)}`).value;
      let depth = 0;
      while (value.status === "object" || value.status === "array") {
        const [slot] =
          value.status === "object" ? value.properties : value.items;
        if (slot === undefined) return depth;
        value = slot.value;
        depth++;
      }
      expect(value).toMatchObject({ resourceLimit: "expression-depth" });
      expect(ir.coverage.status).toBe("partial");
      return depth;
    };

    expect(nesting(40)).toBe(39);
    const bounded = nesting(300);
    expect(bounded).toBeLessThan(256);
    expect(nesting(600)).toBe(bounded);
  },
);

it.each([
  ["an object", "{ value: 1 }", "object"],
  ["a self-referential namespace", "s0 || {}", "ambiguous"],
  ["an unknown parameter", "seed", "unknown"],
])(
  "bounds nested closures that alias %s from the enclosing scope",
  (_, root, status) => {
    // Each closure reads its parent's local once live and once at its own
    // capture point; re-deriving the parent each time doubles work per level.
    const reads = (depth: number): number =>
      ancestryReads(
        `function f0(seed){ var s0=${root};${Array.from(
          { length: depth - 1 },
          (unused, index) =>
            ` function f${String(index + 1)}(){ var s${String(index + 1)}=s${String(index)};`,
        ).join("")}${"}".repeat(depth)}`,
        (ir) => {
          expect(ir.coverage).toEqual({ status: "complete", omittedCount: 0 });
          expect(onlyBinding(ir, `s${String(depth - 1)}`).value).toEqual(
            onlyBinding(ir, "s1").value,
          );
          expect(onlyBinding(ir, "s1").value.status).toBe(status);
        },
      );

    const smaller = reads(8);
    const larger = reads(16);
    expect(smaller).toBeGreaterThan(0);
    // Doubling per level would multiply the reads by 256.
    expect(larger).toBeLessThan(8 * smaller);
  },
);
