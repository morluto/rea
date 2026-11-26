import { expect, it, vi } from "vitest";
import { EnhancedTools } from "./EnhancedTools.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";

it("preserves field diagnostics for rejected enhanced tool inputs", async () => {
  const execute = vi.fn();
  const tools = new EnhancedTools({ execute });
  const result = await tools.execute("trace_native_values", { procedure: "" });
  if (result.ok) throw new Error("expected an input failure");
  expect(projectAnalysisError(result.error)).toMatchObject({
    code: "invalid_request",
    details: {
      operation: "trace_native_values",
      issues: [{ path: ["procedure"], reason: "out_of_range", minimum: 1 }],
    },
  });
  expect(execute).not.toHaveBeenCalled();
});
