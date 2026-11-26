import { expect, it } from "vitest";

import { createAnalysisExecution } from "./AnalysisProvider.js";

const PROVIDER = { id: "fixture", name: "Fixture", version: "1" };

it("records no raw result unless the provider supplies a distinct one", () => {
  const result = { entries: [{ value: "normalized" }] };

  expect(createAnalysisExecution(result, PROVIDER)).toMatchObject({
    result,
    rawResult: null,
  });
  expect(
    createAnalysisExecution(result, PROVIDER, {
      rawResult: { stdout: "raw" },
    }).rawResult,
  ).toEqual({ stdout: "raw" });
  expect(
    createAnalysisExecution(result, PROVIDER, { rawResult: null }).rawResult,
  ).toBeNull();
});

it("retains typed pseudocode language, representation, and source facts", () => {
  const execution = createAnalysisExecution(
    "int f(void) { return 0; }",
    PROVIDER,
    {
      pseudocodeLanguage: "c-language",
      pseudocodeRepresentation: "provider-pseudocode",
      pseudocodeSource: "single-function",
    },
  );
  expect(execution).toMatchObject({
    pseudocodeLanguage: "c-language",
    pseudocodeRepresentation: "provider-pseudocode",
    pseudocodeSource: "single-function",
  });
  expect(execution.rawResult).toBeNull();
});
