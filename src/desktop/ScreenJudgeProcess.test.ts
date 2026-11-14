import { existsSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { dirname } from "node:path";
import { expect, it, vi } from "vitest";

import {
  OwnedCommandFailure,
  runOwnedCommand,
} from "../process/OwnedCommand.js";
import type {
  ProviderProcessStopResult,
  ProviderProcessSupervisor,
} from "../process/ProviderProcess.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { ScreenJudgeProcess } from "./ScreenJudgeProcess.js";
import { waitFor } from "../../tests/support/testWait.js";

vi.mock("./AgentEnvComputerHelper.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./AgentEnvComputerHelper.js")>()),
  agentEnvInterpreter: vi.fn(async () => "/python"),
}));
vi.mock("../process/OwnedCommand.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/OwnedCommand.js")>()),
  runOwnedCommand: vi.fn(),
}));

it("retains the screenshot and process owner after cancelled cleanup until retry succeeds", async () => {
  const stop = vi
    .fn<ProviderProcessSupervisor["stop"]>()
    .mockResolvedValueOnce({ status: "incomplete", reason: "still running" })
    .mockResolvedValueOnce({
      status: "terminated",
    } satisfies ProviderProcessStopResult);
  const dispose = vi.fn();
  const owner = { stop, dispose } as unknown as ProviderProcessSupervisor;
  const cancelled = new OwnedCommandFailure(
    "cancelled",
    "cancelled",
    null,
    "still running",
    undefined,
    ["run"],
    owner,
  );
  vi.mocked(runOwnedCommand).mockRejectedValueOnce(cancelled);
  const judge = new ScreenJudgeProcess({});
  const controller = new AbortController();
  const failure: unknown = await judge
    .judge(
      "/verifier",
      { id: "x", kind: "screen_judge", question: "ready?" },
      new Uint8Array([1]),
      controller.signal,
    )
    .catch((cause: unknown) => cause);
  expect(failure).toBeInstanceOf(ProviderCleanupError);
  expect((failure as ProviderCleanupError).cause).toBe(cancelled);
  expect((failure as ProviderCleanupError).cleanupPrimary?._tag).toBe(
    "AnalysisCancelledError",
  );
  const call = vi.mocked(runOwnedCommand).mock.calls.at(-1);
  if (call === undefined) throw new Error("judge was not launched");
  const folder = dirname(call[0].arguments[3]!);
  expect(existsSync(folder)).toBe(true);
  expect(await judge.close()).toMatchObject({
    verified: false,
    resources: ["run", folder],
  });
  expect(existsSync(folder)).toBe(true);
  if (process.platform !== "win32" && process.getuid?.() !== 0) {
    await chmod(folder, 0o500);
    try {
      expect(await judge.close()).toMatchObject({
        verified: false,
        resources: [folder],
      });
      expect((failure as ProviderCleanupError).cleanupResources).toEqual([
        folder,
      ]);
    } finally {
      await chmod(folder, 0o700);
    }
  }
  expect(await judge.close()).toMatchObject({ verified: true });
  expect(existsSync(folder)).toBe(false);
  expect(stop).toHaveBeenCalledTimes(2);
  expect(dispose).toHaveBeenCalledTimes(1);
  expect((failure as ProviderCleanupError).cleanupIncomplete).toBe(false);
});

it("retries retained cleanup before launching another judge", async () => {
  const stop = vi
    .fn<ProviderProcessSupervisor["stop"]>()
    .mockResolvedValueOnce({ status: "incomplete", reason: "still running" })
    .mockResolvedValueOnce({
      status: "terminated",
    } satisfies ProviderProcessStopResult);
  const owner = {
    stop,
    dispose: vi.fn(),
  } as unknown as ProviderProcessSupervisor;
  vi.mocked(runOwnedCommand).mockRejectedValueOnce(
    new OwnedCommandFailure(
      "cancelled",
      "cancelled",
      null,
      "still running",
      undefined,
      ["run"],
      owner,
    ),
  );
  const judge = new ScreenJudgeProcess({});
  const check = { id: "x", kind: "screen_judge", question: "ready?" } as const;
  const signal = new AbortController().signal;
  const first = await judge
    .judge("/verifier", check, new Uint8Array([1]), signal)
    .catch((cause: unknown) => cause);
  const launches = vi.mocked(runOwnedCommand).mock.calls.length;
  try {
    await expect(
      judge.judge("/verifier", check, new Uint8Array([1]), signal),
    ).rejects.toMatchObject({ cleanupIncomplete: true });
    expect(vi.mocked(runOwnedCommand).mock.calls).toHaveLength(launches);
    expect((first as ProviderCleanupError).cleanupIncomplete).toBe(true);
  } finally {
    const released = await judge.close();
    if (!released.verified) await judge.close();
  }
  expect((first as ProviderCleanupError).cleanupIncomplete).toBe(false);
});

it("starts a later judge once retained cleanup succeeds", async () => {
  const owner = {
    stop: vi.fn().mockResolvedValue({
      status: "terminated",
    } satisfies ProviderProcessStopResult),
    dispose: vi.fn(),
  } as unknown as ProviderProcessSupervisor;
  const text = JSON.stringify({ id: "x", result: true, description: "ready" });
  vi.mocked(runOwnedCommand)
    .mockRejectedValueOnce(
      new OwnedCommandFailure(
        "process",
        "failed",
        null,
        "running",
        undefined,
        ["run"],
        owner,
      ),
    )
    .mockResolvedValueOnce({
      exitCode: 0,
      stdout: {
        text,
        bytes: Buffer.byteLength(text),
        observedBytes: Buffer.byteLength(text),
      },
      stderr: { text: "", bytes: 0, observedBytes: 0 },
      signal: null,
    });
  const judge = new ScreenJudgeProcess({});
  const check = { id: "x", kind: "screen_judge", question: "ready?" } as const;
  const signal = new AbortController().signal;
  const first: unknown = await judge
    .judge("/verifier", check, new Uint8Array([1]), signal)
    .catch((cause: unknown) => cause);
  expect(first).toBeInstanceOf(ProviderCleanupError);
  expect(
    await judge.judge("/verifier", check, new Uint8Array([1]), signal),
  ).toEqual({ id: "x", passed: true, description: "ready" });
  expect((first as ProviderCleanupError).cleanupIncomplete).toBe(false);
  expect(await judge.close()).toMatchObject({ verified: true });
});

it("reports a completed answer when process cleanup subsequently fails", async () => {
  const text = JSON.stringify({
    id: "x",
    result: true,
    description: "observed",
  });
  const snapshot = {
    exitCode: 0,
    stdout: {
      text,
      bytes: Buffer.byteLength(text),
      observedBytes: Buffer.byteLength(text),
    },
    stderr: { text: "", bytes: 0, observedBytes: 0 },
    signal: null,
  };
  const owner = {
    stop: vi.fn().mockResolvedValue({
      status: "terminated",
    } satisfies ProviderProcessStopResult),
    dispose: vi.fn(),
  } as unknown as ProviderProcessSupervisor;
  vi.mocked(runOwnedCommand).mockRejectedValueOnce(
    new OwnedCommandFailure(
      "process",
      "cleanup failed",
      snapshot,
      "still running",
      undefined,
      ["run"],
      owner,
    ),
  );
  const judge = new ScreenJudgeProcess({});
  const failure: unknown = await judge
    .judge(
      "/verifier",
      { id: "x", kind: "screen_judge", question: "ready?" },
      new Uint8Array([1]),
      new AbortController().signal,
    )
    .catch((cause: unknown) => cause);
  expect(failure).toBeInstanceOf(ProviderCleanupError);
  expect(projectAnalysisError(failure as ProviderCleanupError)).toMatchObject({
    details: {
      diagnostics: {
        completed_judge_result: {
          id: "x",
          passed: true,
          description: "observed",
        },
      },
    },
  });
  expect(await judge.close()).toMatchObject({ verified: true });
});

it("waits for final process cleanup after cancellation and keeps its owner", async () => {
  const controller = new AbortController();
  const reason = new Error("cancel during cleanup");
  const owner = {
    stop: vi.fn().mockResolvedValue({
      status: "terminated",
    } satisfies ProviderProcessStopResult),
    dispose: vi.fn(),
  } as unknown as ProviderProcessSupervisor;
  let rejectCommand: (cause: unknown) => void = () => {};
  vi.mocked(runOwnedCommand).mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        rejectCommand = reject;
      }),
  );
  const judge = new ScreenJudgeProcess({});
  let settled = false;
  const running = judge
    .judge(
      "/verifier",
      { id: "x", kind: "screen_judge", question: "ready?" },
      new Uint8Array([1]),
      controller.signal,
    )
    .catch((cause: unknown) => cause)
    .finally(() => {
      settled = true;
    });
  // Wait for the mocked command to receive control, not just for the judge to start.
  await waitFor(() =>
    expect(vi.mocked(runOwnedCommand).mock.calls.at(-1)?.[2]?.signal).toBe(
      controller.signal,
    ),
  );
  controller.abort(reason);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);
  rejectCommand(
    new OwnedCommandFailure(
      "cancelled",
      "cancelled",
      null,
      "still running",
      { cancellation: { reason } },
      ["run"],
      owner,
    ),
  );
  const failure = await running;
  expect(failure).toBeInstanceOf(ProviderCleanupError);
  expect((failure as ProviderCleanupError).cleanupPrimary?.cause).toBe(reason);
  expect(await judge.close()).toMatchObject({ verified: true });
});

it("keeps a completed answer when cancellation arrives during successful cleanup", async () => {
  const text = JSON.stringify({
    id: "x",
    result: true,
    description: "completed",
  });
  const snapshot = {
    exitCode: 0,
    stdout: {
      text,
      bytes: Buffer.byteLength(text),
      observedBytes: Buffer.byteLength(text),
    },
    stderr: { text: "", bytes: 0, observedBytes: 0 },
    signal: null,
  };
  const reason = new Error("cancel during cleanup");
  vi.mocked(runOwnedCommand).mockRejectedValueOnce(
    new OwnedCommandFailure("cancelled", "cancelled", snapshot, null, {
      cancellation: { reason },
    }),
  );
  const judge = new ScreenJudgeProcess({});
  const failure: unknown = await judge
    .judge(
      "/verifier",
      { id: "x", kind: "screen_judge", question: "ready?" },
      new Uint8Array([1]),
      new AbortController().signal,
    )
    .catch((cause: unknown) => cause);
  expect(
    projectAnalysisError(
      failure as import("../domain/analysisErrorBase.js").AnalysisError,
    ),
  ).toMatchObject({
    code: "cancelled",
    details: {
      diagnostics: {
        completed_judge_result: {
          id: "x",
          passed: true,
          description: "completed",
        },
      },
    },
  });
  expect((failure as Error).cause).toBe(reason);
  expect(await judge.close()).toMatchObject({ verified: true });
});
