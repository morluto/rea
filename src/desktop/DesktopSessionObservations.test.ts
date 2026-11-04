import { describe, expect, it } from "vitest";

import type { ProcessLifecycle } from "../process/ProcessLifecycle.js";
import {
  SessionObservations,
  observedSession,
  recordWindows,
  sampleProcesses,
  trackProcess,
  type SessionProcfs,
} from "./DesktopSessionObservations.js";
import type { ObservedWindow } from "./X11WindowObserver.js";

interface FakeProcess {
  readonly parentPid: number;
  readonly startTime: string;
  /** Undefined models a zombie or a process whose environment is unreadable. */
  readonly runId?: string;
  readonly lifecycle?: ProcessLifecycle;
}

const procfs = (table: Map<number, FakeProcess>): SessionProcfs => ({
  stat: async (pid) => {
    const entry = table.get(pid);
    return entry === undefined
      ? undefined
      : {
          parentPid: entry.parentPid,
          startTime: entry.startTime,
          lifecycle: entry.lifecycle ?? "non-zombie",
        };
  },
  children: async (pid) =>
    [...table]
      .filter(([, entry]) => entry.parentPid === pid)
      .map(([child]) => child),
  runId: async (pid) => table.get(pid)?.runId,
  command: async (pid) => `process ${String(pid)}`,
});

const window = (
  id: string,
  pid: number,
  class_: string | null,
): ObservedWindow => ({
  id,
  pid,
  class: class_,
  instance: class_?.toLowerCase() ?? null,
  title: null,
  window_type: "normal",
});

const observe = (table: Map<number, FakeProcess>, byPid = true) =>
  new SessionObservations(
    performance.now(),
    { runId: "run", launchPid: 100 },
    { names: new Set(["notes"]), byPid },
    procfs(table),
  );

const startedBy = (observations: SessionObservations) =>
  Object.fromEntries(
    observedSession(observations).processes.map((entry) => [
      entry.pid,
      entry.started_by_capture,
    ]),
  );

const signal = new AbortController().signal;

describe("SessionObservations", () => {
  it("counts a process as started when its parent chain reaches the launch, even without a readable token", async () => {
    const table = new Map<number, FakeProcess>([
      [100, { parentPid: 1, startTime: "10", runId: "run" }],
      [101, { parentPid: 100, startTime: "11" }],
      [150, { parentPid: 100, startTime: "15" }],
      [201, { parentPid: 150, startTime: "20" }],
      [300, { parentPid: 1, startTime: "30" }],
    ]);
    const observations = observe(table);

    await trackProcess(observations, 100, signal);
    await recordWindows(
      observations,
      [window("0x1", 201, "Notes"), window("0x2", 300, "Notes")],
      signal,
    );
    await sampleProcesses(observations, signal);

    expect(startedBy(observations)).toEqual({
      100: true,
      101: true,
      150: true,
      201: true,
      300: false,
    });
  });

  it("records the launched process as started after it has already exited", async () => {
    const observations = observe(new Map());

    await trackProcess(observations, 100, signal);

    expect(observedSession(observations).processes).toEqual([
      expect.objectContaining({
        pid: 100,
        parent_pid: process.pid,
        started_by_capture: true,
      }),
    ]);
    expect(observations.liveProcessIds()).toEqual([]);
  });

  it("treats a reused pid as a different process", async () => {
    const table = new Map<number, FakeProcess>([
      [100, { parentPid: 1, startTime: "10", runId: "run" }],
      [101, { parentPid: 100, startTime: "11", runId: "run" }],
    ]);
    const observations = observe(table);
    await trackProcess(observations, 100, signal);
    await sampleProcesses(observations, signal);
    expect(observations.belongs(window("0x3", 101, "Other"))).toBe(true);

    table.set(101, { parentPid: 1, startTime: "99" });
    await sampleProcesses(observations, signal);

    expect(observations.liveProcessIds()).toEqual([100]);
    expect(observations.belongs(window("0x3", 101, "Other"))).toBe(false);
    await recordWindows(observations, [window("0x4", 101, "Notes")], signal);
    expect(
      observedSession(observations).processes.map((entry) => [
        entry.pid,
        entry.started_by_capture,
      ]),
    ).toEqual([
      [100, true],
      [101, true],
      [101, false],
    ]);
  });

  it("does not keep a zombie child alive, whether first seen as one or exiting later", async () => {
    const table = new Map<number, FakeProcess>([
      [100, { parentPid: 1, startTime: "10", runId: "run" }],
      [101, { parentPid: 100, startTime: "11", lifecycle: "zombie" }],
      [102, { parentPid: 100, startTime: "12" }],
    ]);
    const observations = observe(table);
    await trackProcess(observations, 100, signal);
    await sampleProcesses(observations, signal);
    await sampleProcesses(observations, signal);
    expect(observations.liveProcessIds(true)).toEqual([100, 102]);

    table.delete(100);
    table.set(102, { parentPid: 1, startTime: "12", lifecycle: "zombie" });
    await sampleProcesses(observations, signal);
    await recordWindows(observations, [window("0x7", 102, "Other")], signal);

    expect(observations.liveProcessIds(true)).toEqual([]);
    expect(startedBy(observations)).toEqual({
      100: true,
      101: true,
      102: true,
    });
    expect(observedSession(observations).processes).toHaveLength(3);
  });

  it("matches windows by name only when their pids are sandbox pids", async () => {
    const table = new Map<number, FakeProcess>([
      [100, { parentPid: 1, startTime: "10", runId: "run" }],
      [2, { parentPid: 1, startTime: "2" }],
    ]);
    const observations = observe(table, false);
    await trackProcess(observations, 100, signal);

    expect(observations.belongs(window("0x5", 100, "Other"))).toBe(false);
    expect(
      await recordWindows(observations, [window("0x6", 2, "Notes")], signal),
    ).toBe(1);
    expect(
      observedSession(observations).processes.map(({ pid }) => pid),
    ).toEqual([100]);
  });
});
