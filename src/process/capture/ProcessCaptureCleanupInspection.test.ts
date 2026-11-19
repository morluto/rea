import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import { expect, it, vi } from "vitest";
import { failedInspectionDescriptor } from "../../../tests/fixtures/processInspectionCleanup.js";
import {
  cleanupOwnedProcessGroup,
  type ProcessOwnershipHost,
} from "../ProcessOwnership.js";
import {
  ProcessOwnershipIdentityBatchFailure,
  ProcessOwnershipInspectionCancelled,
} from "../ProcessInspectionCancellation.js";
import {
  ProcessCaptureError,
  ProcessCaptureInspectionFailure,
} from "./ProcessCaptureError.js";
import {
  ProcessCaptureResourceScope,
  resolveProcessResult,
  type ProcessCaptureCleanupOutcome,
} from "./ProcessCaptureLifecycle.js";

const failureFor = (
  outcome: ProcessCaptureCleanupOutcome,
  primary?: ProcessCaptureError,
): ProcessCaptureError => {
  try {
    resolveProcessResult(undefined, primary, outcome);
  } catch (cause: unknown) {
    if (cause instanceof ProcessCaptureError) return cause;
    throw cause;
  }
  throw new Error("Expected controlled cleanup failure");
};

it("retries this run's inspection owner before fresh group queries while still disposing its renderer", async () => {
  const file = await failedInspectionDescriptor();
  const resources = new ProcessCaptureResourceScope();
  const inspection = resources.retainInspectionFailure(file.failure);
  if (inspection === undefined)
    throw new Error("Expected explicit descriptor failure");
  const query = vi.fn(async () => ({
    cleaned: true as const,
    signaled: false,
  }));
  const dispose = vi.fn(async () => undefined);
  const remove = vi.fn(async () => undefined);
  const cleanup = await resources.release({
    timers: new Set(),
    terminal: { pid: 321 },
    renderer: { dispose },
    runId: "selected-run",
    temporaryRoot: "/fixture/selected-root",
    inspectionFailures: [inspection],
    host: {
      platform: "linux",
      cleanupProcessGroup: query,
      removeTemporaryRoot: remove,
    },
  });
  const failure = failureFor(cleanup);
  expect(query).not.toHaveBeenCalled();
  expect(dispose).toHaveBeenCalledOnce();
  expect(remove).not.toHaveBeenCalled();
  expect(failure.cleanupResources).toContain(file.path);
  await expect(resources.close()).rejects.toMatchObject({
    cleanupIncomplete: true,
  });
  expect(query).not.toHaveBeenCalled();
  expect(file.handle.fd).not.toBe(-1);
  file.allow();
  await resources.close();
  expect(file.handle.fd).toBe(-1);
  expect(query).toHaveBeenCalledOnce();
  expect(dispose).toHaveBeenCalledOnce();
  expect(remove).toHaveBeenCalledOnce();
  expect(failure.cleanupIncomplete).toBe(false);
});

it.each([false, true])(
  "projects cancellation from mixed group-cleanup batch with prior physical failure: %s",
  async (hasPrimary) => {
    const file = await failedInspectionDescriptor();
    const reason = { caller: "recorded cleanup interruption" };
    const batch = new ProcessOwnershipIdentityBatchFailure(
      [
        { pid: 41, requestIndex: 0, cause: file.failure },
        {
          pid: 42,
          requestIndex: 1,
          cause: new ProcessOwnershipInspectionCancelled(reason),
        },
      ],
      new Map([
        [43, { state: "absent" as const, reason: "not-in-snapshot" as const }],
      ]),
    );
    let ready = false;
    const host: ProcessOwnershipHost = {
      platform: "linux",
      listProcesses: async () => {
        if (!ready) throw batch;
        return [];
      },
      environment: async () => {
        throw new Error("Unexpected environment inspection");
      },
      signalGroup: () => {
        throw new Error(
          "Empty controlled process table grants no signal authority",
        );
      },
    };
    const resources = new ProcessCaptureResourceScope();
    const query = vi.fn(
      (ownership: Parameters<typeof cleanupOwnedProcessGroup>[0]) =>
        cleanupOwnedProcessGroup(ownership, host),
    );
    const dispose = vi.fn(async () => undefined);
    const cleanup = await resources.release({
      timers: new Set(),
      terminal: { pid: 321 },
      renderer: { dispose },
      runId: "selected-run",
      temporaryRoot: "/fixture/selected-root",
      host: {
        platform: "linux",
        cleanupProcessGroup: query,
        removeTemporaryRoot: async () => undefined,
      },
    });
    const prior = hasPrimary
      ? new ProcessCaptureError("prior physical capture failure", {
          cause: new Error("physical before cleanup"),
        })
      : undefined;
    const failure = failureFor(cleanup, prior);
    const cleanupFailure =
      prior === undefined
        ? failure
        : failure.secondaryFailures.find(
            (error) =>
              error instanceof ProcessCaptureError &&
              error.reason === "cleanup_incomplete",
          );
    const inspection = cleanupFailure?.secondaryFailures.find(
      (error) => error instanceof ProcessCaptureInspectionFailure,
    );
    expect(inspection).toBeInstanceOf(ProcessCaptureInspectionFailure);
    if (!(inspection instanceof ProcessCaptureInspectionFailure))
      throw new Error("Group cleanup discarded explicit inspection facts");
    expect(inspection.inspectionFailure).toBe(batch);
    expect(inspection.reason).toBe("capture_failed");
    expect(inspection.secondaryFailures.map((error) => error.cause)).toEqual([
      reason,
    ]);
    expect(projectAnalysisError(failure)).toMatchObject({
      details: {
        secondary_failures: expect.arrayContaining([
          expect.objectContaining({ code: "cancelled" }),
        ]),
      },
    });
    if (prior !== undefined) expect(failure.cleanupPrimary).toBe(prior);
    expect(failure.cleanupResources).toContain(file.path);
    await expect(resources.close()).rejects.toMatchObject({
      cleanupIncomplete: true,
    });
    expect(query).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    ready = true;
    file.allow();
    await resources.close();
    expect(file.handle.fd).toBe(-1);
    expect(query).toHaveBeenCalledTimes(2);
    expect(failure.cleanupIncomplete).toBe(false);
    expect(inspection.inspectionFailure).toBe(batch);
    expect(batch.observations.get(43)).toEqual({
      state: "absent",
      reason: "not-in-snapshot",
    });
  },
);

it("does not borrow another active capture's inspection failure for group cleanup", async () => {
  const file = await failedInspectionDescriptor();
  const resources = new ProcessCaptureResourceScope();
  const other = resources.retainInspectionFailure(file.failure);
  if (other === undefined)
    throw new Error("Expected other capture's held inspection");
  const query = vi.fn(async () => ({
    cleaned: true as const,
    signaled: false,
  }));
  const cleanup = await resources.release({
    timers: new Set(),
    terminal: { pid: 987 },
    renderer: undefined,
    runId: "unrelated-run",
    temporaryRoot: "/fixture/unrelated-root",
    inspectionFailures: [],
    host: {
      platform: "linux",
      cleanupProcessGroup: query,
      removeTemporaryRoot: async () => undefined,
    },
  });
  expect(query).toHaveBeenCalledOnce();
  expect(cleanup.report.owned_process_group.state).toBe("cleaned");
  expect(cleanup.cleanupLease?.released).toBe(true);
  expect(file.handle.fd).not.toBe(-1);
  file.allow();
  await resources.close();
});
