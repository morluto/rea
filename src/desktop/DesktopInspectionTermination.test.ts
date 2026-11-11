import { EventEmitter } from "node:events";
import { expect, it, onTestFinished, vi } from "vitest";
import { failedInspectionDescriptor } from "../../tests/fixtures/processInspectionCleanup.js";

vi.mock("../process/ProviderProcess.js", async (original) => ({
  ...(await original<typeof import("../process/ProviderProcess.js")>()),
  spawnOwnedProviderProcess: vi.fn(),
}));
vi.mock("./DesktopSessionObservations.js", async (original) => ({
  ...(await original<typeof import("./DesktopSessionObservations.js")>()),
  // Initial sampling is independent of the real termination/inspection route under test.
  trackProcess: vi.fn(async () => {}),
}));

import { spawnOwnedProviderProcess } from "../process/ProviderProcess.js";
import { systemProcessOwnershipHost } from "../process/ProcessOwnershipObservation.js";
import { runDesktopSession } from "./DesktopApplicationSession.js";
import type { X11WindowObserver } from "./X11WindowObserver.js";

it
  .skipIf(process.platform !== "linux" && process.platform !== "darwin")
  .each(["initial", "poll"] as const)(
  "transfers the actual %s termination descriptor to the session cleanup lease without repeating delivered SIGTERM",
  async (phase) => {
    const file = await failedInspectionDescriptor();
    const child = Object.assign(new EventEmitter(), {
      pid: 42,
      stdout: null,
      stderr: null,
      exitCode: null as number | null,
      signalCode: null,
      kill: vi.fn((_signal?: NodeJS.Signals | number) => true),
    });
    const closeChild = () => {
      if (child.exitCode !== null) return;
      child.exitCode = 0;
      child.emit("exit", 0, null);
      child.emit("close", 0, null);
    };
    child.kill.mockImplementation(() => {
      closeChild();
      return true;
    });
    const cleanup = vi.fn(async () => {
      closeChild();
      return { cleaned: true as const, signaled: false };
    });
    let runId = "";
    vi.mocked(spawnOwnedProviderProcess).mockImplementation(async (input) => {
      runId = input.runId;
      return {
        process: child,
        ownership: {
          runId,
          leaderPid: 42,
          processGroupId: 42,
          expectedParentPid: 1,
        },
        cleanup,
      };
    });
    onTestFinished(() => {
      vi.restoreAllMocks();
      vi.mocked(spawnOwnedProviderProcess).mockReset();
    });
    vi.spyOn(systemProcessOwnershipHost, "prepare").mockRejectedValue(
      new Error("Unexpected native preparation"),
    );
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("Unexpected native PID/group signal");
    });
    const rows = [
      {
        pid: 42,
        parentPid: 1,
        processGroupId: 42,
        state: "S",
        command: "fixture",
      },
    ];
    vi.spyOn(systemProcessOwnershipHost, "listProcesses").mockResolvedValue(
      rows,
    );
    vi.spyOn(systemProcessOwnershipHost, "environment").mockImplementation(
      async () => ({ REA_PROCESS_RUN_ID: runId }),
    );
    vi.spyOn(systemProcessOwnershipHost, "runTokens").mockImplementation(
      async () => new Map([[42, { state: "readable", runId }]]),
    );
    const groupSignal = vi
      .spyOn(systemProcessOwnershipHost, "signalGroup")
      .mockImplementation(() => {});
    vi.spyOn(
      systemProcessOwnershipHost,
      "processIdentities",
    ).mockImplementation(async () => {
      if (phase === "initial" || groupSignal.mock.calls.length > 0)
        throw file.failure;
      return new Map([
        [
          42,
          {
            state: "readable",
            identity: "fixture:42",
            lifecycle: { state: "observed", lifecycle: "non-zombie" },
            relation: { state: "observed", parentPid: 1, processGroupId: 42 },
          },
        ],
      ]);
    });
    const outcome = await runDesktopSession({
      argv: ["authored-recording-child"],
      workingDirectory: "fixture",
      environment: {},
      windows: {
        sample: async () => {
          throw new Error("Unexpected window inspection");
        },
      } as unknown as X11WindowObserver,
      windowMatching: { names: new Set(), byPid: true },
      roots: [],
      maxDurationMs: 10_000,
      pollIntervalMs: 1,
      nextRequest: () => ({ kind: "stop" }),
      checkpoint: async () => {},
      report: async () => {},
      signal: undefined,
    });
    expect(outcome.session.cleanup.verified).toBe(false);
    expect(outcome.unreleased?.leases).toHaveLength(1);
    expect(file.handle.fd).toBeGreaterThanOrEqual(0);
    expect(cleanup).not.toHaveBeenCalled();
    expect(child.kill.mock.calls).toEqual(
      phase === "initial" ? [["SIGTERM"]] : [],
    );
    expect(groupSignal.mock.calls).toEqual(
      phase === "poll" ? [[42, "SIGTERM"]] : [],
    );
    file.allow();
    await outcome.unreleased!.leases[0]!.release();
    expect(file.handle.fd).toBe(-1);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(outcome.unreleased!.leases[0]!.released).toBe(true);
    expect(child.kill.mock.calls).toEqual(
      phase === "initial" ? [["SIGTERM"]] : [],
    );
    expect(groupSignal.mock.calls).toEqual(
      phase === "poll" ? [[42, "SIGTERM"]] : [],
    );
  },
);
