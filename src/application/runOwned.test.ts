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
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { err, ok, type Result } from "../domain/result.js";
import { finalizedResult, runOwned } from "./runOwned.js";

const value: AnalysisPartialObservation = {
  kind: "retained-evidence",
  evidence_id: "evidence-1",
};
const reason = { caller: "stop" };
const completedWork = async (): Promise<
  Result<AnalysisPartialObservation, AnalysisError>
> => ok(value);

/** A close that aborts the caller's signal, so cancellation lands during final cleanup. */
const closeThenAbort =
  (controller: AbortController, failure?: unknown) => async () => {
    controller.abort(reason);
    if (failure !== undefined) throw failure;
  };

const options = (controller: AbortController, close: () => Promise<void>) => ({
  providerId: "fixture",
  operation: "fixture_operation",
  signal: controller.signal,
  close,
});

describe("runOwned precedence", () => {
  it("completes when cleanup is released and no cancellation arrives", async () => {
    const controller = new AbortController();
    const finalized = await runOwned(
      completedWork,
      options(controller, async () => undefined),
    );
    expect(finalized).toEqual({ kind: "completed", value });
  });

  it("cancels a completed value when cancellation arrives during final cleanup before commit", async () => {
    const controller = new AbortController();
    const finalized = await runOwned(
      completedWork,
      options(controller, closeThenAbort(controller)),
    );
    expect(finalized.kind).toBe("cancelled");
    const result = finalizedResult(finalized);
    if (result.ok) throw new Error("expected cancellation");
    expect(result.error).toBeInstanceOf(AnalysisCancelledError);
    expect(result.error.cause).toBe(reason);
    expect(result.error.partialObservation).toBe(value);
  });

  it("keeps a committed value when cancellation arrives after the commit", async () => {
    const controller = new AbortController();
    const commits: unknown[] = [];
    const finalized = await runOwned(completedWork, {
      ...options(controller, closeThenAbort(controller)),
      commit: async (committed) => {
        commits.push(committed);
      },
    });
    expect(commits).toEqual([value]);
    expect(finalized).toEqual({
      kind: "completed",
      value,
      lateCancellation: reason,
    });
  });

  it("does not commit after cancellation and reports it before commit", async () => {
    const controller = new AbortController();
    controller.abort(reason);
    let committed = false;
    const finalized = await runOwned(completedWork, {
      ...options(controller, async () => undefined),
      commit: async () => {
        committed = true;
      },
    });
    expect(committed).toBe(false);
    expect(finalized.kind).toBe("cancelled");
  });

  it("keeps a recorded failure primary when cancellation arrives during final cleanup", async () => {
    const controller = new AbortController();
    const failure = new AnalysisProtocolError("fixture failure");
    const finalized = await runOwned(
      async () => err(failure),
      options(controller, closeThenAbort(controller)),
    );
    expect(finalized.kind).toBe("failed");
    const result = finalizedResult(finalized);
    if (result.ok) throw new Error("expected failure");
    expect(primaryAnalysisError(result.error)).toBe(failure);
    expect(failure.secondaryFailures).toEqual([
      expect.objectContaining({
        _tag: "AnalysisCancelledError",
        cause: reason,
      }),
    ]);
  });

  it("reports a completed value with unconfirmed cleanup as cleanup_incomplete keeping the value", async () => {
    const controller = new AbortController();
    const finalized = await runOwned(
      completedWork,
      options(controller, async () => {
        throw new Error("close failed");
      }),
    );
    expect(finalized.kind).toBe("completed-cleanup-retained");
    const result = finalizedResult(finalized);
    if (result.ok) throw new Error("expected cleanup failure");
    expect(result.error).toBeInstanceOf(ProviderCleanupError);
    expect(result.error.cleanupIncomplete).toBe(true);
    expect(result.error.partialObservation).toBe(value);
  });

  it("keeps the primary failure's identity when cleanup also fails", async () => {
    const controller = new AbortController();
    const failure = new AnalysisProtocolError("fixture failure");
    const cleanup = new ProviderCleanupError("fixture", ["fixture-run"], {
      reason: "still running",
    });
    const finalized = await runOwned(
      async () => err(failure),
      options(controller, async () => {
        throw cleanup;
      }),
    );
    expect(finalized).toMatchObject({
      kind: "failed",
      cleanup: { kind: "retained", failure: cleanup },
    });
    const result = finalizedResult(finalized);
    if (result.ok) throw new Error("expected failure");
    expect(primaryAnalysisError(result.error)).toBe(failure);
    expect(result.error.cleanupIncomplete).toBe(true);
  });

  it("types a thrown work failure as a provider adapter failure", async () => {
    const controller = new AbortController();
    const finalized = await runOwned(
      async () => {
        throw new Error("unexpected");
      },
      options(controller, async () => undefined),
    );
    const result = finalizedResult(finalized);
    if (result.ok) throw new Error("expected failure");
    expect(result.error._tag).toBe("ProviderAdapterError");
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

it("keeps a failure with a later cancellation classified as failed", async () => {
  const controller = new AbortController();
  const failure = new AnalysisProtocolError("fixture failure");
  const finalized = await runOwned(
    async () => err(failure),
    options(controller, closeThenAbort(controller)),
  );
  expect(finalized.kind).toBe("failed");
  expect(failure.secondaryFailures).toHaveLength(1);
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

it("retains completed work when publication fails", async () => {
  const finalized = await runOwned(completedWork, {
    ...options(new AbortController(), async () => undefined),
    commit: async () => {
      throw new Error("publication failed");
    },
  });
  const result = finalizedResult(finalized);
  if (result.ok) throw new Error("expected publication failure");
  expect(result.error.partialObservation).toBe(value);
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
