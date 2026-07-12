import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type IPty } from "node-pty";
import type {
  FileState,
  ProcessCapture,
  ProcessExecutionPolicy,
  ProcessSample,
  ProcessScenario,
  TerminalFrame,
} from "../domain/processCapture.js";
import { authorizeProcessScenario } from "../domain/processCapture.js";
import { err, ok, type Result } from "../domain/result.js";
import { AnalysisError } from "../domain/errors.js";
import { startLoopbackReplay, type LoopbackReplay } from "./LoopbackReplay.js";
import { cleanupOwnedProcessGroup } from "./ProcessOwnership.js";
import { startProcessSampler } from "./ProcessSampling.js";
import { snapshotRoots, type SnapshotResult } from "./FilesystemSnapshot.js";
import {
  normalizeProcessSamples,
  normalizeProcessText,
  redactProtocolEvents,
} from "./ProcessNormalization.js";

const isWithin = (candidate: string, root: string): boolean =>
  candidate === root ||
  candidate.startsWith(`${root.endsWith("/") ? root.slice(0, -1) : root}/`);

const assertRealPathAuthority = async (
  scenario: ProcessScenario,
  policy: ProcessExecutionPolicy,
): Promise<void> => {
  const executable = await realpath(scenario.executable);
  const executableRoots = await Promise.all(
    policy.executableRoots.map((root) => realpath(root)),
  );
  if (!executableRoots.some((root) => isWithin(executable, root)))
    throw new ProcessCaptureError(
      "resolved executable is outside approved roots",
    );
  const workingDirectory = await realpath(scenario.working_directory);
  const workingRoots = await Promise.all(
    policy.workingRoots.map((root) => realpath(root)),
  );
  if (!workingRoots.some((root) => isWithin(workingDirectory, root)))
    throw new ProcessCaptureError(
      "resolved working directory is outside approved roots",
    );
  for (const root of scenario.filesystem_roots) {
    const resolvedRoot = await realpath(root);
    if (!workingRoots.some((approved) => isWithin(resolvedRoot, approved)))
      throw new ProcessCaptureError(
        "resolved filesystem root is outside approved roots",
      );
  }
};

/** Expected refusal or runtime failure from the process capture adapter. */
export class ProcessCaptureError extends AnalysisError {
  readonly _tag = "ProcessCaptureError";
}

const assertNotCancelled = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted === true)
    throw new ProcessCaptureError("process capture was cancelled");
};

/** Runtime availability of the native PTY adapter on this host. */
export type ProcessCaptureCapability =
  | { readonly available: true; readonly backend: "node-pty" }
  | {
      readonly available: false;
      readonly backend: "node-pty";
      readonly reason: string;
    };

/** Probe the actual native PTY seam instead of inferring support from the OS name. */
export const probeProcessCaptureCapability =
  async (): Promise<ProcessCaptureCapability> => {
    try {
      const terminal = spawn(
        process.platform === "win32" ? "cmd.exe" : "/bin/sh",
        process.platform === "win32" ? ["/c", "exit", "0"] : ["-c", "exit 0"],
        {
          cwd: tmpdir(),
          env: { HOME: tmpdir(), TERM: "xterm-256color" },
          cols: 80,
          rows: 24,
          name: "xterm-256color",
        },
      );
      await new Promise<void>((resolveExit) =>
        terminal.onExit(() => resolveExit()),
      );
      return { available: true, backend: "node-pty" };
    } catch {
      return {
        available: false,
        backend: "node-pty",
        reason: "the native PTY backend could not start a probe process",
      };
    }
  };

const makeEnvironment = (
  scenario: ProcessScenario,
  home: string,
  replay: LoopbackReplay,
  runId: string,
): Record<string, string> => {
  const environment: Record<string, string> = {
    ...scenario.environment,
    HOME: home,
    TERM: "xterm-256color",
    REA_PROCESS_RUN_ID: runId,
  };
  for (const name of scenario.inherit_environment) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  environment.REA_REPLAY_HTTP_URL = replay.httpUrl;
  environment.REA_REPLAY_WEBSOCKET_URL = replay.websocketUrl;
  return environment;
};

const scheduleScenarioEvents = (
  scenario: ProcessScenario,
  getTerminal: () => IPty | undefined,
  timers: Set<NodeJS.Timeout>,
): void => {
  for (const event of scenario.events) {
    const timer = setTimeout(() => {
      const terminal = getTerminal();
      if (event.type === "input") terminal?.write(event.data);
      else if (event.type === "resize")
        terminal?.resize(event.columns, event.rows);
      else terminal?.kill(event.signal);
    }, event.at_ms);
    timers.add(timer);
  }
};

const startScenarioEvents = (
  scenario: ProcessScenario,
  getTerminal: () => IPty | undefined,
  timers: Set<NodeJS.Timeout>,
): (() => void) => {
  let started = false;
  return () => {
    if (started) return;
    started = true;
    scheduleScenarioEvents(scenario, getTerminal, timers);
  };
};

const eventsRequireReadiness = (scenario: ProcessScenario): boolean =>
  scenario.events.some(
    (event) => event.type === "input" || event.type === "resize",
  );

interface TerminalExitOptions {
  readonly terminal: IPty;
  readonly scenario: ProcessScenario;
  readonly started: number;
  readonly lastOutput: () => number;
  readonly signal: AbortSignal | undefined;
  readonly timers: Set<NodeJS.Timeout>;
}

interface CaptureResultOptions {
  readonly frames: readonly TerminalFrame[];
  readonly exit: {
    readonly exitCode: number;
    readonly signal?: number;
    readonly reason: "exited" | "timeout" | "idle_timeout";
  };
  readonly samples: readonly ProcessSample[];
  readonly replay: LoopbackReplay;
  readonly before: SnapshotResult;
  readonly after: SnapshotResult;
  readonly truncated: boolean;
  readonly scenario: ProcessScenario;
  readonly rootPid: number;
  readonly samplingPartial: boolean;
}

const classifyFilesystemEffects = (
  before: readonly FileState[],
  after: readonly FileState[],
): ProcessCapture["filesystem_effects"] => {
  const beforeByPath = new Map(before.map((file) => [file.path, file]));
  const afterByPath = new Map(after.map((file) => [file.path, file]));
  const paths = [
    ...new Set([...beforeByPath.keys(), ...afterByPath.keys()]),
  ].sort();
  return paths.map((path) => {
    const beforeFile = beforeByPath.get(path) ?? null;
    const afterFile = afterByPath.get(path) ?? null;
    const status =
      beforeFile === null
        ? "created"
        : afterFile === null
          ? "deleted"
          : JSON.stringify(beforeFile) === JSON.stringify(afterFile)
            ? "unchanged"
            : "modified";
    return { path, status, before: beforeFile, after: afterFile };
  });
};

const buildCaptureResult = (options: CaptureResultOptions): ProcessCapture => ({
  schema_version: 2,
  normalization: options.scenario.normalization,
  frames: options.frames,
  exit: {
    code: options.exit.exitCode < 0 ? null : options.exit.exitCode,
    signal: options.exit.signal ?? null,
    reason: options.exit.reason,
  },
  process_samples: normalizeProcessSamples(
    options.samples,
    options.scenario,
    options.rootPid,
  ),
  protocol_events: redactProtocolEvents(
    options.replay.events,
    options.scenario,
  ),
  files_before: options.before.files,
  files_after: options.after.files,
  filesystem_effects: classifyFilesystemEffects(
    options.before.files,
    options.after.files,
  ),
  truncated: options.truncated,
  limitations: [
    "Process trees are sampled and may omit short-lived descendants.",
    ...(options.samplingPartial
      ? ["Process-tree sampling ended with an incomplete observation."]
      : []),
    "Filesystem observations are before/after snapshots, not syscall traces.",
    "The harness does not enforce external network isolation.",
  ],
  residual_unknowns: [
    {
      scope: "process",
      reason: "Process trees are sampled and may omit short-lived descendants.",
    },
    {
      scope: "network",
      reason: "External network isolation is not enforced by this adapter.",
    },
  ],
  cleanup: {
    owned_process_group: "verified",
    temporary_root: "removed",
  },
});

const awaitTerminalExit = async ({
  terminal,
  scenario,
  started,
  lastOutput,
  signal,
  timers,
}: TerminalExitOptions): Promise<{
  exitCode: number;
  signal?: number;
  reason: "exited" | "timeout" | "idle_timeout" | "cancelled";
}> =>
  new Promise((resolveExit) => {
    let reason: "exited" | "timeout" | "idle_timeout" | "cancelled" = "exited";
    terminal.onExit((exit) => {
      for (const timer of timers) {
        clearTimeout(timer);
        clearInterval(timer);
      }
      timers.clear();
      resolveExit({ ...exit, reason });
    });
    const timeout = setInterval(() => {
      if (signal?.aborted === true) {
        reason = "cancelled";
        terminal.kill("SIGKILL");
      } else if (Date.now() - started >= scenario.timeout_ms) {
        reason = "timeout";
        terminal.kill("SIGKILL");
      } else if (Date.now() - lastOutput() >= scenario.idle_timeout_ms) {
        reason = "idle_timeout";
        terminal.kill("SIGKILL");
      }
    }, 20);
    timers.add(timeout);
  });

const releaseProcessResources = async (options: {
  readonly timers: ReadonlySet<NodeJS.Timeout>;
  readonly replay: LoopbackReplay | undefined;
  readonly terminal: IPty | undefined;
  readonly runId: string;
  readonly temporaryRoot: string;
}): Promise<string | undefined> => {
  for (const timer of options.timers) clearTimeout(timer);
  let failure: string | undefined;
  try {
    await options.replay?.close();
  } catch {
    failure = "loopback replay cleanup failed";
  }
  if (options.terminal !== undefined && process.platform !== "win32") {
    const cleaned = await cleanupOwnedProcessGroup({
      runId: options.runId,
      leaderPid: options.terminal.pid,
      processGroupId: options.terminal.pid,
    });
    if (!cleaned.cleaned) failure ??= cleaned.reason;
  }
  try {
    await rm(options.temporaryRoot, { recursive: true, force: true });
  } catch {
    failure ??= "temporary process root cleanup failed";
  }
  return failure;
};

const captureTerminalFrames = (options: {
  readonly terminal: IPty;
  readonly scenario: ProcessScenario;
  readonly frames: TerminalFrame[];
  readonly started: number;
  readonly temporaryRoot: string;
  readonly onOutput: () => void;
  readonly onFirstOutput: () => void;
}): (() => boolean) => {
  let outputBytes = 0;
  let truncated = false;
  options.terminal.onData((data) => {
    options.onFirstOutput();
    options.onOutput();
    const bytes = Buffer.byteLength(data);
    if (
      options.frames.length >= options.scenario.limits.frames ||
      outputBytes + bytes > options.scenario.limits.output_bytes
    ) {
      truncated = true;
      return;
    }
    outputBytes += bytes;
    options.frames.push({
      sequence: options.frames.length,
      at_ms:
        Math.floor(
          (Date.now() - options.started) /
            options.scenario.normalization.time_bucket_ms,
        ) * options.scenario.normalization.time_bucket_ms,
      data: normalizeProcessText(
        data,
        options.scenario,
        options.temporaryRoot,
        options.terminal.pid,
      ),
    });
  });
  return () => truncated;
};

const resolveProcessResult = (
  capture: ProcessCapture | undefined,
  executionFailure: unknown,
  cleanupFailure: string | undefined,
): ProcessCapture => {
  if (executionFailure instanceof ProcessCaptureError) throw executionFailure;
  if (executionFailure !== undefined)
    throw new ProcessCaptureError("process capture failed", {
      cause: executionFailure,
    });
  if (cleanupFailure !== undefined)
    throw new ProcessCaptureError(cleanupFailure);
  if (capture === undefined)
    throw new ProcessCaptureError("process capture produced no result");
  return capture;
};

const prepareProcessCapture = async (
  scenario: ProcessScenario,
  policy: ProcessExecutionPolicy,
  signal: AbortSignal | undefined,
): Promise<{
  readonly temporaryRoot: string;
  readonly runId: string;
  readonly home: string;
  readonly before: SnapshotResult;
}> => {
  const decision = authorizeProcessScenario(scenario, policy);
  if (!decision.allowed) throw new ProcessCaptureError(decision.reason);
  await assertRealPathAuthority(scenario, policy);
  assertNotCancelled(signal);
  const before = await snapshotRoots(scenario, signal);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "rea-process-"));
  const runId = randomUUID();
  const home = join(temporaryRoot, "home");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(home));
  return { temporaryRoot, runId, home, before };
};

/** Execute one authorized scenario and return bounded observations. */
const runProcessScenario = async (
  scenario: ProcessScenario,
  policy: ProcessExecutionPolicy,
  signal?: AbortSignal,
): Promise<ProcessCapture> => {
  const { temporaryRoot, runId, home, before } = await prepareProcessCapture(
    scenario,
    policy,
    signal,
  );
  const frames: TerminalFrame[] = [];
  const samples: ProcessSample[] = [];
  let truncated = before.truncated;
  let terminal: IPty | undefined;
  let replay: LoopbackReplay | undefined;
  let started = 0;
  let lastOutput = 0;
  const timers = new Set<NodeJS.Timeout>();
  let capture: ProcessCapture | undefined;
  let executionFailure: unknown;
  let framesTruncated = (): boolean => false;
  let stopSampler = async () => ({ partial: false });
  let samplingPartial = false;

  try {
    replay = await startLoopbackReplay(scenario);
    started = Date.now();
    lastOutput = started;
    terminal = spawn(scenario.executable, [...scenario.arguments], {
      cwd: scenario.working_directory,
      env: makeEnvironment(scenario, home, replay, runId),
      cols: 80,
      rows: 24,
      name: "xterm-256color",
    });
    const startEvents = startScenarioEvents(scenario, () => terminal, timers);
    if (!eventsRequireReadiness(scenario)) startEvents();
    framesTruncated = captureTerminalFrames({
      terminal,
      scenario,
      frames,
      started,
      temporaryRoot,
      onOutput: () => (lastOutput = Date.now()),
      onFirstOutput: startEvents,
    });
    stopSampler = startProcessSampler(
      terminal.pid,
      started,
      scenario.limits.processes,
      samples,
    );
    const exit = await awaitTerminalExit({
      terminal,
      scenario,
      started,
      lastOutput: () => lastOutput,
      signal,
      timers,
    });
    const exitReason = exit.reason;
    samplingPartial = (await stopSampler()).partial;
    if (exitReason === "cancelled")
      throw new ProcessCaptureError("process capture was cancelled");
    await new Promise((resolveSettle) =>
      setTimeout(resolveSettle, scenario.settle_ms),
    );
    assertNotCancelled(signal);
    const after = await snapshotRoots(scenario, signal);
    truncated ||=
      after.truncated ||
      replay.truncated ||
      framesTruncated() ||
      samples.length >= scenario.limits.processes;
    truncated ||= samplingPartial;
    capture = buildCaptureResult({
      frames,
      exit: { ...exit, reason: exitReason },
      samples,
      replay,
      before,
      after,
      truncated,
      scenario,
      rootPid: terminal.pid,
      samplingPartial,
    });
  } catch (cause: unknown) {
    terminal?.kill("SIGKILL");
    executionFailure = cause;
  }
  samplingPartial ||= (await stopSampler()).partial;
  const cleanupFailure = await releaseProcessResources({
    timers,
    replay,
    terminal,
    runId,
    temporaryRoot,
  });
  return resolveProcessResult(capture, executionFailure, cleanupFailure);
};

/** Execute one scenario through a typed expected-failure channel. */
export const captureProcessScenario = async (
  scenario: ProcessScenario,
  policy: ProcessExecutionPolicy,
  signal?: AbortSignal,
): Promise<Result<ProcessCapture, ProcessCaptureError>> => {
  try {
    return ok(await runProcessScenario(scenario, policy, signal));
  } catch (cause: unknown) {
    return err(
      cause instanceof ProcessCaptureError
        ? cause
        : new ProcessCaptureError("process capture failed", { cause }),
    );
  }
};
