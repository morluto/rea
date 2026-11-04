import { readdir, readFile, readlink } from "node:fs/promises";

import type {
  DesktopProcess,
  DesktopSession,
  DesktopWindow,
} from "../domain/desktop/desktopCapture.js";
import { isWithinAny } from "../domain/desktop/desktopStateDiff.js";
import {
  readLinuxChildren,
  readLinuxProcessStat,
} from "../process/capture/LinuxProcessSampling.js";
import { readProcessRunId } from "../process/ProcessOwnership.js";
import type { ObservedWindow } from "./X11WindowObserver.js";

const COMMAND_TEXT_LIMIT = 512;

type TrackedProcess = Omit<DesktopProcess, "started_by_capture"> & {
  alive: boolean;
  started: boolean;
};

/** Mutable observations folded into the session record at the end. */
export class SessionObservations {
  readonly processes = new Map<number, TrackedProcess>();
  readonly windows = new Map<string, DesktopWindow & { titles: string[] }>();
  readonly openedFiles = new Map<string, number>();
  firstWindowMs: number | null = null;
  announced = false;

  constructor(
    readonly startedAt: number,
    readonly runId: string,
    readonly windowNames: ReadonlySet<string>,
  ) {}

  now(): number {
    return Math.max(0, Math.round(performance.now() - this.startedAt));
  }

  /** Live processes; with `startedOnly`, only those carrying the run token. */
  liveProcessIds(startedOnly = false): readonly number[] {
    return [...this.processes.values()]
      .filter((entry) => entry.alive && (entry.started || !startedOnly))
      .map((entry) => entry.pid);
  }

  /** A window is the application's by owner pid or by class name. */
  belongs(window: Pick<ObservedWindow, "pid" | "class" | "instance">): boolean {
    return (
      (window.pid !== null && this.processes.has(window.pid)) ||
      (window.class !== null &&
        this.windowNames.has(window.class.toLowerCase())) ||
      (window.instance !== null &&
        this.windowNames.has(window.instance.toLowerCase()))
    );
  }
}

const processCommand = async (pid: number): Promise<string> => {
  const text = await readFile(`/proc/${String(pid)}/cmdline`, "utf8").catch(
    () => "",
  );
  return text.replaceAll("\0", " ").trim().slice(0, COMMAND_TEXT_LIMIT);
};

/** Record a process once; it counts as started when it carries the run token. */
export const trackProcess = async (
  observations: SessionObservations,
  pid: number,
  parentPid: number,
  signal: AbortSignal,
): Promise<void> => {
  if (observations.processes.has(pid)) return;
  const at = observations.now();
  const runId = await readProcessRunId(pid, undefined, signal).catch(
    () => undefined,
  );
  observations.processes.set(pid, {
    pid,
    parent_pid: parentPid,
    command: await processCommand(pid),
    first_seen_ms: at,
    last_seen_ms: at,
    alive: true,
    started: runId === observations.runId,
  });
};

/** Refresh liveness and add children of every live process. */
export const sampleProcesses = async (
  observations: SessionObservations,
  signal: AbortSignal,
): Promise<void> => {
  for (const pid of observations.liveProcessIds()) {
    const entry = observations.processes.get(pid);
    if (entry === undefined) continue;
    const stat = await readLinuxProcessStat(pid, signal);
    if (stat.value === undefined) {
      entry.alive = false;
      continue;
    }
    entry.last_seen_ms = observations.now();
    const children = await readLinuxChildren(pid, signal);
    for (const child of children.value ?? [])
      await trackProcess(observations, child, pid, signal);
  }
};

/** Record files under the walked roots that live processes hold open. */
export const sampleOpenFiles = async (
  observations: SessionObservations,
  roots: readonly string[],
): Promise<void> => {
  for (const pid of observations.liveProcessIds()) {
    const descriptors = await readdir(`/proc/${String(pid)}/fd`).catch(
      () => [] as string[],
    );
    for (const descriptor of descriptors) {
      const target = await readlink(
        `/proc/${String(pid)}/fd/${descriptor}`,
      ).catch(() => undefined);
      if (target === undefined || !target.startsWith("/")) continue;
      const path = target.replace(/ \(deleted\)$/u, "");
      if (isWithinAny(path, roots) && !observations.openedFiles.has(path))
        observations.openedFiles.set(path, observations.now());
    }
  }
};

/**
 * Fold one window sample into the record and return how many windows belong
 * to the application. Ownership is re-evaluated every sample, because a
 * window can appear before its owning process is discovered.
 */
export const recordWindows = async (
  observations: SessionObservations,
  windows: readonly ObservedWindow[],
  signal: AbortSignal,
): Promise<number> => {
  let application = 0;
  const at = observations.now();
  for (const window of windows) {
    const belongs = observations.belongs(window);
    if (belongs && window.pid !== null)
      await trackProcess(observations, window.pid, 0, signal);
    const record = observations.windows.get(window.id) ?? {
      id: window.id,
      instance: window.instance,
      class: window.class,
      titles: [],
      pid: window.pid,
      window_type: window.window_type,
      application: false,
      first_seen_ms: at,
      last_seen_ms: at,
    };
    observations.windows.set(window.id, record);
    Object.assign(record, {
      instance: window.instance,
      class: window.class,
      pid: window.pid,
      window_type: window.window_type,
      application: record.application || belongs,
      last_seen_ms: at,
    });
    if (window.title !== null && record.titles.at(-1) !== window.title)
      record.titles.push(window.title);
    if (!belongs) continue;
    application += 1;
    if (
      observations.firstWindowMs === null ||
      record.first_seen_ms < observations.firstWindowMs
    )
      observations.firstWindowMs = record.first_seen_ms;
  }
  return application;
};

const windowMatch = (
  windows: readonly DesktopWindow[],
): DesktopSession["window_match"] => {
  const counts = new Map<string, number>();
  for (const window of windows)
    if (
      window.application &&
      window.class !== null &&
      window.instance !== null
    ) {
      const key = JSON.stringify([window.class, window.instance]);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  const [best] = [...counts.entries()].sort(
    (left, right) => right[1] - left[1],
  );
  if (best === undefined) return null;
  const [class_, instance] = JSON.parse(best[0]) as [string, string];
  return { class: class_, instance };
};

/** The parts of the session record the observations own. */
export const observedSession = (
  observations: SessionObservations,
): Pick<
  DesktopSession,
  "first_window_ms" | "window_match" | "processes" | "windows" | "opened_files"
> => {
  const windows = [...observations.windows.values()];
  return {
    first_window_ms: observations.firstWindowMs,
    window_match: windowMatch(windows),
    processes: [...observations.processes.values()].map(
      ({ alive: _alive, started, ...entry }) => ({
        ...entry,
        started_by_capture: started,
      }),
    ),
    windows,
    opened_files: [...observations.openedFiles].map(
      ([path, first_seen_ms]) => ({ path, first_seen_ms }),
    ),
  };
};
