import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import {
  checkpointNameRefusal,
  type DesktopSession,
} from "../domain/desktop/desktopCapture.js";
import { ownedCommandResources } from "../process/OwnedCommand.js";
import { cleanupOwnedProcessGroup } from "../process/ProcessOwnership.js";
import {
  ProviderProcessSupervisor,
  spawnOwnedProviderProcess,
  type SpawnedOwnedProviderProcess,
} from "../process/ProviderProcess.js";
import { terminateTokenOwnedProcesses } from "../process/TokenOwnedTermination.js";
import {
  SessionObservations,
  matchesWindowNames,
  observedSession,
  recordWindows,
  sampleOpenFiles,
  sampleProcesses,
  trackProcess,
  type WindowMatching,
} from "./DesktopSessionObservations.js";
import type { WindowSample, X11WindowObserver } from "./X11WindowObserver.js";

const STDERR_BYTES = 8 * 1024;
const TERMINATION_GRACE_MS = 5_000;

/** The session record and, when cleanup was not verified, what remains owned. */
export interface DesktopSessionOutcome {
  readonly session: DesktopSession;
  /** Run token, launcher pid and process group still owned after cleanup failed. */
  readonly cleanupResources: readonly string[];
}

/** A session failed, and the processes it launched could not all be removed. */
export class DesktopSessionCleanupError extends Error {
  constructor(
    readonly primary: unknown,
    readonly cleanup: {
      readonly reason: string;
      readonly resources: readonly string[];
    },
  ) {
    super(`desktop session cleanup is incomplete: ${cleanup.reason}`, {
      cause: primary,
    });
    this.name = "DesktopSessionCleanupError";
  }
}

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
  readonly windowMatching: WindowMatching;
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
 * Windows that already match the application by name before it is launched,
 * or why the window list cannot be read. A capture refuses to start beside
 * such windows: the launch could hand off to that instance, and its unsaved
 * state would sit outside the baseline.
 */
export const runningApplicationWindows = async (
  windows: X11WindowObserver,
  names: ReadonlySet<string>,
  signal?: AbortSignal,
): Promise<WindowSample> => {
  const sample = await windows.sample(() => false, signal);
  return sample.state === "listed"
    ? {
        state: "listed",
        windows: sample.windows.filter((window) =>
          matchesWindowNames(window, names),
        ),
      }
    : sample;
};

/** Sample processes, windows and open files; returns the application's window count. */
const sampleSession = async (
  plan: DesktopSessionPlan,
  observations: SessionObservations,
  signal: AbortSignal,
): Promise<number> => {
  await sampleProcesses(observations, signal);
  const sample = await plan.windows.sample(
    (window) => observations.belongs(window),
    signal,
  );
  const applicationWindows =
    sample.state === "listed"
      ? await recordWindows(observations, sample.windows, signal)
      : 0;
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

/** Record a requested checkpoint, or report why its name was refused and carry on. */
const requestCheckpoint = async (
  plan: DesktopSessionPlan,
  observations: SessionObservations,
  name: string | undefined,
  taken: Set<string>,
): Promise<void> => {
  const refusal = checkpointNameRefusal(name, taken);
  if (refusal !== undefined) {
    await plan.report(`${refusal} No checkpoint was recorded.`);
    return;
  }
  const chosen = name ?? `checkpoint-${String(observations.now())}`;
  taken.add(chosen);
  await checkpointNow(plan, observations, chosen, "request");
};

/** Watch until the application exits, a stop is requested or time runs out. */
const watch = async (
  plan: DesktopSessionPlan,
  observations: SessionObservations,
  supervisor: ProviderProcessSupervisor,
  signal: AbortSignal,
): Promise<DesktopSession["end_reason"]> => {
  let quietSamples = 0;
  const taken = new Set<string>();
  for (;;) {
    signal.throwIfAborted();
    if (observations.now() >= plan.maxDurationMs) return "time_limit";
    // One request per sample, so queued lines cannot starve observation.
    const request = plan.nextRequest();
    if (request?.kind === "stop") return "stop_requested";
    if (request !== undefined)
      await requestCheckpoint(plan, observations, request.name, taken);
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
 * Ask the launched process, its process group and every process carrying the
 * run token to exit, wait up to the grace period, then remove whatever still
 * carries the token. Processes that only own a matching window, such as an
 * instance started outside the capture, are never signalled.
 */
const release = async (
  spawned: SpawnedOwnedProviderProcess,
  supervisor: ProviderProcessSupervisor,
): Promise<DesktopSession["cleanup"]> => {
  // One SIGTERM each, since some applications treat a second one as a forced exit.
  const { launchGroupSignalled } = await terminateTokenOwnedProcesses(
    spawned.ownership,
    TERMINATION_GRACE_MS,
  );
  if (!launchGroupSignalled && supervisor.observedExit() === undefined) {
    spawned.process.kill("SIGTERM");
    await supervisor.waitForExit(TERMINATION_GRACE_MS);
  }
  let stopped = await supervisor.stop();
  // An incomplete stop leaves the supervisor owning the processes; try once more.
  if (stopped.status === "incomplete") stopped = await supervisor.stop();
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
 * further checkpoints and still releases the application; any other failure
 * releases it the same way before it is rethrown.
 */
export const runDesktopSession = async (
  plan: DesktopSessionPlan,
): Promise<DesktopSessionOutcome> => {
  const signal = plan.signal ?? new AbortController().signal;
  const runId = randomUUID();
  const startedAt = new Date();
  const startedMs = performance.now();
  const { spawned, supervisor } = await launch(plan, runId, signal);
  const observations = new SessionObservations(
    startedMs,
    { runId, launchPid: spawned.ownership.leaderPid },
    plan.windowMatching,
  );
  let endReason: DesktopSession["end_reason"];
  let cleanup: DesktopSession["cleanup"];
  try {
    await trackProcess(observations, spawned.ownership.leaderPid, signal);
    endReason = await watch(plan, observations, supervisor, signal);
    if (endReason !== "application_exited")
      await checkpointNow(
        plan,
        observations,
        endReason === "stop_requested" ? "stop" : "time-limit",
        "stop",
      );
    cleanup = await release(spawned, supervisor);
    await checkpointNow(plan, observations, "exit", "exit");
  } catch (cause: unknown) {
    cleanup = await release(spawned, supervisor);
    if (!signal.aborted) {
      if (cleanup.verified) throw cause;
      throw new DesktopSessionCleanupError(cause, {
        reason: cleanup.reason ?? "cleanup was not verified",
        resources: ownedCommandResources(spawned.ownership),
      });
    }
    endReason = "cancelled";
  }
  const snapshot = supervisor.snapshot();
  const exit = supervisor.observedExit();
  const session: DesktopSession = {
    started_at: startedAt.toISOString(),
    duration_ms: observations.now(),
    end_reason: endReason,
    launch_pid: spawned.ownership.leaderPid,
    exit: exit === undefined ? null : { code: exit.code, signal: exit.signal },
    ...observedSession(observations),
    stderr: snapshot.stderr.text,
    stderr_truncated: snapshot.stderr.bytes < snapshot.stderr.observedBytes,
    cleanup,
  };
  return {
    session,
    cleanupResources: cleanup.verified
      ? []
      : ownedCommandResources(spawned.ownership),
  };
};
