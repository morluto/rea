import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { expect, it, onTestFinished, vi } from "vitest";
import { failedInspectionDescriptor } from "../../../tests/fixtures/processInspectionCleanup.js";
import {
  readProcessRunId,
  type ProcessOwnershipHost,
} from "../ProcessOwnership.js";
import {
  ProcessOwnershipIdentityBatchFailure,
  ProcessOwnershipInspectionCancelled,
} from "../ProcessInspectionCancellation.js";
import { ProcessCaptureInspectionFailure } from "./ProcessCaptureError.js";
import { ProcessCaptureResourceScope } from "./ProcessCaptureLifecycle.js";
import { readSamplingSource } from "./ProcessSamplingObservation.js";

const recordingHost = (cause: unknown): ProcessOwnershipHost => ({
  platform: "linux",
  environment: vi.fn(async () => {
    throw cause;
  }),
  listProcesses: async () => {
    throw new Error("Unexpected process inspection");
  },
  signalGroup: () => {
    throw new Error("Unexpected process signal");
  },
});

it.each(["descriptor", "batch"] as const)(
  "retains the actual run-token %s failure through sampling and capture-scope retry",
  async (kind) => {
    const file = await failedInspectionDescriptor();
    const observations = new Map([
      [
        44,
        {
          state: "unavailable" as const,
          reason: "retained sampling observation",
        },
      ],
    ]);
    const reason = { caller: "opaque cancellation" };
    const cancellation = new ProcessOwnershipInspectionCancelled(reason);
    const cause =
      kind === "descriptor"
        ? file.failure
        : new ProcessOwnershipIdentityBatchFailure(
            [
              { pid: 42, requestIndex: 0, cause: file.failure },
              { pid: 44, requestIndex: 1, cause: cancellation },
            ],
            observations,
          );
    const scope = new ProcessCaptureResourceScope();
    onTestFinished(async () => {
      file.allow();
      await scope.close();
    });
    const host = recordingHost(cause);
    let failure: unknown;
    try {
      await readSamplingSource(
        "authored run token",
        new AbortController().signal,
        () => readProcessRunId(42, host),
      );
    } catch (error) {
      failure = error;
    }
    const retained = scope.retainInspectionFailure(failure);
    expect(retained).toBeInstanceOf(ProcessCaptureInspectionFailure);
    if (retained === undefined)
      throw new Error("Sampling lost its inspection owner");
    expect(retained.inspectionFailure).toBe(cause);
    expect(retained.cleanupIncomplete).toBe(true);
    await expect(scope.retryCleanup()).rejects.toBeDefined();
    expect(file.handle.fd).toBeGreaterThanOrEqual(0);
    let nextCapture = false;
    await expect(
      scope.run(async () => {
        nextCapture = true;
      }),
    ).rejects.toBeDefined();
    expect(nextCapture).toBe(false);
    file.allow();
    await scope.retryCleanup();
    expect(file.handle.fd).toBe(-1);
    expect(retained.cleanupIncomplete).toBe(false);
    expect(retained.inspectionFailure).toBe(cause);
    if (cause instanceof ProcessOwnershipIdentityBatchFailure) {
      expect(cause.observations).toBe(observations);
      expect(cause.cancellations[0]?.cancellation.reason).toBe(reason);
      expect(retained.userCategory).toBeUndefined();
    }
    await scope.run(async () => {
      nextCapture = true;
    });
    expect(nextCapture).toBe(true);
    expect(host.environment).toHaveBeenCalledOnce();
  },
);

it("propagates actual typed cancellation while keeping ordinary EIO optional and unknown", async () => {
  const reason = { opaque: true };
  const cancellation = new ProcessOwnershipInspectionCancelled(reason);
  const scope = new ProcessCaptureResourceScope();
  onTestFinished(() => scope.close());
  let failure: unknown;
  try {
    await readSamplingSource("token", new AbortController().signal, () =>
      readProcessRunId(42, recordingHost(cancellation)),
    );
  } catch (error) {
    failure = error;
  }
  const retained = scope.retainInspectionFailure(failure);
  expect(retained?.inspectionFailure).toBe(cancellation);
  expect(retained?.cause).toBe(reason);
  expect(retained?.userCategory).toBe("cancelled");
  const physical = Object.assign(new Error("optional read failed"), {
    code: "EIO",
  });
  const unknown = await readSamplingSource(
    "token",
    new AbortController().signal,
    () => readProcessRunId(42, recordingHost(physical)),
  );
  expect(unknown).toMatchObject({
    ok: false,
    error: { kind: "unavailable", systemCode: "EIO" },
  });
  expect(scope.retainInspectionFailure(physical)).toBeUndefined();
});

it("keeps an actual physical filesystem rejection when it is reused as the sampling abort reason", async () => {
  const directory = await createTestTempDirectory("rea-sampling-origin-");
  const controller = new AbortController();
  let physical: unknown;
  const result = await readSamplingSource(
    "authored optional file",
    controller.signal,
    async () => {
      try {
        return await readFile(join(directory, "absent"), {
          signal: controller.signal,
        });
      } catch (cause) {
        physical = cause;
        controller.abort(cause);
        throw cause;
      }
    },
  );
  expect(controller.signal.reason).toBe(physical);
  expect(result).toMatchObject({
    ok: false,
    error: { kind: "unavailable", systemCode: "ENOENT" },
  });
});
