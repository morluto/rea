import { expect, it, vi } from "vitest";

const heapLimit = vi.hoisted(() => ({ override: null as number | null }));

vi.mock("node:v8", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:v8")>();
  return {
    ...actual,
    getHeapStatistics: () => {
      const statistics = actual.getHeapStatistics();
      return heapLimit.override === null
        ? statistics
        : { ...statistics, heap_size_limit: heapLimit.override };
    },
  };
});

import { AnalysisResourceConstraintError } from "../domain/analysisErrorCore.js";
import { webBundleWorkerScript as makeScript } from "../../tests/fixtures/webBundleAnalysis.js";
import type { IncludedScript } from "../domain/webBundleAnalyzerState.js";
import { WebBundleAnalysisWorker } from "./WebBundleAnalysisWorker.js";

it("refuses before spawning or reading source when no host result capacity remains", async () => {
  const text = "fetch('/never-serialized');";
  const base = makeScript(text);
  let sourceReads = 0;
  let launches = 0;
  const artifact = { ...base.source.artifact };
  Object.defineProperty(artifact, "text", {
    configurable: true,
    get: () => {
      sourceReads += 1;
      return text;
    },
  });
  const script: IncludedScript = {
    ...base,
    source: { included: true, artifact },
  };
  const worker = new WebBundleAnalysisWorker(1024, async () => {
    launches += 1;
    throw new Error(
      "The worker must not launch when the host has no result capacity",
    );
  });
  heapLimit.override = 0;

  try {
    const result = await worker.analyze(script, 10_000);
    if (result.ok) throw new Error("Expected result-capacity refusal");
    const refusal = result.error.error;
    expect(refusal).toBeInstanceOf(AnalysisResourceConstraintError);
    expect(refusal).toMatchObject({
      resource: "memory",
      remediationAction: expect.stringContaining("NODE_OPTIONS"),
      reportedLimits: {
        result_bytes: 8_388_608,
        result_budget_remaining_bytes: 8_388_608,
        host_result_capacity_bytes: 0,
      },
    });
    expect(result.error.continuation).toBe("result_capacity_exhausted");
    expect(result.error.completed).toBeNull();
    expect(sourceReads).toBe(0);
    expect(launches).toBe(0);
  } finally {
    heapLimit.override = null;
    await worker.close();
  }
});
