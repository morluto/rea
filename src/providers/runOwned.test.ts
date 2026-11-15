import { describe, expect, it } from "vitest";

import {
  AnalysisCancelledError,
  AnalysisProtocolError,
} from "../domain/analysisErrorCore.js";
import {
  primaryAnalysisError,
  type AnalysisError,
  type AnalysisPartialObservation,
} from "../domain/analysisErrorBase.js";
import { AnalysisCleanupLease } from "../artifacts/AnalysisCleanupLease.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { err, ok, type Result } from "../domain/result.js";
import { finalizedResult, runOwned } from "./runOwned.js";

const value: AnalysisPartialObservation = {
  kind: "retained-evidence",
  evidence_id: "evidence-1",
};
const reason = { caller: "stop" };

// Scenarios shared by every adopter live in runOwned.lifecycle.test.ts; these
// cases cover producer-supplied errors, reader leases and recovered completions.

const options = (controller: AbortController, close: () => Promise<void>) => ({
  providerId: "fixture",
  operation: "fixture_operation",
  signal: controller.signal,
  close,
  partial: (completed: AnalysisPartialObservation) => completed,
});

const counted = async (): Promise<
  Result<{ readonly count: number }, AnalysisError>
> => ok({ count: 3 });
const project = (completed: { readonly count: number }) => ({
  kind: "retained-evidence" as const,
  evidence_id: `counted-${String(completed.count)}`,
});

describe("runOwned close-failure lease binding", () => {
  it("binds an artifact reader close failure to the leases it reports", async () => {
    let attempts = 0;
    const lease = new AnalysisCleanupLease(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("close failed");
    }, ["/reader/handle"]);
    await lease.release().catch(() => undefined);
    const finalized = await runOwned(counted, {
      ...options(new AbortController(), async () => {
        throw new ArtifactReaderFailure("io", "reader close failed", {
          cleanup: { reason: "handle retained", resources: ["/reader/handle"] },
          cleanupLeases: [lease],
        });
      }),
      partial: project,
    });
    expect(finalized.kind).toBe("completed-cleanup-retained");
    const result = finalizedResult(finalized);
    if (result.ok) throw new Error("expected cleanup failure");
    expect(result.error.cleanupIncomplete).toBe(true);
    await lease.release();
    expect(result.error.cleanupIncomplete).toBe(false);
  });

  it("binds a typed close failure to the leases while the failed work stays primary", async () => {
    const controller = new AbortController();
    const failure = new AnalysisProtocolError("fixture failure");
    const typed = new ProviderCleanupError("fixture", ["/producer/root"], {
      reason: "still owned",
    });
    const lease = new AnalysisCleanupLease(
      async () => undefined,
      ["/owned/root"],
    );
    const finalized = await runOwned(async () => err(failure), {
      ...options(controller, async () => {
        throw typed;
      }),
      partial: project,
      cleanupLeases: [lease],
    });
    const result = finalizedResult(finalized);
    if (result.ok) throw new Error("expected failure");
    expect(primaryAnalysisError(result.error)).toBe(failure);
    expect(result.error.cleanupResources).toEqual(["/owned/root"]);
    await lease.release();
    expect(typed.cleanupIncomplete).toBe(false);
    expect(result.error.cleanupIncomplete).toBe(false);
  });
});

it("classifies producer cancellation even when cleanup also fails", async () => {
  const controller = new AbortController();
  const cancellation = new AnalysisCancelledError("fixture_operation", {
    cause: reason,
  });
  const finalized = await runOwned(async () => err(cancellation), {
    ...options(controller, async () => {
      throw new Error("still running");
    }),
  });
  expect(finalized.kind).toBe("cancelled");
  if (finalized.kind !== "cancelled") throw new Error("expected cancellation");
  expect(finalized.cleanup.kind).toBe("retained");
  expect(primaryAnalysisError(finalized.error)).toBe(cancellation);
});

it("classifies a producer composite whose primary is a cancellation as cancelled", async () => {
  const controller = new AbortController();
  const cancellation = new AnalysisCancelledError("fixture_operation", {
    cause: reason,
  });
  const cleanup = new ProviderCleanupError("fixture", ["owned-process"], {
    reason: "pending",
  });
  const composite = analysisErrorWithCleanupFailure(
    cancellation,
    cleanup,
    "fixture_operation",
  ).bindCleanupDependencies([cancellation, cleanup]);
  const finalized = await runOwned(
    async () => err(composite),
    options(controller, async () => {
      cleanup.resolveCleanup();
    }),
  );
  expect(finalized).toMatchObject({
    kind: "cancelled",
    error: composite,
    cleanup: { kind: "released" },
  });
});

it("keeps producer cleanup retained when close does not resolve it", async () => {
  const controller = new AbortController();
  const failure = new ProviderCleanupError("fixture", ["owned-process"], {
    reason: "pending",
  });
  const finalized = await runOwned(
    async () => err(failure),
    options(controller, async () => undefined),
  );
  expect(finalized).toMatchObject({
    kind: "failed",
    error: failure,
    cleanup: { kind: "retained", failure },
  });
});

it("publishes recovered completion after cleanup resolves", async () => {
  const controller = new AbortController();
  const failure = new ProviderCleanupError("fixture", ["owned-process"], {
    reason: "pending",
  });
  const published: AnalysisPartialObservation[] = [];
  const finalized = await runOwned(async () => err(failure), {
    ...options(controller, async () => {
      failure.resolveCleanup();
    }),
    recoverCompleted: (_error, observed) =>
      observed.cleanupResolvedByClose ? { value } : undefined,
    commit: async (completed) => {
      published.push(completed);
    },
  });
  expect(published).toEqual([value]);
  expect(finalized).toEqual({ kind: "completed", value });
});

it("keeps a recovered value when cancellation arrives during its publication", async () => {
  const controller = new AbortController();
  const failure = new ProviderCleanupError("fixture", ["owned-process"], {
    reason: "pending",
  });
  const finalized = await runOwned(async () => err(failure), {
    ...options(controller, async () => {
      failure.resolveCleanup();
    }),
    recoverCompleted: () => ({ value }),
    commit: async () => {
      controller.abort(reason);
    },
  });
  expect(finalized).toEqual({
    kind: "completed",
    value,
    lateCancellation: reason,
  });
});

it("keeps a cancellation that arrives while a recovered publication fails", async () => {
  const controller = new AbortController();
  const failure = new ProviderCleanupError("fixture", ["owned-process"], {
    reason: "pending",
  });
  const publication = new AnalysisProtocolError("publication failed");
  const finalized = await runOwned(async () => err(failure), {
    ...options(controller, async () => {
      failure.resolveCleanup();
    }),
    recoverCompleted: () => ({ value }),
    commit: async () => {
      controller.abort(reason);
      throw publication;
    },
  });
  expect(finalized.kind).toBe("failed");
  const result = finalizedResult(finalized);
  if (result.ok) throw new Error("expected publication failure");
  expect(primaryAnalysisError(result.error)).toBe(publication);
  expect(publication.secondaryFailures).toEqual([
    expect.objectContaining({ _tag: "AnalysisCancelledError", cause: reason }),
  ]);
});

it("retains a recovered value when its publication fails", async () => {
  const failure = new ProviderCleanupError("fixture", ["owned-process"], {
    reason: "pending",
  });
  const finalized = await runOwned(async () => err(failure), {
    ...options(new AbortController(), async () => {
      failure.resolveCleanup();
    }),
    recoverCompleted: () => ({ value }),
    commit: async () => {
      throw new Error("publication failed");
    },
  });
  const result = finalizedResult(finalized);
  if (result.ok) throw new Error("expected publication failure");
  expect(result.error.partialObservation).toBe(value);
});
