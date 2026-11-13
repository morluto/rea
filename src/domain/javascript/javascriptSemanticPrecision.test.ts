import { expect, it } from "vitest";

import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";
import { onlyBinding } from "./javascriptSemanticAnalysis.fixture.js";
import { analyzeJavaScriptStaticSource } from "../../../tests/fixtures/javascriptStaticAnalysis.js";
import { semanticResourceLimitCoverage } from "./javascriptSemanticCoverage.js";
import { javaScriptSemanticPrecisionSchema } from "./javascriptSemanticPrecision.js";

const alternatives = (start: number, count: number): string =>
  count === 1
    ? JSON.stringify(`value_${String(start)}`)
    : `(flag ? ${alternatives(start, count / 2)} : ${alternatives(start + count / 2, count / 2)})`;

it("recovers the same finite candidate set with a source-owned precision budget", () => {
  const source = `export const selected = ${alternatives(0, 512)};`;
  const bounded = analyzeJavaScriptSemantics(source);
  expect(onlyBinding(bounded, "selected").value).toMatchObject({
    status: "unknown",
    resourceLimit: "primitive-candidates",
    reason: expect.stringContaining(
      "semantic_precision.primitive_candidates=256",
    ),
  });
  const recovered = analyzeJavaScriptSemantics(source, {
    primitive_candidates: 512,
  });
  const value = onlyBinding(recovered, "selected").value;
  expect(value.status).toBe("union");
  if (value.status !== "union")
    throw new Error("Expected finite primitive alternatives");
  expect(value.values).toHaveLength(512);
  expect(value.values).toContain("value_511");
  expect(recovered.coverage.resourceLimits).toBeUndefined();
  // A later source does not inherit a previous source's caller choice.
  expect(
    onlyBinding(analyzeJavaScriptSemantics(source), "selected").value,
  ).toMatchObject({
    status: "unknown",
    resourceLimit: "primitive-candidates",
  });
});

it("preserves exact effective precision when an increased budget still exhausts", () => {
  const source = `const selected = ${alternatives(0, 512)};`;
  const result = analyzeJavaScriptSemantics(source, {
    primitive_candidates: 300,
  });
  expect(onlyBinding(result, "selected").value).toMatchObject({
    reason: expect.stringContaining(
      "semantic_precision.primitive_candidates=300",
    ),
  });
  expect(
    semanticResourceLimitCoverage(
      result.coverage.resourceLimits ?? [],
      result.coverage.precision,
    ),
  ).toContainEqual({
    name: "javascript_semantic_primitive_candidates",
    value: 300,
    unit: "items",
  });
});

it("distinguishes wrapper work recovery from unchanged unsupported or cyclic syntax", () => {
  const source = `const e = require("electron"); e.ipcMain.on("first", event => event.sender.copy());`;
  const bounded = analyzeJavaScriptStaticSource(source, { wrapper_visits: 1 });
  expect(
    bounded.analysis_coverage?.examination.electron_call_paths_limited,
  ).toBe(true);
  expect(bounded.limitations).toEqual(
    expect.arrayContaining([
      expect.stringContaining("semantic_precision.wrapper_visits=1"),
    ]),
  );
  const recovered = analyzeJavaScriptStaticSource(source, {
    wrapper_visits: 10_000,
  });
  expect(
    recovered.analysis_coverage?.examination.electron_call_paths_limited,
  ).toBe(false);
  expect((recovered.electron.call_paths ?? []).length).toBeGreaterThan(0);
  const cycle = analyzeJavaScriptSemantics(
    "const a = b; const b = a; const selected = a;",
    { primitive_candidates: 512 },
  );
  expect(onlyBinding(cycle, "selected").value).toMatchObject({
    status: "unknown",
  });
  expect(onlyBinding(cycle, "selected").value).not.toHaveProperty(
    "resourceLimit",
  );
});

it.each([
  { primitive_candidates: 0 },
  { primitive_bytes: -1 },
  { wrapper_visits: 1.5 },
  { expression_depth: Number.POSITIVE_INFINITY },
])(
  "rejects invalid precision without silently replacing the caller choice: %o",
  (input) =>
    expect(javaScriptSemanticPrecisionSchema.safeParse(input).success).toBe(
      false,
    ),
);
