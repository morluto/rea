import { expect, it, onTestFinished, vi } from "vitest";
import { failedInspectionDescriptor } from "../../../tests/fixtures/processInspectionCleanup.js";
import {
  assertProcessOwnershipInspectionActive,
  ProcessOwnershipIdentityBatchFailure,
} from "../ProcessInspectionCancellation.js";
import { systemProcessOwnershipHost } from "../ProcessOwnershipObservation.js";
import { settleSamplingReads } from "./ProcessSamplingObservation.js";
import {
  ProcessCaptureSamplingFailure,
  ProcessCaptureInspectionFailure,
} from "./ProcessCaptureError.js";
import { ProcessCaptureResourceScope } from "./ProcessCaptureLifecycle.js";
import { startProcessSampler } from "./ProcessSampling.js";
import { waitFor } from "../../../tests/support/testWait.js";

vi.mock("./LinuxProcessSampling.js", async (original) => ({
  ...(await original<typeof import("./LinuxProcessSampling.js")>()),
  readLinuxProcessStat: async () => ({
    value: {
      pid: 42,
      parent_pid: 1,
      process_group_id: 42,
      session_id: 42,
      startTime: "recording:42",
      command: "authored",
      lifecycle: undefined,
    },
    diagnostics: { count: 0, first: null, interrupted: false },
  }),
  inspectLinuxProcess: async () => {
    throw new Error("Unexpected procfs sampling");
  },
  inspectLinuxProcessMetadata: async () => {
    throw new Error("Unexpected procfs metadata");
  },
}));
vi.mock("../ExecFileOutput.js", async (original) => ({
  ...(await original<typeof import("../ExecFileOutput.js")>()),
  execFileOutput: async () => {
    throw new Error("Unexpected native ps");
  },
}));

it.each(["plain", "all-cancel", "mixed-fd", "opaque-peer"] as const)(
  "settles an actual pending run-token read during sampler-owned stop (%s)",
  async (kind) => {
    const file =
      kind === "mixed-fd" ? await failedInspectionDescriptor() : undefined;
    const scope = new ProcessCaptureResourceScope();
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "linux",
    });
    let original: unknown;
    const physical = new Error("opaque physical sibling rejection");
    const observations = new Map([
      [
        44,
        { state: "unavailable" as const, reason: "pending sampling identity" },
      ],
    ]);
    const environment = vi
      .spyOn(systemProcessOwnershipHost, "environment")
      .mockImplementation(async (_pid, signal) => {
        if (signal === undefined) throw new Error("Missing sampling signal");
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else
            signal.addEventListener("abort", () => resolve(), { once: true });
        });
        try {
          assertProcessOwnershipInspectionActive(signal);
        } catch (cancellation) {
          if (kind === "opaque-peer")
            return settleSamplingReads([
              Promise.reject(cancellation),
              Promise.reject(physical),
            ]).then(
              () => {
                throw new Error("Expected failed peers");
              },
              (cause: unknown) => {
                original = cause;
                throw cause;
              },
            );
          original =
            kind === "plain"
              ? cancellation
              : new ProcessOwnershipIdentityBatchFailure(
                  [
                    { pid: 42, requestIndex: 0, cause: cancellation },
                    ...(file === undefined
                      ? []
                      : [{ pid: 44, requestIndex: 1, cause: file.failure }]),
                  ],
                  observations,
                );
          throw original;
        }
        throw new Error("Stop did not cancel pending read");
      });
    vi.spyOn(systemProcessOwnershipHost, "listProcesses").mockRejectedValue(
      new Error("Unexpected process listing"),
    );
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("Unexpected process signal");
    });
    const stop = startProcessSampler({
      rootPid: 42,
      runId: "authored",
      started: 0,
      limit: 20,
      samples: [],
      resourceScope: scope,
    });
    onTestFinished(async () => {
      file?.allow();
      try {
        try {
          await scope.close();
        } finally {
          await stop().catch((cause: unknown) => {
            if (
              !(cause instanceof ProcessCaptureInspectionFailure) &&
              !(cause instanceof ProcessCaptureSamplingFailure)
            )
              throw cause;
          });
        }
      } finally {
        vi.restoreAllMocks();
        if (platform !== undefined)
          Object.defineProperty(process, "platform", platform);
      }
    });
    await waitFor(() => expect(environment).toHaveBeenCalledOnce());
    const outcome = stop();
    if (kind === "opaque-peer") {
      const failure: unknown = await outcome.catch((cause: unknown) => cause);
      expect(failure).toBeInstanceOf(ProcessCaptureSamplingFailure);
      if (!(failure instanceof ProcessCaptureSamplingFailure))
        throw new Error("Expected physical batch");
      expect(failure.samplingFailure).toBe(original);
      expect(failure.userCategory).toBeUndefined();
      expect(failure.samplingFailure.outcomes[1]).toEqual({
        status: "rejected",
        reason: physical,
      });
    } else if (file === undefined) {
      await expect(outcome).resolves.toMatchObject({
        partial: true,
        coverage: {
          sampling_failures: 1,
          first_sampling_failure: expect.stringMatching(/interrupted/u),
        },
      });
    } else {
      const failure: unknown = await outcome.catch((cause: unknown) => cause);
      expect(failure).toBeInstanceOf(ProcessCaptureInspectionFailure);
      if (!(failure instanceof ProcessCaptureInspectionFailure))
        throw new Error("Expected retained physical failure");
      expect(failure.inspectionFailure).toBe(original);
      expect(failure.userCategory).toBeUndefined();
      expect(failure.cleanupIncomplete).toBe(true);
      await expect(scope.retryCleanup()).rejects.toBeDefined();
      expect(file.handle.fd).toBeGreaterThanOrEqual(0);
      file.allow();
      await scope.retryCleanup();
      expect(file.handle.fd).toBe(-1);
      expect(failure.cleanupIncomplete).toBe(false);
      expect(failure.inspectionFailure).toBe(original);
      if (!(original instanceof ProcessOwnershipIdentityBatchFailure))
        throw new Error("Expected batch");
      expect(original.observations).toBe(observations);
    }
  },
);
