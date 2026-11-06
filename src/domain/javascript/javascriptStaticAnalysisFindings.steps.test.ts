import { expect, it } from "vitest";

import {
  finalizeLocatedFindings,
  finalizeLocatedFindingsSteps,
  JavaScriptModuleRangeIndex,
} from "./javascriptStaticAnalysisFindings.js";

it("bounds each attribution step without dropping ordered reference facts", () => {
  const count = 3073;
  const values = Array.from({ length: count }, (_, offset) => ({
    offset,
    value: { specifier: `./dependency-${offset}.js`, module_key: null },
  }));
  let reads = 0;
  const observed = new Proxy(values, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/u.test(key)) reads += 1;
      return Reflect.get(target, key, receiver);
    },
  });
  const modules = new JavaScriptModuleRangeIndex(count);
  modules.add({
    start: 1024,
    end: 2047,
    key: "selected-module",
    runtime: "webpack",
    requireName: null,
  });
  const steps = finalizeLocatedFindingsSteps(observed, modules);
  let previousReads = 0;
  let yields = 0;
  let step = steps.next();
  for (;;) {
    expect(reads - previousReads).toBeLessThanOrEqual(1024);
    previousReads = reads;
    if (step.done === true) break;
    yields += 1;
    step = steps.next();
  }
  expect(yields).toBeGreaterThan(1);
  expect(reads).toBe(count);
  expect(step.value.map(({ specifier }) => specifier)).toEqual(
    values.map(({ value }) => value.specifier),
  );
  for (const index of [0, 1023, 1024, 2047, 2048, count - 1])
    expect(step.value[index]).toEqual({
      specifier: `./dependency-${index}.js`,
      module_key: index >= 1024 && index <= 2047 ? "selected-module" : null,
      ...(index >= 1024 && index <= 2047 ? { module_runtime: "webpack" } : {}),
    });
  expect(finalizeLocatedFindings(values, modules)).toEqual(step.value);
});
