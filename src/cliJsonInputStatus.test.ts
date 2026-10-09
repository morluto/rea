import { describe, expect, it } from "vitest";

import { isCliOperationFailure } from "./cliLogging.js";
import {
  analysisCliErrorEnvelopeSchema,
  analysisErrorProjectionSchema,
} from "./contracts/errorSchemas.js";
import { AnalysisInputError } from "./domain/analysisErrorCore.js";
import { projectAnalysisError } from "./domain/analysisErrorProjection.js";

const projection = projectAnalysisError(new AnalysisInputError("test-input"));
const envelope = { error: "Application workflow failed", ...projection };

describe("CLI JSON input failure recognition", () => {
  it.each([
    {},
    { input_path: "input.json" },
    { input_reason: "invalid-json" },
    { input_path: "input.json", input_reason: "invalid-json" },
    { input_path: "input.json", input_reason: "input-too-large" },
    { input_path: "missing.json", input_reason: "read-failed" },
    { input_path: "", input_reason: "read-failed" },
  ])("recognizes a complete envelope with metadata %j", (metadata) => {
    const value = { ...envelope, ...metadata };
    expect(analysisCliErrorEnvelopeSchema.parse(value)).toEqual(value);
    expect(isCliOperationFailure(value)).toBe(true);
  });

  it.each([
    { input_path: null },
    { input_path: 1 },
    { input_path: ["input.json"] },
    { input_reason: null },
    { input_reason: 1 },
    { input_reason: "" },
    { input_reason: "unknown" },
    { input_reason: ["invalid-json"] },
    { unknown_field: "extra" },
    { input_path: "input.json", input_reason: "invalid-json", extra: true },
    { error: "" },
    { error: 1 },
    { retryable: "false" },
    { remediation: { action: "retry", extra: true } },
  ])("rejects malformed or unknown envelope fields %j", (changes) => {
    const value = { ...envelope, ...changes };
    expect(analysisCliErrorEnvelopeSchema.safeParse(value).success).toBe(false);
    expect(isCliOperationFailure(value)).toBe(false);
  });

  it.each(["code", "category", "message", "retryable", "remediation"])(
    "requires the complete canonical projection, including %s",
    (field) => {
      const value = Object.fromEntries(
        Object.entries({ ...envelope, input_reason: "invalid-json" }).filter(
          ([key]) => key !== field,
        ),
      );
      expect(analysisCliErrorEnvelopeSchema.safeParse(value).success).toBe(
        false,
      );
      expect(isCliOperationFailure(value)).toBe(false);
    },
  );

  it.each([
    { error: "ordinary data" },
    { code: "invalid_request", message: "ordinary data" },
    {
      error: "ordinary data",
      code: "invalid_request",
      input_path: "input.json",
    },
    { error: { code: "invalid_request" } },
    { result: envelope },
    { input_path: "input.json", input_reason: "invalid-json" },
    null,
    [],
  ])("keeps ordinary or incomplete error-like data successful: %j", (value) => {
    expect(isCliOperationFailure(value)).toBe(false);
  });

  it("keeps CLI metadata out of the strict canonical error schema", () => {
    expect(analysisErrorProjectionSchema.parse(projection)).toEqual(projection);
    for (const metadata of [
      { error: "Application workflow failed" },
      { input_path: "input.json" },
      { input_reason: "invalid-json" },
      { extra: true },
    ])
      expect(
        analysisErrorProjectionSchema.safeParse({ ...projection, ...metadata })
          .success,
      ).toBe(false);
  });
});
