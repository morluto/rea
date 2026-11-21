import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { z } from "zod";

const heap = vi.hoisted(() => ({
  usedBytes: 1024 * 1024,
  remainingBytes: 200 * 1024 * 1024,
  readings: [] as number[],
}));
vi.mock("node:v8", async (load) => {
  const actual = await load<typeof import("node:v8")>();
  return {
    ...actual,
    getHeapStatistics: () => {
      const current = actual.getHeapStatistics();
      return {
        ...current,
        used_heap_size: heap.usedBytes,
        heap_size_limit:
          heap.usedBytes + (heap.readings.shift() ?? heap.remainingBytes),
      };
    },
  };
});

// Bound the parent-side maximum checkpoint reservation for this controlled
// test. The child still emits actual, digest-verified complete checkpoints.
vi.mock(
  "../../../src/domain/javascript/javascriptAnalysisResourceControls.js",
  async (load) => {
    const actual =
      await load<
        typeof import("../../../src/domain/javascript/javascriptAnalysisResourceControls.js")
      >();
    return { ...actual, JAVASCRIPT_STATIC_FACT_BYTES: 256 * 1024 };
  },
);

import { JavaScriptAnalysisWorker } from "../../../src/javascript/analysis/JavaScriptAnalysisWorker.js";
import { AnalysisResourceConstraintError } from "../../../src/domain/analysisErrorCore.js";
import type { JavaScriptArtifactFile } from "../../../src/domain/javascript/javascriptArtifactFiles.js";
const sourceText = (text: string) => ({
  sha256: createHash("sha256").update(text).digest("hex"),
  bytes: Buffer.byteLength(text),
  text: { included: true as const, value: text },
});
const file = (path: string, count: number): JavaScriptArtifactFile => ({
  path,
  container_sha256: "a".repeat(64),
  inventory_artifact_id: path,
  kind: "javascript",
  unpacked: false,
  ...sourceText(
    Array.from(
      { length: count },
      (_, i) => `localStorage.setItem('k${i}', 'v');`,
    ).join("\n"),
  ),
});
const expectCapacityRemains = (
  result: Awaited<ReturnType<JavaScriptAnalysisWorker["analyze"]>>,
): void => {
  if (
    !result.ok &&
    result.error.error instanceof AnalysisResourceConstraintError
  )
    expect(
      result.error.error.reportedLimits?.parent_result_budget_exhausted,
    ).not.toBe(true);
};
const functions = (count: number): JavaScriptArtifactFile => {
  const text = Array.from(
    { length: count },
    (_, i) => `export function f${i}(a) { const b = a + ${i}; return b; }`,
  ).join("\n");
  return { ...file("functions.js", 0), ...sourceText(text) };
};
// The mocked heap leaves a 4 MiB result budget and 6 MiB of static capacity.
// A 50-line source reserves about 1.1 MiB of relationships; each later 500-line
// source is charged about 0.5 MiB, so reclamation starts at the eleventh.
const SOURCES_UNTIL_RECLAMATION = 12;
it("uses one live heap observation for revocation and static admission", async () => {
  const run = async (changeHeapAt?: number) => {
    const worker = new JavaScriptAnalysisWorker(
      { heapMb: 512, timeoutMs: 30_000 },
      undefined,
      SOURCES_UNTIL_RECLAMATION,
    );
    const results = [];
    try {
      for (let i = 0; i < SOURCES_UNTIL_RECLAMATION; i++) {
        const index = i;
        results.push(
          await worker.analyze(
            file(`${i}.js`, i === 0 ? 50 : 500),
            { nodes: 1, unknowns: 1 },
            undefined,
            async (phase) => {
              if (phase === "static" && index === changeHeapAt)
                heap.readings = [200, 200, 192, 192].map(
                  (mib) => mib * 1024 * 1024,
                );
            },
          ),
        );
        heap.readings = [];
      }
      return results;
    } finally {
      heap.readings = [];
      await worker.close();
    }
  };
  const control = await run();
  const at = control.findIndex((result) =>
    (result.ok ? result.value : result.error).revokedStaticProjections?.some(
      ({ sourceIndex }) => sourceIndex === 0,
    ),
  );
  expect(at).toBeGreaterThan(0);
  const changed = await run(at);
  const observed = changed[at];
  if (observed === undefined) throw new Error("Missing changed observation");
  const detail = observed.ok ? observed.value : observed.error;
  expect(
    detail.revokedStaticProjections?.map(({ sourceIndex }) => sourceIndex),
  ).toContain(0);
  if (
    !observed.ok &&
    observed.error.error instanceof AnalysisResourceConstraintError
  )
    expect(
      observed.error.error.reportedLimits?.parent_result_budget_exhausted,
    ).not.toBe(true);
});

it("reclaims prior unmaterialized projections only when a complete static checkpoint would otherwise exhaust the static capacity", async () => {
  const worker = new JavaScriptAnalysisWorker(
    { heapMb: 512, timeoutMs: 30_000 },
    undefined,
    SOURCES_UNTIL_RECLAMATION,
  );
  const results = [];
  try {
    for (let i = 0; i < SOURCES_UNTIL_RECLAMATION; i++)
      results.push(
        await worker.analyze(file(`${i}.js`, i === 0 ? 50 : 500), {
          nodes: 1,
          unknowns: 1,
        }),
      );
    const details = results.map((r) => (r.ok ? r.value : r.error));
    expect(
      details.every((d) => d.javascript?.parse_status === "complete"),
    ).toBe(true);
    expect(
      details.some(
        (d) =>
          "error" in d &&
          d.error instanceof AnalysisResourceConstraintError &&
          d.error.reportedLimits?.parent_result_budget_exhausted === true,
      ),
    ).toBe(false);
    expect(
      details
        .flatMap((d) => d.revokedStaticProjections ?? [])
        .map((d) => d.sourceIndex),
    ).toContain(0);
  } finally {
    await worker.close();
  }
});

it("keeps earlier projections when reclaiming them cannot admit the checkpoint", async () => {
  const worker = new JavaScriptAnalysisWorker(
    { heapMb: 512, timeoutMs: 30_000 },
    undefined,
    6,
  );
  try {
    const results = [];
    for (let i = 0; i < 6; i++)
      results.push(
        await worker.analyze(file(`${i}.js`, i === 0 ? 10 : 1400), {
          nodes: 1,
          unknowns: 1,
        }),
      );
    const details = results.map((result) =>
      result.ok ? result.value : result.error,
    );
    expect(results[0]?.ok).toBe(true);
    expect(details[0]?.applicationProjectionFailure).toBeUndefined();
    expect(
      details.flatMap((detail) => detail.revokedStaticProjections ?? []),
    ).toEqual([]);
    expect(results.at(-1)?.ok).toBe(false);
    const last = results.at(-1);
    if (last === undefined || last.ok)
      throw new Error("Expected capacity refusal");
    expect(last.error.error).toMatchObject({
      reportedLimits: {
        parent_result_budget_bytes: 4 * 1024 * 1024,
        parent_static_capacity_bytes: 6 * 1024 * 1024,
        parent_result_budget_exhausted: true,
      },
    });
    const {
      static_retention_estimate_bytes: required,
      parent_available_static_capacity_bytes: available,
    } = z
      .object({
        static_retention_estimate_bytes: z.number(),
        parent_available_static_capacity_bytes: z.number(),
      })
      .parse(
        last.error.error instanceof AnalysisResourceConstraintError
          ? last.error.error.reportedLimits
          : null,
      );
    expect(required).toBeGreaterThan(available);
  } finally {
    await worker.close();
  }
});

it("retains static facts past the result budget, keeping earlier relationships while the static capacity lasts", async () => {
  const sources = 9;
  const worker = new JavaScriptAnalysisWorker(
    { heapMb: 512, timeoutMs: 30_000 },
    undefined,
    sources,
  );
  try {
    const details = [];
    for (let i = 0; i < sources; i++) {
      const result = await worker.analyze(file(`${i}.js`, i === 0 ? 50 : 500), {
        nodes: 1,
        unknowns: 1,
      });
      expectCapacityRemains(result);
      details.push(result.ok ? result.value : result.error);
    }
    expect(details.map((detail) => detail.javascript?.storage.length)).toEqual(
      details.map((_, i) => (i === 0 ? 50 : 500)),
    );
    expect(
      details.flatMap((detail) => detail.revokedStaticProjections ?? []),
    ).toEqual([]);
    // Relationships that do not fit the budget are refused, explicitly.
    expect(details[0]?.applicationProjectionFailure).toBeUndefined();
    for (const detail of details.slice(1))
      expect(detail.applicationProjectionFailure).toMatchObject({
        reason: expect.stringContaining("exceed the parent's result budget"),
      });
  } finally {
    await worker.close();
  }
});

it("retains static facts for later sources after semantic results use the result budget", async () => {
  const sources = 4;
  const worker = new JavaScriptAnalysisWorker(
    { heapMb: 512, timeoutMs: 30_000 },
    undefined,
    sources,
  );
  try {
    // Semantic results are already adopted, so nothing can be reclaimed from them.
    const first = await worker.analyze(functions(10), {
      nodes: 20_000,
      unknowns: 20_000,
    });
    if (!first.ok) throw first.error.error;
    expect(first.value.module?.callables).toHaveLength(10);
    expect(first.value.projection).not.toBeNull();
    const later = [];
    for (let i = 1; i < sources; i++) {
      const result = await worker.analyze(file(`${i}.js`, 1000), {
        nodes: 20_000,
        unknowns: 20_000,
      });
      expectCapacityRemains(result);
      later.push(result.ok ? result.value : result.error);
    }
    expect(later.map((detail) => detail.javascript?.storage.length)).toEqual(
      later.map(() => 1000),
    );
    expect(
      later.flatMap((detail) => detail.revokedStaticProjections ?? []),
    ).toEqual([]);
  } finally {
    await worker.close();
  }
});

it("stays within the result budget when the live heap has no room for another copy", async () => {
  // Each later checkpoint is charged about 1 MiB, against 8 MiB of live room.
  heap.usedBytes = 7.5 * 1024 * 1024;
  const sources = 9;
  const worker = new JavaScriptAnalysisWorker(
    { heapMb: 512, timeoutMs: 30_000 },
    undefined,
    sources,
  );
  try {
    const results = [];
    for (let i = 0; i < sources; i++)
      results.push(
        await worker.analyze(file(`${i}.js`, i === 0 ? 10 : 1000), {
          nodes: 1,
          unknowns: 1,
        }),
      );
    const stopped = results
      .flatMap((result) => (result.ok ? [] : [result.error.error]))
      .find(
        (error) =>
          error instanceof AnalysisResourceConstraintError &&
          error.reportedLimits?.parent_result_budget_exhausted === true,
      );
    expect(stopped).toMatchObject({
      reportedLimits: {
        parent_result_budget_bytes: 4 * 1024 * 1024,
        parent_static_capacity_bytes: 4 * 1024 * 1024,
        parent_used_heap_bytes: 7.5 * 1024 * 1024,
        parent_result_budget_exhausted: true,
      },
    });
  } finally {
    heap.usedBytes = 1024 * 1024;
    await worker.close();
  }
});

it("resets projection reservations and source indices when an idle worker is reused", async () => {
  const worker = new JavaScriptAnalysisWorker(
    { heapMb: 512, timeoutMs: 30_000 },
    undefined,
    1,
  );
  try {
    const first = await worker.analyze(file("previous.js", 10), {
      nodes: 1,
      unknowns: 1,
    });
    expect(first.ok).toBe(true);
    expect(worker.prepareForAnotherAnalysis(SOURCES_UNTIL_RECLAMATION)).toBe(
      true,
    );
    const results = [];
    for (let i = 0; i < SOURCES_UNTIL_RECLAMATION; i++)
      results.push(
        await worker.analyze(file(`new-${i}.js`, i === 0 ? 50 : 500), {
          nodes: 1,
          unknowns: 1,
        }),
      );
    const revocations = results.flatMap(
      (r) => (r.ok ? r.value : r.error).revokedStaticProjections ?? [],
    );
    expect(revocations.map((entry) => entry.sourceIndex)).toEqual([0]);
    expect(revocations[0]?.error.message).toContain("new-0.js");
    expect(revocations[0]?.error.message).not.toContain("previous.js");
  } finally {
    await worker.close();
  }
});

it("does not discard earlier projections when live heap, not reservations, blocks admission", async () => {
  const worker = new JavaScriptAnalysisWorker(
    { heapMb: 512, timeoutMs: 30_000 },
    undefined,
    2,
  );
  try {
    const first = await worker.analyze(file("first.js", 10), {
      nodes: 1,
      unknowns: 1,
    });
    expect(first.ok).toBe(true);
    const second = await worker.analyze(
      file("second.js", 1000),
      { nodes: 1, unknowns: 1 },
      undefined,
      async (phase) => {
        if (phase === "static") heap.remainingBytes = 192 * 1024 * 1024;
      },
    );
    if (second.ok) throw new Error("Expected live heap refusal");
    expect(second.error.error).toMatchObject({
      reportedLimits: { parent_result_budget_exhausted: true },
    });
    expect(second.error.revokedStaticProjections).toBeUndefined();
  } finally {
    heap.remainingBytes = 200 * 1024 * 1024;
    await worker.close();
  }
});
