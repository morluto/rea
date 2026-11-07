import { expect, it } from "vitest";
import { AnalysisCloseCompletedError } from "../domain/analysisCloseCompletedError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { err, ok } from "../domain/result.js";
import { AnalysisOutputError } from "../domain/analysisErrorCore.js";
import {
  directAnalysisCleanupFailure,
  managedAnalysisCleanupFailure,
} from "./DirectAnalysisCleanup.js";

const completed = () =>
  new AnalysisCloseCompletedError("ghidra", "diagnostic_export");

it("keeps a one-shot observation without inventing pending cleanup after a completed close", () => {
  const projected = directAnalysisCleanupFailure(
    ok({ value: 1 }),
    completed(),
  ) as { code: string; details: Record<string, unknown> };
  expect(projected.code).toBe("execution_failure");
  expect(projected.details).toMatchObject({ operation: "diagnostic_export" });
  expect(projected.details).not.toHaveProperty("cleanup");
  expect(projected.details.partial_observation).toEqual({ value: 1 });
});

it("keeps the primary failure and notes a completed close failure beside it", () => {
  const primary = new AnalysisOutputError("health", "startup failed");
  const projected = directAnalysisCleanupFailure(err(primary), completed()) as {
    code: string;
    details: Record<string, unknown>;
  };
  expect(projected.code).not.toBe("cleanup_incomplete");
  expect(projected.details).not.toHaveProperty("cleanup");
  expect(projected.details).toHaveProperty("client_close_failure");
});

it("does not mark a managed result cleanup-incomplete after a completed close", () => {
  const primary = new AnalysisOutputError("health", "startup failed");
  const failed = managedAnalysisCleanupFailure(err(primary), completed());
  if (failed.ok) throw new Error("Expected failure");
  expect(failed.error).toBe(primary);
  expect(failed.error.cleanupIncomplete).toBe(false);
  const retained = new ProviderCleanupError("ghidra", ["file"], {
    reason: "x",
  });
  const open = managedAnalysisCleanupFailure(err(primary), retained);
  if (open.ok) throw new Error("Expected failure");
  expect(open.error.cleanupIncomplete).toBe(true);
});
