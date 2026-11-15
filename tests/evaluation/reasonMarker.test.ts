import { expect, it } from "vitest";
import { unmarkedMatchCount } from "../../scripts/verify/reason-marker.mjs";

const slice = /\.slice\(\s*0\s*,\s*[A-Z][A-Z0-9_]*\s*\)/gu;
const names = ["generation-cap", "sample-cap"];
const count = (raw: string) => unmarkedMatchCount(raw, slice, names);

it("counts an unmarked slice", () => {
  expect(count("const a = items.slice(0, MAX);")).toBe(1);
});

it("exempts a slice marked above or trailing with a reason", () => {
  expect(
    count("// generation-cap: suggested checks\nconst a = s.slice(0, MAX);"),
  ).toBe(0);
  expect(
    count(
      "// sample-cap: examples;\n// totals are reported\nconst a = s.slice(0, MAX);",
    ),
  ).toBe(0);
  expect(count("const a = s.slice(0, MAX); // sample-cap: examples")).toBe(0);
});

it("does not exempt without a reason, an unknown name, or across code", () => {
  expect(count("// generation-cap:\nconst a = s.slice(0, MAX);")).toBe(1);
  expect(count("// display-cap: short\nconst a = s.slice(0, MAX);")).toBe(1);
  expect(
    count(
      "// generation-cap: suggestions\nconst b = 1;\nconst a = s.slice(0, MAX);",
    ),
  ).toBe(1);
  expect(
    count(
      "const a = s.slice(0, MAX); // generation-cap: x\nconst b = t.slice(0, MAX);",
    ),
  ).toBe(1);
});

it("does not count slices inside comments", () => {
  expect(count("// s.slice(0, MAX)\n/* t.slice(0, MAX) */")).toBe(0);
});
