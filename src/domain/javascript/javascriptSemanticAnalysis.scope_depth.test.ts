import { expect, it, vi } from "vitest";

import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";
import { onlyBinding } from "./javascriptSemanticAnalysis.fixture.js";

it("bounds ancestry reads for repeated deep lexical references", () => {
  const ancestryReads = (depth: number): number => {
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
      const ir = analyzeJavaScriptSemantics(
        `const a=1; module.exports.value=${"a+(".repeat(depth)}a${")".repeat(depth)};`,
      );
      expect(ir.coverage).toEqual({ status: "complete", omittedCount: 0 });
      expect(onlyBinding(ir, "a").value).toEqual({
        status: "literal",
        value: 1,
      });
      return reads;
    } finally {
      get.mockRestore();
    }
  };

  const smaller = ancestryReads(80);
  const larger = ancestryReads(160);
  expect(smaller).toBeGreaterThan(0);
  expect(larger).toBeLessThan(3 * smaller);
});
