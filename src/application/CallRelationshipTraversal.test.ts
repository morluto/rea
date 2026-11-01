import { describe, expect, it } from "vitest";

import { AnalysisCleanupLease } from "../artifacts/AnalysisCleanupLease.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
} from "../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { err, ok } from "../domain/result.js";
import {
  createAnalysisExecution,
  type AnalysisOperationPort,
} from "./AnalysisProvider.js";
import { EnhancedTools } from "./EnhancedTools.js";

const provider = { id: "fixture", name: "Fixture", version: "1" };
const tools = ["get_call_graph", "trace_call_path"] as const;
const input = (tool: (typeof tools)[number]) =>
  tool === "get_call_graph"
    ? { address: "0x1", direction: "forward" }
    : { start: "0x1", goal: "0x4", direction: "forward" };

const cleanupFailure = () =>
  new AnalysisCapabilityUnavailableError(
    provider.id,
    "procedure_callees",
    "child failed",
    { cleanup: { reason: "worker cleanup failed", resources: ["worker"] } },
  );

/** 0x1 calls 0x2 and 0x3; 0x2's read is supplied by the test. */
const port = (
  reads: string[],
  second: (signal?: AbortSignal) => AnalysisError,
): AnalysisOperationPort => ({
  execute: async (operation, parameters, options) => {
    const procedure = String(parameters.procedure);
    if (operation === "procedure_address")
      return ok(createAnalysisExecution(procedure, provider));
    reads.push(procedure);
    if (procedure === "0x2") return err(second(options?.signal));
    return ok(
      createAnalysisExecution(
        procedure === "0x1" ? ["0x2", "0x3"] : ["0x4"],
        provider,
        { relationshipCoverage: { status: "complete" } },
      ),
    );
  },
});

describe.each(tools)("%s cleanup ownership", (tool) => {
  it("returns the provider's cleanup failure so its owner resolves the outcome", async () => {
    const failure = cleanupFailure();
    let released = false;
    const lease = new AnalysisCleanupLease(async () => {
      if (!released) throw new Error("still owned");
    }, ["worker"]);
    lease.bindCleanupError(failure);
    failure.bindCleanupRetry({ operation: "close_binary" });
    const reads: string[] = [];

    const result = await new EnhancedTools(port(reads, () => failure)).execute(
      tool,
      input(tool),
    );

    if (result.ok) throw new Error("expected incomplete cleanup");
    expect(result.error).toBe(failure);
    expect("partialResult" in result).toBe(true);
    expect(reads).toEqual(["0x1", "0x2"]);
    expect(projectAnalysisError(result.error)).toMatchObject({
      code: "cleanup_incomplete",
      recovery: { kind: "retry_cleanup", operation: "close_binary" },
    });
    await expect(lease.release()).rejects.toThrow("still owned");
    expect(projectAnalysisError(result.error).code).toBe("cleanup_incomplete");
    released = true;
    await lease.release();
    expect(projectAnalysisError(result.error).code).toBe(
      "capability_unavailable",
    );
  });

  it("keeps a cleanup failure primary when cancellation arrives with it", async () => {
    const controller = new AbortController();
    const failure = cleanupFailure();
    const reads: string[] = [];

    const result = await new EnhancedTools(
      port(reads, () => {
        controller.abort({ requested: "stop" });
        return failure;
      }),
    ).execute(tool, input(tool), controller.signal);

    if (result.ok) throw new Error("expected incomplete cleanup");
    expect(result.error).toBe(failure);
    expect(projectAnalysisError(result.error).code).toBe("cleanup_incomplete");
    expect(reads).toEqual(["0x1", "0x2"]);
  });

  it("stops at a provider cancellation whose own cleanup is unconfirmed", async () => {
    const controller = new AbortController();
    const reads: string[] = [];
    let cancellation: AnalysisCancelledError | undefined;

    const result = await new EnhancedTools(
      port(reads, (signal) => {
        controller.abort();
        cancellation = new AnalysisCancelledError("procedure_callees", {
          cause: signal?.reason,
          cleanup: { reason: "cancel cleanup failed", resources: ["worker"] },
        });
        return cancellation;
      }),
    ).execute(tool, input(tool), controller.signal);

    if (result.ok) throw new Error("expected cancellation");
    expect(result.error).toBe(cancellation);
    expect(projectAnalysisError(result.error).code).toBe("cleanup_incomplete");
    expect(reads).toEqual(["0x1", "0x2"]);
  });
});
