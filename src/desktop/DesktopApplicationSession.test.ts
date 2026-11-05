import { readdir } from "node:fs/promises";
import { join } from "node:path";

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

/** A plan that launches `script` with sh and never sends a request. */
const shellPlan = (
  root: string,
  script: string,
  windows: X11WindowObserver = noWindows,
): DesktopSessionPlan => ({
  argv: ["/bin/sh", "-c", script],
  workingDirectory: root,
  environment: { PATH: "/usr/bin:/bin" },
  windows,
  windowMatching: { names: new Set(), byPid: true },
  roots: [],
  maxDurationMs: 20_000,
  pollIntervalMs: 50,
  nextRequest: () => undefined,
  checkpoint: async () => {},
  report: async () => {},
  signal: undefined,
});

describe.skipIf(process.platform !== "linux")("runDesktopSession", () => {
  it("releases the application once when the exit checkpoint fails after release", async () => {
    const root = await createTestTempDirectory("desktop-session-");
    const failure = new Error("exit checkpoint failed");
    const checkpoints: string[] = [];
    const plan: DesktopSessionPlan = {
      ...shellPlan(root, "trap 'exit 0' TERM; while :; do sleep 0.1; done"),
      nextRequest: () => ({ kind: "stop" }),
      checkpoint: async (name) => {
        checkpoints.push(name);
        if (name === "exit") throw failure;
      },
    };

    await expect(runDesktopSession(plan)).rejects.toBe(failure);
    expect(checkpoints).toEqual(["stop", "exit"]);
    expect(vi.mocked(terminateTokenOwnedProcesses)).toHaveBeenCalledTimes(1);
  }, 30_000);
});

describe.skipIf(process.platform !== "linux")(
  "runDesktopSession natural exit",
  () => {
    it("keeps watching a worker whose launcher exited before it was sampled", async () => {
      const root = await createTestTempDirectory("desktop-session-worker-");
      // The middle shell exits at once, so no parent link reaches the worker.
      const outcome = await runDesktopSession(
        shellPlan(
          root,
          `( (sleep 1; touch "${join(root, "done")}") & ); exit 0`,
        ),
      );

      expect(outcome.session.end_reason).toBe("application_exited");
      expect(await readdir(root)).toContain("done");
      expect(
        outcome.session.processes.filter(
          (entry) =>
            entry.started_by_capture &&
            entry.pid !== outcome.session.launch_pid,
        ).length,
      ).toBeGreaterThan(0);
    }, 30_000);

    it("does not take samples whose window list was unreadable as the application having exited", async () => {
      const root = await createTestTempDirectory("desktop-session-unread-");
      let samples = 0;
      const windows = {
        sample: async () => {
          samples += 1;
          return samples <= 4
            ? { state: "display_unreadable" }
            : { state: "listed", windows: [] };
        },
      } as unknown as X11WindowObserver;

      const outcome = await runDesktopSession(
        shellPlan(root, "exit 0", windows),
      );

      expect(outcome.session.end_reason).toBe("application_exited");
      expect(outcome.unreadableWindowSamples).toBe(4);
      expect(samples).toBeGreaterThanOrEqual(6);
    }, 30_000);
  },
);
