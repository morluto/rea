import { expect, it } from "vitest";
import { ProviderCleanupError } from "./providerCleanupError.js";
import { projectAnalysisError } from "./analysisErrorProjection.js";
it("preserves the binary cleanup default and an explicitly owned nonbinary operation", () => {
  expect(new ProviderCleanupError("ghidra", ["database"], {}).operation).toBe(
    "close_binary",
  );
  const error = new ProviderCleanupError(
    "source-map-decoder",
    ["runtime"],
    { reason: "cleanup failed" },
    { operation: "trace_web_source_location" },
  );
  expect(error.operation).toBe("trace_web_source_location");
  expect(projectAnalysisError(error)).toMatchObject({
    code: "cleanup_incomplete",
    details: { operation: "trace_web_source_location" },
  });
});
