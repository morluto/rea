import { expect, it, vi } from "vitest";
import { failedInspectionDescriptor } from "../../../tests/fixtures/processInspectionCleanup.js";
import { processScenarioSchema } from "../../domain/process/processScenario.js";
import { emptyProcessCapture } from "../../domain/process/processCapture.fixture.js";
import { primaryAnalysisError } from "../../domain/analysisErrorBase.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import {
  ProcessOwnershipInspectionCancelled,
  ProcessOwnershipIdentityBatchFailure,
} from "../ProcessInspectionCancellation.js";
import { ProcessCaptureError } from "./ProcessCaptureError.js";
import {
  prepareProcessCapture,
  ProcessCaptureResourceScope,
} from "./ProcessCaptureLifecycle.js";

const before = {
  files: [],
  truncated: false,
  completeRoots: [],
  coverage: emptyProcessCapture().truncation_details.filesystem_before,
};
const scenario = processScenarioSchema.parse({
  executable: "/inert/selected-executable",
});
const prepare = (
  failure: unknown,
  stage: "inspector" | "baseline",
  resources: ProcessCaptureResourceScope,
  signal?: AbortSignal,
) => {
  const allocate = vi.fn(async () => "/fixture/allocated-root");
  const snapshot = vi.fn(async () => before);
  const remove = vi.fn(async () => undefined);
  const result = prepareProcessCapture(
    scenario,
    signal,
    snapshot,
    {
      prepareOwnershipInspector: async () => {
        if (stage === "inspector") throw failure;
      },
      createTemporaryRoot: allocate,
      captureOwnershipBaseline: async () => {
        throw failure;
      },
      cleanup: remove,
    },
    resources,
  ).catch((cause: unknown) => cause);
  return { result, allocate, snapshot, remove };
};

it.each(
  (["inspector", "baseline"] as const).flatMap((stage) =>
    [false, true].map((batch) => ({ stage, batch })),
  ),
)(
  "projects producer-owned cancellation at $stage (batch: $batch)",
  async ({ stage, batch }) => {
    const reason = { caller: "exact cancellation value" };
    const cancellation = new ProcessOwnershipInspectionCancelled(reason);
    const failure = batch
      ? new ProcessOwnershipIdentityBatchFailure(
          [{ pid: 42, requestIndex: 0, cause: cancellation }],
          new Map([
            [
              41,
              { state: "absent" as const, reason: "not-in-snapshot" as const },
            ],
          ]),
        )
      : cancellation;
    const resources = new ProcessCaptureResourceScope();
    const work = prepare(failure, stage, resources);
    const observed = await work.result;
    expect(observed).toBeInstanceOf(ProcessCaptureError);
    if (!(observed instanceof ProcessCaptureError))
      throw new Error("Expected normalized capture cancellation");
    expect(observed.reason).toBe("cancelled");
    expect(observed.cause).toBe(reason);
    expect(projectAnalysisError(observed)).toMatchObject({ code: "cancelled" });
    const primary = primaryAnalysisError(observed);
    expect("inspectionFailure" in primary && primary.inspectionFailure).toBe(
      failure,
    );
    if (batch)
      expect(primary.diagnostics).toMatchObject({
        retained_observation_count: 1,
        rejected_request_count: 1,
      });
    expect(work.allocate).toHaveBeenCalledTimes(stage === "inspector" ? 0 : 1);
    expect(work.snapshot).toHaveBeenCalledTimes(stage === "inspector" ? 0 : 1);
    expect(work.remove).toHaveBeenCalledTimes(stage === "inspector" ? 0 : 1);
    if (stage === "baseline")
      expect(observed.partialObservation).toMatchObject({
        observations: {
          filesystem_snapshots: {
            before: { state: "available", value: before },
          },
        },
      });
    await resources.close();
  },
);

it.each(
  (["inspector", "baseline"] as const).flatMap((stage) =>
    [false, true].map((batch) => ({ stage, batch })),
  ),
)(
  "retains physical inspection descriptor failure at $stage (batch: $batch)",
  async ({ stage, batch }) => {
    const file = await failedInspectionDescriptor();
    const reason = new Error("recorded cancellation after physical failure");
    const failure = batch
      ? new ProcessOwnershipIdentityBatchFailure(
          [
            { pid: 41, requestIndex: 0, cause: file.failure },
            {
              pid: 42,
              requestIndex: 1,
              cause: new ProcessOwnershipInspectionCancelled(reason),
            },
          ],
          new Map([
            [
              43,
              { state: "absent" as const, reason: "not-in-snapshot" as const },
            ],
          ]),
        )
      : file.failure;
    const resources = new ProcessCaptureResourceScope();
    const work = prepare(failure, stage, resources);
    const observed = await work.result;
    expect(observed).toBeInstanceOf(ProcessCaptureError);
    if (!(observed instanceof ProcessCaptureError))
      throw new Error("Expected retained inspection failure");
    const primary = primaryAnalysisError(observed);
    expect(primary.cause).toBe(failure);
    expect(observed.reason).toBe("capture_failed");
    expect(observed.cleanupResources).toContain(file.path);
    expect(primary.secondaryFailures.map((failure) => failure.cause)).toEqual(
      batch ? [reason] : [],
    );
    expect(projectAnalysisError(observed)).toMatchObject({
      code: "cleanup_incomplete",
    });
    await expect(resources.close()).rejects.toMatchObject({
      cleanupIncomplete: true,
    });
    expect(file.handle.fd).not.toBe(-1);
    file.allow();
    await resources.close();
    expect(file.handle.fd).toBe(-1);
    expect(observed.cleanupIncomplete).toBe(false);
    expect(projectAnalysisError(observed)).toMatchObject({
      code: "process_capture_failed",
    });
    expect(work.allocate).toHaveBeenCalledTimes(stage === "inspector" ? 0 : 1);
    expect(work.remove).toHaveBeenCalledTimes(stage === "inspector" ? 0 : 1);
  },
);

it("preserves a physical AbortError while a later caller cancellation is present", async () => {
  const failure = new DOMException("physical inspection failure", "AbortError");
  const controller = new AbortController();
  const resources = new ProcessCaptureResourceScope();
  const observed: unknown = await prepareProcessCapture(
    scenario,
    controller.signal,
    async () => before,
    {
      createTemporaryRoot: async () => "/fixture/allocated-root",
      captureOwnershipBaseline: async () => {
        controller.abort("later cancellation");
        throw failure;
      },
      cleanup: async () => undefined,
    },
    resources,
  ).catch((cause: unknown) => cause);
  expect(observed).toBeInstanceOf(ProcessCaptureError);
  if (!(observed instanceof ProcessCaptureError))
    throw new Error("Expected physical capture failure");
  expect(observed.reason).toBe("capture_failed");
  expect(observed.cause).toBe(failure);
  await resources.close();
});
