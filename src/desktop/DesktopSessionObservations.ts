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
import type { ProcessLifecycle } from "../process/ProcessLifecycle.js";
import {
  processInspectionCleanupFailures,
  processInspectionCancellations,
} from "../process/ProcessInspectionCleanup.js";
import { readProcessRunId } from "../process/ProcessOwnership.js";
import { systemProcessOwnershipHost } from "../process/ProcessOwnershipObservation.js";
import { readRunTokenCarriers } from "../process/ProcessRunTokenObservations.js";
import type { ObservedWindow } from "./X11WindowObserver.js";

const COMMAND_TEXT_LIMIT = 512;
/** Parent links followed when deciding whether the capture started a process. */
const ANCESTOR_LIMIT = 64;

type TrackedProcess = Omit<DesktopProcess, "started_by_capture"> & {
  alive: boolean;
  readonly started: boolean;
  /** Kernel start time; the same pid with another start time is another process. */
  readonly startTime: string | undefined;
};

/** How a window is recognised as the application's. */
export interface WindowMatching {
  /** Class or instance names, lowercase. */
  readonly names: ReadonlySet<string>;
  /** False when window pids live in another pid namespace, as in a flatpak sandbox. */
  readonly byPid: boolean;
}

/** One process's stat facts, or undefined when the process is gone. */
type ProcessStat =
  | {
      readonly parentPid: number;
      readonly startTime: string;
      readonly lifecycle: ProcessLifecycle | undefined;
    }
  | undefined;

/** The procfs reads that follow the application's processes; replaceable in tests. */
export interface SessionProcfs {
  stat(pid: number, signal: AbortSignal): Promise<ProcessStat>;
  children(pid: number, signal: AbortSignal): Promise<readonly number[]>;
  /** The run token in the environment, undefined when absent or unreadable. */
  runId(pid: number, signal: AbortSignal): Promise<string | undefined>;
  command(pid: number): Promise<string>;
  /** Live processes carrying the run token, undefined when the process table is unreadable. */
  tokenCarriers(
    runId: string,
    signal: AbortSignal,
  ): Promise<readonly number[] | undefined>;
}

/** A zombie keeps its stat record until reaped, but it no longer runs. */
const running = (stat: ProcessStat): stat is NonNullable<ProcessStat> =>
  stat !== undefined &&
  stat.lifecycle !== "zombie" &&
  stat.lifecycle !== "dead";

/** Optional observations stay unknown unless the producer transfers failure facts or cleanup. */
const optionalInspectionFailure = (cause: unknown): undefined => {
  if (
    processInspectionCleanupFailures(cause).length > 0 ||
    processInspectionCancellations(cause).length > 0
  )
    throw cause;
  return undefined;
};

const systemProcfs: SessionProcfs = {
  async stat(pid, signal) {
    const stat = (await readLinuxProcessStat(pid, signal)).value;
    return stat?.startTime === undefined
      ? undefined
      : {
          parentPid: stat.parent_pid,
          startTime: stat.startTime,
          lifecycle: stat.lifecycle,
        };
  },
  async children(pid, signal) {
    return (await readLinuxChildren(pid, signal)).value ?? [];
  },
  runId: (pid, signal) =>
    readProcessRunId(pid, undefined, signal).catch(optionalInspectionFailure),
  async command(pid) {
    const text = await readFile(`/proc/${String(pid)}/cmdline`, "utf8").catch(
      () => "",
    );
    return text.replaceAll("\0", " ").trim().slice(0, COMMAND_TEXT_LIMIT);
  },
  tokenCarriers: (runId, signal) =>
    readRunTokenCarriers(systemProcessOwnershipHost, runId, signal).then(
      (carriers) => carriers.map(({ pid }) => pid),
      optionalInspectionFailure,
    ),
};

/** Whether a window's class or instance names the application. */
export const matchesWindowNames = (
  window: Pick<ObservedWindow, "class" | "instance">,
  names: ReadonlySet<string>,
): boolean =>
  (window.class !== null && names.has(window.class.toLowerCase())) ||
  (window.instance !== null && names.has(window.instance.toLowerCase()));

/** Mutable observations folded into the session record at the end. */
export class SessionObservations {
  /** Every process generation seen, in discovery order. */
  readonly #processes: TrackedProcess[] = [];
  /** The latest generation seen under each pid. */
  readonly #byPid = new Map<number, TrackedProcess>();
  readonly windows = new Map<string, DesktopWindow & { titles: string[] }>();
  readonly openedFiles = new Map<string, number>();
  firstWindowMs: number | null = null;
  announced = false;
  /** Samples whose window list could not be read, so their windows are unknown. */
  unreadableWindowSamples = 0;

  constructor(
    readonly startedAt: number,
    readonly run: { readonly runId: string; readonly launchPid: number },
    readonly matching: WindowMatching,
    readonly procfs: SessionProcfs = systemProcfs,
  ) {}

  now(): number {
    return Math.max(0, Math.round(performance.now() - this.startedAt));
  }

  get processes(): readonly TrackedProcess[] {
    return this.#processes;
  }

  /** The latest generation recorded under a pid. */
  tracked(pid: number): TrackedProcess | undefined {
    return this.#byPid.get(pid);
  }

  record(entry: TrackedProcess): void {
    this.#processes.push(entry);
    this.#byPid.set(entry.pid, entry);
  }

  /** Live processes; with `startedOnly`, only those the capture started. */
  liveProcessIds(startedOnly = false): readonly number[] {
    return [...this.#byPid.values()]
      .filter((entry) => entry.alive && (entry.started || !startedOnly))
      .map((entry) => entry.pid);
  }

  /** A window is the application's by live owner pid or by class name. */
  belongs(window: Pick<ObservedWindow, "pid" | "class" | "instance">): boolean {
    return (
      (this.matching.byPid &&
        window.pid !== null &&
        this.tracked(window.pid)?.alive === true) ||
      matchesWindowNames(window, this.matching.names)
    );
  }
}

/**
 * Whether the parent chain reaches a live process the capture started. Each
 * link is read again, so a reused pid does not count as its earlier process.
 */
const startedByAncestor = async (
  observations: SessionObservations,
  parentPid: number,
  signal: AbortSignal,
): Promise<boolean> => {
  let pid = parentPid;
  for (let depth = 0; depth < ANCESTOR_LIMIT && pid > 1; depth += 1) {
    const stat = await observations.procfs.stat(pid, signal);
    if (stat === undefined) return false;
    const known = observations.tracked(pid);
    if (
      known?.alive === true &&
      known.started &&
      known.startTime === stat.startTime
    )
      return true;
    pid = stat.parentPid;
  }
  return false;
};

/**
 * Record a process generation once. It counts as started by the capture when
 * it is the launched process, carries the run token, or descends from a
 * process the capture started; a zombie or sandboxed process whose
 * environment cannot be read is still recognised by its parents. A zombie is
 * recorded as exited, so it cannot keep the session open.
 */
export const trackProcess = async (
  observations: SessionObservations,
  pid: number,
  signal: AbortSignal,
): Promise<void> => {
  const { procfs } = observations;
  const stat = await procfs.stat(pid, signal);
  const known = observations.tracked(pid);
  if (known !== undefined && stat?.startTime === known.startTime) {
    known.alive = running(stat);
    return;
  }
  if (known !== undefined) known.alive = false;
  // Only the first generation under the launched pid is the launched process.
  const launched = pid === observations.run.launchPid && known === undefined;
  if (stat === undefined && !launched) return;
  const at = observations.now();
  const parentPid = stat?.parentPid ?? (launched ? process.pid : 0);
  const runId = await procfs.runId(pid, signal);
  observations.record({
    pid,
    parent_pid: parentPid,
    command: await procfs.command(pid),
    first_seen_ms: at,
    last_seen_ms: at,
    alive: running(stat),
    started:
      launched ||
      runId === observations.run.runId ||
      (await startedByAncestor(observations, parentPid, signal)),
    startTime: stat?.startTime,
  });
};

/** Refresh liveness and add children of every live process. */
export const sampleProcesses = async (
  observations: SessionObservations,
  signal: AbortSignal,
): Promise<void> => {
  for (const pid of observations.liveProcessIds()) {
    const entry = observations.tracked(pid);
    if (entry === undefined) continue;
    const stat = await observations.procfs.stat(pid, signal);
    if (!running(stat) || stat.startTime !== entry.startTime) {
      entry.alive = false;
      continue;
    }
    entry.last_seen_ms = observations.now();
    for (const child of await observations.procfs.children(pid, signal))
      await trackProcess(observations, child, signal);
  }
};

/**
 * Track live run-token carriers that no parent link reached, such as a worker
 * whose launcher exited before a sample. False when the process table could
 * not be read, so whether any carrier remains is unknown.
 */
export const sampleTokenCarriers = async (
  observations: SessionObservations,
  signal: AbortSignal,
): Promise<boolean> => {
  const carriers = await observations.procfs.tokenCarriers(
    observations.run.runId,
    signal,
  );
  if (carriers === undefined) return false;
  for (const pid of carriers) await trackProcess(observations, pid, signal);
  return true;
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
    const nameMatches = matchesWindowNames(window, observations.matching.names);
    let belongs = nameMatches;
    if (window.pid !== null && observations.matching.byPid) {
      if (nameMatches) {
        await trackProcess(observations, window.pid, signal);
      } else {
        const known = observations.tracked(window.pid);
        if (known?.alive === true) {
          const stat = await observations.procfs.stat(window.pid, signal);
          known.alive = running(stat) && stat.startTime === known.startTime;
          belongs = known.alive;
        }
      }
    }
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
    processes: observations.processes.map(
      ({ alive: _alive, started, startTime: _startTime, ...entry }) => ({
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
