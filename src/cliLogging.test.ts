import { describe, expect, it } from "vitest";

import { ConfigurationError, projectAnalysisError } from "./domain/errors.js";

import { isCliOperationFailure } from "./cliLogging.js";

describe("CLI operation status classification", () => {
  it.each([
    [
      "projected error",
      projectAnalysisError(new ConfigurationError("invalid setting")),
    ],
    ["typed error", { error: "Analysis failed", category: "timeout" }],
    ["unhealthy diagnostic", { healthy: false, checks: [] }],
    ["failed status", { status: "failed" }],
    ["confirmation requirement", { status: "needs_confirmation" }],
    ["human remediation", { status: "needs_human" }],
    ["unapplied plan", { status: "planned" }],
  ])("classifies %s as failure", (_label, value) => {
    expect(isCliOperationFailure(value)).toBe(true);
  });

  it.each([
    [
      "ordinary data with code",
      { code: "configuration_invalid", message: "source data" },
    ],
    [
      "evidence about an error",
      {
        result: projectAnalysisError(new ConfigurationError("source setting")),
      },
    ],
    ["ready setup", { status: "ready" }],
    ["complete uninstall", { status: "complete" }],
    ["current version", { status: "current" }],
    ["completed upgrade", { status: "upgraded" }],
    ["healthy diagnostics", { healthy: true, checks: [] }],
    ["bounded evidence", { evidence: [{ truncated: true }] }],
  ])("keeps %s successful", (_label, value) => {
    expect(isCliOperationFailure(value)).toBe(false);
  });
});
