import { expect, it, vi } from "vitest";
import { processScenarioSchema } from "../../domain/process/processScenario.js";
import { AnalysisCapabilityUnavailableError } from "../../domain/analysisErrorCore.js";
import {
  captureProcessScenario,
  normalizeCaptureFailure,
  ProcessCaptureError,
} from "./ProcessHarness.js";
import { settleProcessCaptureJournal } from "./ProcessCaptureLifecycle.js";
import {
  parseProcessCapture,
  partialProcessCaptureObservationSchema,
  processCaptureSchema,
} from "../../domain/process/processCapture.js";
import { EMPTY_PROCESS_CAPTURE_EXAMPLE } from "../../domain/process/processCapture.fixture.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import { emptyProcessCapture } from "../../domain/process/processCapture.fixture.js";
import { analysisErrorProjectionSchema } from "../../contracts/errorSchemas.js";
import {
  releaseProcessResources,
  resolveProcessResult,
  type ProcessCaptureCleanupHost,
} from "./ProcessCaptureLifecycle.js";
import { DarwinProcessOwnershipInspectionError } from "../DarwinProcessRunTokenReader.js";

it("rejects legacy replay output instead of silently discarding it", () => {
  expect(
    processCaptureSchema.safeParse({
      ...EMPTY_PROCESS_CAPTURE_EXAMPLE,
      protocol_events: [],
    }).success,
  ).toBe(false);
});

it("preserves the actionable Darwin ownership compiler prerequisite", () => {
  const normalized = normalizeCaptureFailure(
    new DarwinProcessOwnershipInspectionError(
      "macOS process ownership inspection requires the Apple Swift compiler via xcrun",
    ),
    undefined,
  );

  expect(normalized).toBeInstanceOf(ProcessCaptureError);
  expect(normalized).toMatchObject({
    message:
      "macOS process ownership inspection requires the Apple Swift compiler via xcrun",
  });
});

it("waits for terminal observations delivered after the exit callback", async () => {
  const journal: Array<{
    capture_order: number;
    collection: "frames";
    index: number;
  }> = [{ capture_order: 0, collection: "frames", index: 0 }];
  const lateFrame = new Promise<void>((resolve) => {
    setTimeout(() => {
      journal.push({ capture_order: 1, collection: "frames", index: 1 });
      resolve();
    }, 12);
  });

  let settled = false;
  const wait = settleProcessCaptureJournal(journal, 20, 200).then(() => {
    settled = true;
  });
  await lateFrame;
  expect(settled).toBe(false);
  await wait;

  expect(journal).toHaveLength(2);
  expect(journal[1]).toMatchObject({ collection: "frames", index: 1 });
});

it("keeps empty cleanup exception messages actionable in the report", async () => {
  const host: ProcessCaptureCleanupHost = {
    platform: process.platform,
    cleanupProcessGroup: async () => ({
      cleaned: false,
      reason: "unused process cleanup",
    }),
    verifyTokenOwnedProcesses: async () => ({
      cleaned: false,
      reason: "unused process cleanup",
    }),
    removeTemporaryRoot: async () => {
      throw new Error("");
    },
  };
  const report = await releaseProcessResources({
    timers: new Set(),
    terminal: undefined,
    renderer: undefined,
    runId: "fixture-run",
    temporaryRoot: "/fixture/root",
    host,
  });

  expect(report.temporary_root).toEqual({ state: "failed", reason: "Error" });
});

it("waits for token-owned processes to exit after one cleanup signal", async () => {
  vi.useFakeTimers();
  try {
    let verificationCalls = 0;
    const exitsAt = Date.now() + 50;
    let cleanupCalls = 0;
    const host: ProcessCaptureCleanupHost = {
      platform: "linux",
      cleanupProcessGroup: async () => {
        cleanupCalls += 1;
        return { cleaned: true, signaled: true };
      },
      verifyTokenOwnedProcesses: async () => {
        verificationCalls += 1;
        return Date.now() < exitsAt
          ? { cleaned: false, reason: "owned process is exiting" }
          : { cleaned: true, signaled: false };
      },
      removeTemporaryRoot: async () => undefined,
    };
    const result = releaseProcessResources({
      timers: new Set(),
      terminal: { pid: 321 },
      renderer: undefined,
      runId: "fixture-run",
      temporaryRoot: "/fixture/root",
      host,
    });

    await vi.runAllTimersAsync();
    const report = await result;

    expect(report.owned_process_group).toEqual({
      state: "cleaned",
      reason: null,
    });
    expect(cleanupCalls).toBe(1);
    expect(verificationCalls).toBeGreaterThan(1);
  } finally {
    vi.useRealTimers();
  }
});

it("retains the last ownership failure when the verification grace expires", async () => {
  vi.useFakeTimers();
  try {
    let verificationCalls = 0;
    let cleanupCalls = 0;
    const host: ProcessCaptureCleanupHost = {
      platform: "linux",
      cleanupProcessGroup: async () => {
        cleanupCalls += 1;
        return { cleaned: true, signaled: true };
      },
      verifyTokenOwnedProcesses: async () => {
        verificationCalls += 1;
        return {
          cleaned: false,
          reason:
            verificationCalls === 1
              ? "owned process has not exited yet"
              : "owned process remained after identity recheck",
        };
      },
      removeTemporaryRoot: async () => undefined,
    };
    const result = releaseProcessResources({
      timers: new Set(),
      terminal: { pid: 322 },
      renderer: undefined,
      runId: "fixture-run",
      temporaryRoot: "/fixture/root",
      host,
    });

    await vi.runAllTimersAsync();
    const report = await result;

    expect(report.owned_process_group).toEqual({
      state: "unverified",
      reason: "owned process remained after identity recheck",
    });
    expect(cleanupCalls).toBe(1);
    expect(verificationCalls).toBeGreaterThan(1);
  } finally {
    vi.useRealTimers();
  }
});

it("passes sampled detached groups into cleanup even when their token is unknown", async () => {
  let sampledGroups: readonly number[] | undefined;
  const host: ProcessCaptureCleanupHost = {
    platform: "linux",
    cleanupProcessGroup: async (ownership) => {
      sampledGroups = ownership.sampledProcessGroupIds;
      return {
        cleaned: false,
        reason: "sampled group has no verifiable run token",
      };
    },
    verifyTokenOwnedProcesses: async () => ({
      cleaned: true,
      signaled: false,
    }),
    removeTemporaryRoot: async () => undefined,
  };

  const report = await releaseProcessResources({
    timers: new Set(),
    terminal: { pid: 321 },
    renderer: undefined,
    runId: "fixture-run",
    temporaryRoot: "/fixture/root",
    sampledProcessGroupIds: [654],
    host,
  });

  expect(sampledGroups).toEqual([654]);
  expect(report.owned_process_group).toEqual({
    state: "unverified",
    reason: "sampled group has no verifiable run token",
  });
});

it("retains observations and both causes when process cleanup is unverifiable", () => {
  const verified = emptyProcessCapture();
  const capture = parseProcessCapture({
    ...verified,
    frames: [{ sequence: 0, at_ms: 0, data: "observed output" }],
    process_samples: [
      {
        at_ms: 1,
        pid: 654,
        parent_pid: 321,
        command: "sanitized-detached-child",
        process_group_id: 654,
        session_id: 654,
      },
    ],
    event_journal: [],
  });
  const executionFailure = new Error("capture ended after a fixture error");
  const cleanup = {
    owned_process_group: {
      state: "unverified" as const,
      reason:
        "process ownership token could not be read for 1 live process(es): environment_unavailable=1",
    },
    terminal_renderer: { state: "cleaned" as const, reason: null },
    temporary_root: { state: "cleaned" as const, reason: null },
  };

  let error: ProcessCaptureError | undefined;
  try {
    resolveProcessResult(capture, executionFailure, cleanup);
  } catch (cause: unknown) {
    if (!(cause instanceof ProcessCaptureError)) throw cause;
    error = cause;
  }
  expect(error).toBeDefined();
  if (error === undefined) throw new Error("expected cleanup-incomplete error");

  const projection = projectAnalysisError(error);
  const parsedProjection = analysisErrorProjectionSchema.parse(projection);
  expect(parsedProjection).toMatchObject({
    code: "cleanup_incomplete",
    details: {
      cleanup_report: cleanup,
      execution_failure: "capture ended after a fixture error",
      partial_observation: {
        capture: {
          frames: [{ data: "observed output" }],
          process_samples: [{ pid: 654, process_group_id: 654 }],
          settlement: { cleanup_outcome: "failed" },
        },
        execution_failure: "capture ended after a fixture error",
      },
    },
  });
  expect(error.cause).toBe(executionFailure);
  const partialObservation = error.partialObservation;
  expect(partialObservation).toBeDefined();
  if (partialObservation === undefined)
    throw new Error("expected validated partial observation");
  expect(
    partialProcessCaptureObservationSchema.safeParse({
      ...partialObservation,
      cleanup: {
        owned_process_group: { state: "cleaned", reason: null },
        terminal_renderer: { state: "cleaned", reason: null },
        temporary_root: { state: "cleaned", reason: null },
      },
    }).success,
  ).toBe(false);
  if (!("capture" in partialObservation))
    throw new Error("expected completed partial capture observations");
  const partialCapture = partialObservation.capture;
  expect(() => parseProcessCapture(partialCapture)).toThrow();
});

it("projects execution and cleanup failures when capture never completed", () => {
  const executionFailure = new Error("terminal startup failed");
  const cleanup = {
    owned_process_group: {
      state: "unverified" as const,
      reason: "process ownership token could not be read",
    },
    terminal_renderer: { state: "cleaned" as const, reason: null },
    temporary_root: { state: "cleaned" as const, reason: null },
  };

  let error: ProcessCaptureError | undefined;
  try {
    resolveProcessResult(undefined, executionFailure, cleanup);
  } catch (cause: unknown) {
    if (!(cause instanceof ProcessCaptureError)) throw cause;
    error = cause;
  }
  expect(error).toBeDefined();
  if (error === undefined) throw new Error("expected cleanup-incomplete error");

  expect(error.partialObservation).toBeUndefined();
  expect(error.cause).toBe(executionFailure);
  expect(projectAnalysisError(error)).toMatchObject({
    code: "cleanup_incomplete",
    details: {
      cleanup_report: cleanup,
      execution_failure: "terminal startup failed",
    },
  });
});

it("fails closed on Windows before resolving or launching scenario paths", async () => {
  const scenario = processScenarioSchema.parse({
    executable: "Z:/missing/should-never-be-resolved.exe",
    working_directory: "Z:/missing/working-directory",
  });
  const result = await captureProcessScenario(scenario, undefined, "win32");
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected Windows ownership refusal");
  if (!(result.error instanceof AnalysisCapabilityUnavailableError))
    throw new Error("expected a capability-unavailable outcome");
  expect(result.error).toMatchObject({
    operation: "capture_process_scenario",
    reason: expect.stringContaining("Windows PTY process capture"),
  });
  expect(projectAnalysisError(result.error)).toMatchObject({
    code: "capability_unavailable",
    category: "unsupported_provider",
    message: expect.stringContaining("does not yet verify descendant cleanup"),
    details: {
      operation: "capture_process_scenario",
      reason: result.error.reason,
    },
  });
});
