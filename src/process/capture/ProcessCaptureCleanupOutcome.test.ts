import { expect, it } from "vitest";
import { emptyProcessCapture } from "../../domain/process/processCapture.fixture.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import { analysisErrorProjectionSchema } from "../../contracts/errorSchemas.js";
import { ProcessCaptureError } from "./ProcessCaptureError.js";
import {
  PROCESS_CAPTURE_CLEANUP_INTERVENTION_UNKNOWN,
  releaseProcessResources,
  resolveProcessResult,
  createProcessCaptureObservationBuffer,
  type ProcessCaptureCleanupOutcome,
  type PendingProcessCapture,
} from "./ProcessCaptureLifecycle.js";

const pendingCapture = (): PendingProcessCapture => {
  const { cleanup, ...capture } = emptyProcessCapture();
  void cleanup;
  return capture;
};

// An injected ownership result exercises finalization without claiming host
// process/TTY behavior or sending a signal to a real process.
const observedCleanup = (signaled: boolean, rendererFailure?: () => boolean) =>
  releaseProcessResources({
    timers: new Set(),
    terminal: { pid: 321 },
    renderer:
      rendererFailure === undefined
        ? undefined
        : {
            dispose: async () => {
              if (rendererFailure()) throw new Error("renderer cleanup denied");
            },
          },
    runId: "cleanup-facts-fixture",
    temporaryRoot: "/fixture/root",
    host: {
      platform: "linux",
      cleanupProcessGroup: async () => ({ cleaned: true, signaled }),
      removeTemporaryRoot: async () => undefined,
    },
  });

const intervention = PROCESS_CAPTURE_CLEANUP_INTERVENTION_UNKNOWN;

it.each(["capture", "observations"] as const)(
  "retains a producer's known signal after failed cleanup in %s",
  async (shape) => {
    let recovered = false;
    const cleanup = await releaseProcessResources({
      timers: new Set(),
      terminal: { pid: 321 },
      renderer: undefined,
      runId: "failed-cleanup-signal-fixture",
      temporaryRoot: "/fixture/root",
      host: {
        platform: "linux",
        cleanupProcessGroup: async () =>
          recovered
            ? { cleaned: true, signaled: false }
            : {
                cleaned: false,
                signaled: true,
                reason: "post-signal verification failed",
              },
        removeTemporaryRoot: async () => undefined,
      },
    });
    const observations = createProcessCaptureObservationBuffer({
      frames: [],
      interactions: [],
      samples: [],
      eventJournal: [],
      before: undefined,
    });
    const failure = new Error("original terminal failure");
    try {
      resolveProcessResult(
        shape === "capture" ? pendingCapture() : undefined,
        failure,
        cleanup,
        shape === "observations" ? observations : undefined,
      );
      throw new Error("Expected incomplete cleanup");
    } catch (cause: unknown) {
      if (!(cause instanceof ProcessCaptureError)) throw cause;
      expect(cause.cause).toBe(failure);
      expect(cause.cleanupIncomplete).toBe(true);
      expect(cause.cleanupReport?.owned_process_group).toEqual({
        state: "unverified",
        reason: "post-signal verification failed",
      });
      const partial = cause.partialObservation;
      if (partial === undefined)
        throw new Error("Expected partial observations");
      const facts =
        "capture" in partial ? partial.capture : partial.observations;
      expect(facts.residual_unknowns ?? []).toContainEqual(intervention);
      expect(
        analysisErrorProjectionSchema.parse(projectAnalysisError(cause)),
      ).toMatchObject({
        details: {
          partial_observation: {
            [shape]: {
              residual_unknowns: expect.arrayContaining([intervention]),
            },
          },
        },
      });
      if ("capture" in partial)
        expect(partial.capture.settlement.cleanup_outcome).toBe("failed");
      const historical = JSON.stringify(partial);
      recovered = true;
      await cleanup.cleanupLease?.release();
      expect(cause.cleanupIncomplete).toBe(false);
      expect(JSON.stringify(cause.partialObservation)).toBe(historical);
    } finally {
      recovered = true;
      await cleanup.cleanupLease?.release();
    }
  },
);

it("reports cleanup intervention even when settlement had already quiesced", async () => {
  const cleanup = await observedCleanup(true);
  const capture = resolveProcessResult(pendingCapture(), undefined, cleanup);
  expect(capture.settlement).toMatchObject({
    state: "quiesced",
    cleanup_outcome: "cleaned",
  });
  expect(capture.residual_unknowns).toContainEqual(intervention);
  expect(capture.cleanup.owned_process_group).toBe("verified");
});

it("keeps non-signaling cleanup distinct from intervention", async () => {
  const cleanup = await observedCleanup(false);
  const capture = resolveProcessResult(pendingCapture(), undefined, cleanup);
  expect(capture.settlement.cleanup_outcome).toBe("not_required");
  expect(capture.residual_unknowns).not.toContainEqual(intervention);
});

it("updates a validated capture once and does not duplicate intervention facts", async () => {
  const cleanup = await observedCleanup(true);
  const capture = resolveProcessResult(
    emptyProcessCapture(),
    undefined,
    cleanup,
  );
  expect(capture.settlement.cleanup_outcome).toBe("cleaned");
  const repeated = resolveProcessResult(capture, undefined, cleanup);
  expect(repeated.residual_unknowns).toEqual(capture.residual_unknowns);
  expect(
    repeated.residual_unknowns.filter(
      (unknown) =>
        unknown.scope === intervention.scope &&
        unknown.reason === intervention.reason,
    ),
  ).toHaveLength(1);
});

it("retains intervention in partial facts without replacing the execution failure", async () => {
  const cleanup = await observedCleanup(true);
  const failure = new Error("final snapshot failed");
  try {
    resolveProcessResult(pendingCapture(), failure, cleanup);
    throw new Error("Expected the execution failure");
  } catch (cause: unknown) {
    if (!(cause instanceof ProcessCaptureError)) throw cause;
    expect(cause.cause).toBe(failure);
    expect(cause.cleanupIncomplete).toBe(false);
    expect(cause.partialObservation).toMatchObject({
      capture: {
        settlement: { cleanup_outcome: "cleaned" },
        residual_unknowns: expect.arrayContaining([intervention]),
      },
    });
  }
});

it("keeps failed cleanup authoritative while retaining its known intervention", async () => {
  let rendererFails = true;
  const cleanup = await observedCleanup(true, () => rendererFails);
  try {
    resolveProcessResult(pendingCapture(), undefined, cleanup);
    throw new Error("Expected incomplete cleanup");
  } catch (cause: unknown) {
    if (!(cause instanceof ProcessCaptureError)) throw cause;
    expect(cause.cleanupIncomplete).toBe(true);
    expect(cause.partialObservation).toMatchObject({
      capture: {
        settlement: { cleanup_outcome: "failed" },
        residual_unknowns: expect.arrayContaining([intervention]),
      },
    });
  } finally {
    rendererFails = false;
    await cleanup.cleanupLease?.release();
  }
});

it("does not invent intervention facts for a historical report", async () => {
  const observed = await observedCleanup(true);
  const historical: ProcessCaptureCleanupOutcome = {
    report: observed.report,
    cleanupLease: undefined,
  };
  const capture = resolveProcessResult(
    emptyProcessCapture(),
    undefined,
    historical,
  );
  expect(capture.settlement.cleanup_outcome).toBe("not_required");
  expect(capture.residual_unknowns).not.toContainEqual(intervention);
});

it("preserves saved intervention when a later report has no signal fact", async () => {
  const cleanup = await observedCleanup(true);
  const capture = resolveProcessResult(pendingCapture(), undefined, cleanup);
  const historical: ProcessCaptureCleanupOutcome = {
    report: cleanup.report,
    cleanupLease: undefined,
  };
  const restored = resolveProcessResult(capture, undefined, historical);
  expect(restored.settlement).toEqual(capture.settlement);
  expect(restored.residual_unknowns).toEqual(capture.residual_unknowns);
});

it.each([false, true])(
  "retains intervention before a capture exists, including failed cleanup: %s",
  async (cleanupFails) => {
    let rendererFails = cleanupFails;
    const cleanup = await observedCleanup(true, () => rendererFails);
    const observations = createProcessCaptureObservationBuffer({
      frames: [{ sequence: 0, at_ms: 0, data: "collected terminal output" }],
      interactions: [],
      samples: [],
      eventJournal: [],
      before: undefined,
    });
    observations.settlement = {
      state: "available",
      value: { state: "quiesced", elapsed_ms: 12 },
    };
    const failure = new Error("final filesystem snapshot failed");
    try {
      resolveProcessResult(undefined, failure, cleanup, observations);
      throw new Error("Expected incomplete observations");
    } catch (cause: unknown) {
      if (!(cause instanceof ProcessCaptureError)) throw cause;
      expect(cause.cause).toBe(failure);
      expect(cause.cleanupIncomplete).toBe(cleanupFails);
      expect(cause.partialObservation).toMatchObject({
        observations: {
          frames: observations.frames,
          settlement: observations.settlement,
          filesystem_snapshots: {
            after: { state: "unavailable" },
          },
          residual_unknowns: expect.arrayContaining([intervention]),
        },
      });
      expect(
        analysisErrorProjectionSchema.parse(projectAnalysisError(cause)),
      ).toMatchObject({
        details: {
          partial_observation: {
            observations: {
              residual_unknowns: expect.arrayContaining([intervention]),
            },
          },
        },
      });
    } finally {
      rendererFails = false;
      await cleanup.cleanupLease?.release();
    }
  },
);

it.each([false, undefined])(
  "does not infer intervention for incomplete observations from %s",
  async (signaled) => {
    const observed = await observedCleanup(false);
    const cleanup: ProcessCaptureCleanupOutcome = {
      report: observed.report,
      cleanupLease: observed.cleanupLease,
      ...(signaled === undefined ? {} : { ownedProcessesSignaled: signaled }),
    };
    const observations = createProcessCaptureObservationBuffer({
      frames: [],
      interactions: [],
      samples: [],
      eventJournal: [],
      before: undefined,
    });
    try {
      resolveProcessResult(
        undefined,
        new Error("terminal read failed"),
        cleanup,
        observations,
      );
      throw new Error("Expected incomplete observations");
    } catch (cause: unknown) {
      if (!(cause instanceof ProcessCaptureError)) throw cause;
      const partial = cause.partialObservation;
      if (partial === undefined || !("observations" in partial))
        throw new Error("Expected incomplete observations");
      expect(partial.observations).not.toHaveProperty("residual_unknowns");
      expect(partial.observations.settlement.state).toBe("unavailable");
    }
  },
);
