import { expect, it } from "vitest";

import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { EngineCloseReport } from "../domain/engineCloseReport.js";
import { err, ok } from "../domain/result.js";
import { silentLogger } from "../logger.js";
import type { PartialProcessCaptureObservation } from "../domain/process/processCapture.js";
import { ProcessCaptureError } from "../process/capture/ProcessCaptureError.js";
import { closeWithProcessResources } from "./sessionLifecycle.js";

const discarded = {
  checkpoint: {
    status: "discarded",
    reason: "superseded",
    directory: "/checkpoints",
  },
} as const satisfies EngineCloseReport;

it("reports a discard on the close that released the edits, not on a close sharing its cleanup failure", async () => {
  const cleanup = new ProcessCaptureError(
    "Process capture cleanup remains incomplete: denied",
    {
      reason: "cleanup_incomplete",
      executionFailure: "denied",
      cleanup: {
        reason: "denied",
        resources: ["process_capture_resources"],
      },
    },
  );
  let release: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    release = resolve;
  });
  const close = closeWithProcessResources({
    logger: silentLogger,
    closeProcessResources: () => started.then(() => err(cleanup)),
  });
  const releasing = close(async () => ok(discarded));
  const other = close(async () => ok(null));
  release();
  const [released, untouched] = await Promise.all([releasing, other]);
  if (released.ok || untouched.ok)
    throw new Error("shared cleanup failure was not reported");
  expect(projectAnalysisError(released.error)).toMatchObject({
    code: "cleanup_incomplete",
    recovery: { kind: "retry_cleanup", operation: "close_binary" },
    details: {
      execution_failure: "denied",
      resources: ["process_capture_resources"],
      partial_observation: discarded,
    },
  });
  expect(projectAnalysisError(untouched.error)).toMatchObject({
    code: "cleanup_incomplete",
    recovery: { kind: "retry_cleanup", operation: "close_binary" },
    details: {
      execution_failure: "denied",
      resources: ["process_capture_resources"],
    },
  });
  expect(
    projectAnalysisError(untouched.error).details?.partial_observation,
  ).toBeUndefined();
  expect(cleanup.partialObservation).toBeUndefined();
  expect(released.error).not.toBe(untouched.error);
});

it("keeps a process capture's collected facts on the close that reports them", async () => {
  const captured = {
    scenario_id: "cap-kept",
  } as unknown as PartialProcessCaptureObservation;
  const cleanup = new ProcessCaptureError(
    "Process capture cleanup remains incomplete: denied",
    {
      reason: "cleanup_incomplete",
      executionFailure: "denied",
      partialObservation: captured,
      cleanup: {
        reason: "denied",
        resources: ["process_capture_resources"],
      },
    },
  );
  const close = closeWithProcessResources({
    logger: silentLogger,
    closeProcessResources: async () => err(cleanup),
  });
  const closed = await close(async () => ok(discarded));
  if (closed.ok) throw new Error("shared cleanup failure was not reported");
  expect(projectAnalysisError(closed.error)).toMatchObject({
    code: "cleanup_incomplete",
    details: {
      partial_observation: {
        checkpoint: discarded.checkpoint,
        cleanup_observation: { scenario_id: "cap-kept" },
      },
    },
  });
  expect(cleanup.partialObservation).toEqual({ scenario_id: "cap-kept" });
});
