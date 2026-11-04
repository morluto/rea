import { describe, expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { terminateTokenOwnedProcesses } from "../process/TokenOwnedTermination.js";
import {
  runDesktopSession,
  type DesktopSessionPlan,
} from "./DesktopApplicationSession.js";
import type { X11WindowObserver } from "./X11WindowObserver.js";

vi.mock("../process/TokenOwnedTermination.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../process/TokenOwnedTermination.js")
    >();
  return {
    ...actual,
    terminateTokenOwnedProcesses: vi.fn(actual.terminateTokenOwnedProcesses),
  };
});

const noWindows = {
  sample: async () => ({ state: "listed", windows: [] }),
} as unknown as X11WindowObserver;

describe.skipIf(process.platform !== "linux")("runDesktopSession", () => {
  it("releases the application once when the exit checkpoint fails after release", async () => {
    const root = await createTestTempDirectory("desktop-session-");
    const failure = new Error("exit checkpoint failed");
    const checkpoints: string[] = [];
    const plan: DesktopSessionPlan = {
      argv: [
        "/bin/sh",
        "-c",
        "trap 'exit 0' TERM; while :; do sleep 0.1; done",
      ],
      workingDirectory: root,
      environment: { PATH: "/usr/bin:/bin" },
      windows: noWindows,
      windowMatching: { names: new Set(), byPid: true },
      roots: [],
      maxDurationMs: 20_000,
      pollIntervalMs: 50,
      nextRequest: () => ({ kind: "stop" }),
      checkpoint: async (name) => {
        checkpoints.push(name);
        if (name === "exit") throw failure;
      },
      report: async () => {},
      signal: undefined,
    };

    await expect(runDesktopSession(plan)).rejects.toBe(failure);
    expect(checkpoints).toEqual(["stop", "exit"]);
    expect(vi.mocked(terminateTokenOwnedProcesses)).toHaveBeenCalledTimes(1);
  }, 30_000);
});
