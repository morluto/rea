import { describe, expect, it } from "vitest";
import {
  AnalysisOutputError,
  AnalysisTimeoutError,
} from "../domain/analysisErrorCore.js";
import { classifyProviderFailure } from "./classifyProviderFailure.js";

describe("classifyProviderFailure attribution", () => {
  const unclassified = (cause: unknown) =>
    new AnalysisOutputError("list", String(cause), { cause });

  it("attributes a typed failure through the dialect and passes it through without one", () => {
    const typed = new AnalysisTimeoutError("startup", 5);
    const attributed = new AnalysisTimeoutError("list", 5, { cause: typed });
    expect(
      classifyProviderFailure(typed, {
        providerId: "fixture",
        operation: "list",
        attribute: (failure) => (failure === typed ? attributed : failure),
        unclassified,
      }),
    ).toBe(attributed);
    expect(
      classifyProviderFailure(typed, {
        providerId: "fixture",
        operation: "list",
        unclassified,
      }),
    ).toBe(typed);
  });

  it("does not attribute the provider's own unclassified report", () => {
    const failure = classifyProviderFailure("raw", {
      providerId: "fixture",
      operation: "list",
      attribute: () => {
        throw new Error("only typed causes are attributed");
      },
      unclassified,
    });
    expect(failure).toBeInstanceOf(AnalysisOutputError);
  });
});
