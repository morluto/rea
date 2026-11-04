import { spawn, type ChildProcess } from "node:child_process";
import { readdir, readFile, readlink } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

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
import type { ObservedWindow, X11WindowObserver } from "./X11WindowObserver.js";

const STDERR_TAIL_BYTES = 8 * 1024;
const COMMAND_TEXT_LIMIT = 512;
const TERMINATION_GRACE_MS = 5_000;

/** A line the person or driver sent while the session runs. */
export type SessionRequest =
  | { readonly kind: "checkpoint"; readonly name: string | undefined }
  | { readonly kind: "stop" };

/** Everything the session loop needs from its caller. */
export interface DesktopSessionPlan {
  readonly argv: readonly string[];
  readonly workingDirectory: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly windows: X11WindowObserver;
  /** Window class or instance names that identify the application, lowercase. */
  readonly windowNames: ReadonlySet<string>;
  readonly roots: readonly string[];
  readonly maxDurationMs: number;
  readonly pollIntervalMs: number;
  readonly nextRequest: () => SessionRequest | undefined;
  readonly checkpoint: (
    name: string,
    trigger: "request" | "stop" | "exit",
    atMs: number,
    openedFiles: ReadonlySet<string>,
  ) => Promise<void>;
  readonly report: (message: string) => Promise<void>;
  readonly signal: AbortSignal | undefined;
}

interface TrackedWindow {
  readonly window: DesktopWindow & { titles: string[] };
  lastSeen: number;
}

/** Mutable observations folded into the session record at the end. */
class SessionObservations {
  /** `started` marks processes in the launched tree; only those are signalled. */
  readonly processes = new Map<
    number,
    Omit<DesktopProcess, "started_by_capture"> & {
      alive: boolean;
      started: boolean;
    }
  >();
  readonly windows = new Map<string, TrackedWindow>();
  readonly openedFiles = new Map<string, number>();
  firstWindowMs: number | null = null;
  announced = false;

  constructor(readonly startedAt: number) {}

  now(): number {
    return Math.max(0, Math.round(performance.now() - this.startedAt));
  }

  liveProcessIds(startedOnly = false): readonly number[] {
    return [...this.processes.values()]
      .filter((entry) => entry.alive && (entry.started || !startedOnly))
      .map((entry) => entry.pid);
  }
}

const processCommand = async (pid: number): Promise<string> => {
  const text = await readFile(`/proc/${String(pid)}/cmdline`, "utf8").catch(
    () => "",
  );
  return text.replaceAll("\0", " ").trim().slice(0, COMMAND_TEXT_LIMIT);
};

const track = async (
  observations: SessionObservations,
  pid: number,
  parentPid: number,
  started: boolean,
) => {
  if (observations.processes.has(pid)) return;
  const at = observations.now();
  observations.processes.set(pid, {
    pid,
    parent_pid: parentPid,
    command: await processCommand(pid),
    first_seen_ms: at,
    last_seen_ms: at,
    alive: true,
    started,
  });
};

const sampleProcesses = async (
  observations: SessionObservations,
  signal: AbortSignal,
) => {
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
      await track(observations, child, pid, entry.started);
  }
};

const sampleOpenFiles = async (
  observations: SessionObservations,
  roots: readonly string[],
) => {
  for (const pid of observations.liveProcessIds()) {
    const descriptors = await readdir(`/proc/${String(pid)}/fd`).catch(
      () => [] as string[],
    );
    for (const descriptor of descriptors) {
      const target = await readlink(
        `/proc/${String(pid)}/fd/${descriptor}`,
      ).catch(() => undefined);
      if (
        target === undefined ||
        !target.startsWith("/") ||
        !isWithinAny(target, roots)
      )
        continue;
      const path = target.replace(/ \(deleted\)$/u, "");
      if (!observations.openedFiles.has(path))
        observations.openedFiles.set(path, observations.now());
    }
  }
};

/**
 * Windows that already match the application before it is launched. A capture
 * refuses to start beside them: the launch could hand off to that instance,
 * and its unsaved state would sit outside the baseline.
 */
export const runningApplicationWindows = async (
  windows: X11WindowObserver,
  names: ReadonlySet<string>,
  signal?: AbortSignal,
): Promise<readonly ObservedWindow[]> => {
  const observations = new SessionObservations(performance.now());
  return ((await windows.sample(() => false, signal)) ?? []).filter((window) =>
    isApplicationWindow(observations, names, window),
  );
};

const isApplicationWindow = (
  observations: SessionObservations,
  names: ReadonlySet<string>,
  window: ObservedWindow,
): boolean =>
  (window.pid !== null && observations.processes.has(window.pid)) ||
  (window.class !== null && names.has(window.class.toLowerCase())) ||
  (window.instance !== null && names.has(window.instance.toLowerCase()));

const recordWindows = async (
  observations: SessionObservations,
  windows: readonly ObservedWindow[],
  names: ReadonlySet<string>,
): Promise<number> => {
  let application = 0;
  const at = observations.now();
  for (const window of windows) {
    const belongs = isApplicationWindow(observations, names, window);
    if (belongs && window.pid !== null)
      await track(observations, window.pid, 0, false);
    if (belongs) application += 1;
    const tracked = observations.windows.get(window.id);
    if (tracked === undefined) {
      observations.windows.set(window.id, {
        window: {
          id: window.id,
          instance: window.instance,
          class: window.class,
          titles: window.title === null ? [] : [window.title],
          pid: window.pid,
          window_type: window.window_type,
          application: belongs,
          first_seen_ms: at,
          last_seen_ms: at,
        },
        lastSeen: at,
      });
      if (belongs && observations.firstWindowMs === null)
        observations.firstWindowMs = at;
      continue;
    }
    tracked.lastSeen = at;
    if (window.title !== null && tracked.window.titles.at(-1) !== window.title)
      tracked.window.titles.push(window.title);
  }
  return application;
};

const signalAll = (
  pids: readonly number[],
  groupLeader: number,
  name: NodeJS.Signals,
) => {
  for (const target of [-groupLeader, ...pids])
    try {
      process.kill(target, name);
    } catch {
      // Already exited.
    }
};

/**
 * Ask the launched process tree to exit, then kill what remains. A process
 * that only owns a matching window, such as an instance the user had already
 * opened, is left running.
 */
const terminate = async (
  observations: SessionObservations,
  launchPid: number,
  signal: AbortSignal,
) => {
  signalAll(observations.liveProcessIds(true), launchPid, "SIGTERM");
  const deadline = performance.now() + TERMINATION_GRACE_MS;
  while (performance.now() < deadline) {
    await sampleProcesses(observations, signal);
    if (observations.liveProcessIds(true).length === 0) return;
    await delay(100);
  }
  signalAll(observations.liveProcessIds(true), launchPid, "SIGKILL");
  await delay(200);
  await sampleProcesses(observations, signal);
};

const launch = (plan: DesktopSessionPlan, stderr: { tail: string }) => {
  const [command, ...arguments_] = plan.argv;
  const child = spawn(command ?? "", arguments_, {
    cwd: plan.workingDirectory,
    env: plan.environment,
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr.tail = `${stderr.tail}${chunk}`.slice(-STDERR_TAIL_BYTES);
  });
  return child;
};

const spawned = (child: ChildProcess): Promise<number> =>
  new Promise((resolve, reject) => {
    child.once("spawn", () => resolve(child.pid ?? 0));
    child.once("error", reject);
  });

/** Facts about the launched process that the session record carries. */
interface Launched {
  readonly startedAt: Date;
  pid: number;
  readonly stderr: { tail: string };
  exit: DesktopSession["exit"];
}

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

const sessionRecord = (
  observations: SessionObservations,
  launched: Launched,
  endReason: DesktopSession["end_reason"],
): DesktopSession => {
  const windows = [...observations.windows.values()].map(
    ({ window, lastSeen }) => ({ ...window, last_seen_ms: lastSeen }),
  );
  return {
    started_at: launched.startedAt.toISOString(),
    duration_ms: observations.now(),
    end_reason: endReason,
    launch_pid: launched.pid,
    exit: launched.exit,
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
    stderr_tail: launched.stderr.tail,
  };
};

type Checkpoint = (
  name: string,
  trigger: "request" | "stop" | "exit",
) => Promise<void>;

/** Run every queued request; true when one of them asked to stop. */
const drainRequests = async (
  plan: DesktopSessionPlan,
  observations: SessionObservations,
  checkpoint: Checkpoint,
): Promise<boolean> => {
  for (
    let request = plan.nextRequest();
    request !== undefined;
    request = plan.nextRequest()
  ) {
    if (request.kind === "stop") return true;
    await checkpoint(
      request.name ?? `checkpoint-${String(observations.now())}`,
      "request",
    );
  }
  return false;
};

/** Sample processes, windows and open files; returns the application's window count. */
const sampleSession = async (
  plan: DesktopSessionPlan,
  observations: SessionObservations,
  signal: AbortSignal,
): Promise<number> => {
  await sampleProcesses(observations, signal);
  const windows = await plan.windows.sample(
    (window) => isApplicationWindow(observations, plan.windowNames, window),
    signal,
  );
  const applicationWindows =
    windows === undefined
      ? 0
      : await recordWindows(observations, windows, plan.windowNames);
  await sampleOpenFiles(observations, plan.roots);
  if (!observations.announced && observations.firstWindowMs !== null) {
    observations.announced = true;
    await plan.report(
      "The application window is open. Send an empty line or `checkpoint <name>` to record its state, or `stop` to finish.",
    );
  }
  return applicationWindows;
};

const start = async (
  plan: DesktopSessionPlan,
  observations: SessionObservations,
): Promise<Launched> => {
  const stderr = { tail: "" };
  const child = launch(plan, stderr);
  const launched: Launched = {
    startedAt: new Date(),
    pid: 0,
    stderr,
    exit: null,
  };
  child.once("exit", (code, exitSignal) => {
    launched.exit = { code, signal: exitSignal };
  });
  launched.pid = await spawned(child);
  await track(observations, launched.pid, process.pid, true);
  return launched;
};

/**
 * Launch the application in its own process group and watch it until it
 * exits, a stop is requested or the time limit passes. Checkpoints run between
 * samples, so a checkpoint never overlaps process or window reads.
 */
export const runDesktopSession = async (
  plan: DesktopSessionPlan,
): Promise<DesktopSession> => {
  const signal = plan.signal ?? new AbortController().signal;
  const observations = new SessionObservations(performance.now());
  const launched = await start(plan, observations);
  const checkpoint: Checkpoint = (name, trigger) =>
    plan.checkpoint(
      name,
      trigger,
      observations.now(),
      new Set(observations.openedFiles.keys()),
    );
  let endReason: DesktopSession["end_reason"] | undefined;
  let quietSamples = 0;
  try {
    while (endReason === undefined) {
      signal.throwIfAborted();
      if (await drainRequests(plan, observations, checkpoint)) {
        endReason = "stop_requested";
        break;
      }
      const applicationWindows = await sampleSession(
        plan,
        observations,
        signal,
      );
      const quiet =
        observations.liveProcessIds(true).length === 0 &&
        applicationWindows === 0;
      quietSamples = quiet ? quietSamples + 1 : 0;
      if (quietSamples >= 2) endReason = "application_exited";
      else if (observations.now() >= plan.maxDurationMs)
        endReason = "time_limit";
      else await delay(plan.pollIntervalMs, undefined, { signal });
    }
    if (endReason !== "application_exited") {
      await checkpoint(
        endReason === "stop_requested" ? "stop" : "time-limit",
        "stop",
      );
      await terminate(observations, launched.pid, signal);
    }
  } catch (cause: unknown) {
    await terminate(observations, launched.pid, new AbortController().signal);
    throw cause;
  }
  await checkpoint("exit", "exit");
  return sessionRecord(observations, launched, endReason);
};
