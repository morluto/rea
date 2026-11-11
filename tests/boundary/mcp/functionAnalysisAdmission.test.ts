import { expect, it, vi } from "vitest";
import { withAdmittedAnalysis } from "../../../src/server/analysisAdmission.js";

it("retains the caller reason and never enters fixed MCP work after cancellation", async () => {
  const reason = { request: "cancelled before provider admission" };
  const signal = AbortSignal.abort(reason);
  const operation = vi.fn(async () => undefined);
  const admitted = await withAdmittedAnalysis({
    kind: "fixed",
    analysis: {
      execute: async () => {
        throw new Error("Cancelled work must not reach the provider");
      },
    },
  })("analyze_function", signal, operation);
  if (admitted.ok) throw new Error("Expected pre-admission cancellation");
  expect(admitted.error).toMatchObject({ _tag: "AnalysisCancelledError" });
  expect(admitted.error.cause).toBe(reason);
  expect(operation).not.toHaveBeenCalled();
});
