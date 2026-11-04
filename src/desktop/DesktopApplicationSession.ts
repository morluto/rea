import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import type { DesktopSession } from "../domain/desktop/desktopCapture.js";
import { cleanupOwnedProcessGroup } from "../process/ProcessOwnership.js";
import {
  ProviderProcessSupervisor,
  spawnOwnedProviderProcess,
  type SpawnedOwnedProviderProcess,
} from "../process/ProviderProcess.js";
import {
  SessionObservations,
  observedSession,
  recordWindows,
  sampleOpenFiles,
  sampleProcesses,
  trackProcess,
} from "./DesktopSessionObservations.js";
import type { ObservedWindow, X11WindowObserver } from "./X11WindowObserver.js";

const STDERR_BYTES = 8 * 1024;
const TERMINATION_GRACE_MS = 5_000;

/** A line the person or driver sent while the session runs. */
export type SessionRequest =
  | { readonly kind: "checkpoint"; readonly name: string | undefined }
  | { readonly kind: "stop" };

type CheckpointTrigger = "request" | "stop" | "exit";

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
    trigger: CheckpointTrigger,
    atMs: number,
    openedFiles: ReadonlySet<string>,
  ) => Promise<void>;
  readonly report: (message: string) => Promise<void>;
  readonly signal: AbortSignal | undefined;
}

/**
 * Windows that already match the application before it is launched, or
 * undefined when the window list cannot be read. A capture refuses to start
 * beside such windows: the launch could hand off to that instance, and its
 * unsaved state would sit outside the baseline.
 */
export const runningApplicationWindows = async (
  windows: X11WindowObserver,
  names: ReadonlySet<string>,
  signal?: AbortSignal,
): Promise<readonly ObservedWindow[] | undefined> => {
  const observations = new SessionObservations(performance.now(), "", names);
  return (await windows.sample(() => false, signal))?.filter((window) =>
    observations.belongs(window),
  );
};

/** Sample processes, windows and open files; returns the application's window count. */
const sampleSession = async (
  plan: DesktopSessionPlan,
  observations: SessionObservations,
  signal: AbortSignal,
): Promise<number> => {
  await sampleProcesses(observations, signal);
  const windows = await plan.windows.sample(
    (window) => observations.belongs(window),
    signal,
  );
  const applicationWindows =
    windows === undefined
      ? 0
      : await recordWindows(observations, windows, signal);
  await sampleOpenFiles(observations, plan.roots);
  if (!observations.announced && observations.firstWindowMs !== null) {
    observations.announced = true;
    await plan.report(
      "The application window is open. Send an empty line or `checkpoint <name>` to record its state, or `stop` to finish.",
    );
  }
  return applicationWindows;
};

const checkpointNow = (
  plan: DesktopSessionPlan,
  observations: SessionObservations,
  name: string,
  trigger: CheckpointTrigger,
): Promise<void> =>
  plan.checkpoint(
    name,
    trigger,
    observations.now(),
    new Set(observations.openedFiles.keys()),
  );

/** Watch until the application exits, a stop is requested or time runs out. */
const watch = async (
  plan: DesktopSessionPlan,
  observations: SessionObservations,
  supervisor: ProviderProcessSupervisor,
  signal: AbortSignal,
): Promise<DesktopSession["end_reason"]> => {
  let quietSamples = 0;
  for (;;) {
    signal.throwIfAborted();
    if (observations.now() >= plan.maxDurationMs) return "time_limit";
    // One request per sample, so queued lines cannot starve observation.
    const request = plan.nextRequest();
    if (request?.kind === "stop") return "stop_requested";
    if (request !== undefined)
      await checkpointNow(
        plan,
        observations,
        request.name ?? `checkpoint-${String(observations.now())}`,
        "request",
      );
    const applicationWindows = await sampleSession(plan, observations, signal);
    const quiet =
      supervisor.observedExit() !== undefined &&
      observations.liveProcessIds(true).length === 0 &&
      applicationWindows === 0;
    quietSamples = quiet ? quietSamples + 1 : 0;
    if (quietSamples >= 2) return "application_exited";
    await delay(plan.pollIntervalMs, undefined, { signal });
  }
};

/**
 * Ask the launched process to exit, then remove every process carrying the
 * run token. Processes that only own a matching window, such as an instance
 * started outside the capture, are never signalled.
 */
const release = async (
  spawned: SpawnedOwnedProviderProcess,
  supervisor: ProviderProcessSupervisor,
  graceful: boolean,
): Promise<DesktopSession["cleanup"]> => {
  if (graceful && supervisor.observedExit() === undefined) {
    spawned.process.kill("SIGTERM");
    await supervisor.waitForExit(TERMINATION_GRACE_MS);
  }
  const stopped = await supervisor.stop();
  return stopped.status === "incomplete"
    ? { verified: false, reason: stopped.reason }
    : { verified: true, reason: null };
};

const launch = async (
  plan: DesktopSessionPlan,
  runId: string,
  signal: AbortSignal,
) => {
  const [command, ...arguments_] = plan.argv;
  const spawned = await spawnOwnedProviderProcess({
    command: command ?? "",
    arguments: arguments_,
    runId,
    // Desktop launchers often exec through env, a shell or a wrapper script.
    expectedCommand: null,
    cwd: plan.workingDirectory,
    hostEnvironment: plan.environment,
    sweepTokenOwnedProcesses: true,
    signal,
  });
  const supervisor = new ProviderProcessSupervisor(
    {
      ...spawned,
      ownsProcessLifetime: true,
      cleanup:
        spawned.cleanup ?? (() => cleanupOwnedProcessGroup(spawned.ownership)),
    },
    { maxDiagnosticBytes: { stdout: 0, stderr: STDERR_BYTES } },
  );
  return { spawned, supervisor };
};

/**
 * Launch the application with a run token in its own process group and watch
 * it. Checkpoints run between samples. Cancellation ends the session without
 * further checkpoints and still releases the application.
 */
export const runDesktopSession = async (
  plan: DesktopSessionPlan,
): Promise<DesktopSession> => {
  const signal = plan.signal ?? new AbortController().signal;
  const runId = randomUUID();
  const startedAt = new Date();
  const observations = new SessionObservations(
    performance.now(),
    runId,
    plan.windowNames,
  );
  const { spawned, supervisor } = await launch(plan, runId, signal);
  let endReason: DesktopSession["end_reason"];
  let cleanup: DesktopSession["cleanup"];
  try {
    await trackProcess(
      observations,
      spawned.ownership.leaderPid,
      process.pid,
      signal,
    );
    endReason = await watch(plan, observations, supervisor, signal);
    if (endReason !== "application_exited")
      await checkpointNow(
        plan,
        observations,
        endReason === "stop_requested" ? "stop" : "time-limit",
        "stop",
      );
    cleanup = await release(spawned, supervisor, true);
    await checkpointNow(plan, observations, "exit", "exit");
  } catch (cause: unknown) {
    // A cancelled session still lets the application exit on SIGTERM first.
    cleanup = await release(spawned, supervisor, signal.aborted);
    if (!signal.aborted) throw cause;
    endReason = "cancelled";
  }
  const snapshot = supervisor.snapshot();
  const exit = supervisor.observedExit();
  return {
    started_at: startedAt.toISOString(),
    duration_ms: observations.now(),
    end_reason: endReason,
    launch_pid: spawned.ownership.leaderPid,
    exit: exit === undefined ? null : { code: exit.code, signal: exit.signal },
    ...observedSession(observations),
    stderr: snapshot.stderr.text,
    stderr_truncated: snapshot.diagnosticTruncated === true,
    cleanup,
  };
};
