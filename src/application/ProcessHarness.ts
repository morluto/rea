import type { IPty } from "@lydell/node-pty";
import type {
  InteractionEvent,
  ProcessCapture,
  ProcessCaptureEventJournalEntry,
  ProcessExecutionPolicy,
  ProcessSample,
  ProcessScenario,
  RecordProcessCaptureEvent,
  TerminalFrame,
} from "../domain/processCapture.js";
import { validateProcessCapture } from "../domain/processCapture.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  ProcessCaptureError,
  processCaptureCancelled,
} from "./ProcessCaptureError.js";

export { ProcessCaptureError } from "./ProcessCaptureError.js";
import { startLoopbackReplay, type LoopbackReplay } from "./LoopbackReplay.js";
import { startProcessSampler } from "./ProcessSampling.js";
import { snapshotRoots } from "./FilesystemSnapshot.js";
import { ProcessCheckpoints } from "./ProcessCheckpoints.js";
import { TerminalRenderer } from "./TerminalRenderer.js";
import {
  startCommandShimReplay,
  type CommandShimReplay,
} from "./CommandShimReplay.js";
import { normalizeProcessText } from "./ProcessNormalization.js";
import { selectCapturedProcessGroupIds } from "../process/ProcessOwnership.js";
import {
  awaitTerminalExit,
  buildCaptureResult,
  captureTerminalFrames,
  createRunManifest,
  observeSettlement,
  prepareProcessCapture,
  releaseProcessResources,
  resolveProcessResult,
} from "./ProcessCaptureLifecycle.js";
import { assertNotCancelled } from "./ProcessCaptureAuthority.js";
import {
  createProcessCaptureJournal,
  scheduleScenarioInteractions,
} from "./ProcessCaptureJournal.js";

export { probeProcessCaptureCapability } from "./ProcessCaptureCapability.js";

interface EnvironmentOptions {
  readonly scenario: ProcessScenario;
  readonly home: string;
  readonly replay: LoopbackReplay;
  readonly shimReplay: CommandShimReplay;
  readonly runId: string;
}

const makeEnvironment = (
  options: EnvironmentOptions,
): Record<string, string> => {
  const { scenario, home, replay, shimReplay, runId } = options;
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
  environment.REA_SHIM_LEDGER_URL = shimReplay.url;
  // PATH is evidence-producing input. Inheriting the host PATH here would let
  // the authority and reconstruction probe different tools without recording
  // that difference. Scenarios must opt in through environment or
  // inherit_environment; deterministic shims always take precedence.
  environment.PATH = [shimReplay.binPath, environment.PATH ?? ""]
    .filter((part) => part.length > 0)
    .join(":");
  return environment;
};

interface StartedCaptureRuntime {
  readonly replay: LoopbackReplay;
  readonly renderer: TerminalRenderer;
  readonly checkpoints: ProcessCheckpoints;
  readonly shimReplay: CommandShimReplay;
  readonly terminal: IPty;
  readonly started: number;
  readonly startedAt: Date;
  readonly lastOutput: () => number;
  readonly framesTruncated: () => boolean;
  readonly stopSampler: () => Promise<{ readonly partial: boolean }>;
}

const cleanupFailedStartup = async (options: {
  readonly cause: unknown;
  readonly timers: Set<NodeJS.Timeout>;
  readonly replay: LoopbackReplay | undefined;
  readonly terminal: IPty | undefined;
  readonly renderer: TerminalRenderer | undefined;
  readonly shimReplay: CommandShimReplay | undefined;
  readonly checkpoints: ProcessCheckpoints | undefined;
  readonly runId: string;
  readonly temporaryRoot: string;
}): Promise<never> => {
  options.terminal?.kill("SIGKILL");
  const cleanupFailure = await releaseProcessResources({
    ...options,
    capturedProcessGroupIds:
      options.terminal === undefined ? [] : [options.terminal.pid],
  });
  if (cleanupFailure !== undefined)
    throw new ProcessCaptureError(cleanupFailure, {
      cause: options.cause,
      reason: "cleanup_incomplete",
    });
  throw options.cause;
};

const createTerminalRenderer = (
  scenario: ProcessScenario,
  temporaryRoot: string,
  terminalPid: () => number,
  recordEvent: RecordProcessCaptureEvent,
): TerminalRenderer =>
  new TerminalRenderer({
    columns: scenario.terminal.columns,
    rows: scenario.terminal.rows,
    scrollback: scenario.terminal.scrollback,
    maxFrames: scenario.limits.frames,
    maxBytes: scenario.limits.output_bytes,
    normalize: (value) =>
      normalizeProcessText(value, scenario, temporaryRoot, terminalPid()),
    recordEvent,
  });

const startCaptureRuntime = async (options: {
  readonly scenario: ProcessScenario;
  readonly home: string;
  readonly temporaryRoot: string;
  readonly runId: string;
  readonly before: Awaited<ReturnType<typeof snapshotRoots>>;
  readonly frames: TerminalFrame[];
  readonly samples: ProcessSample[];
  readonly interactions: InteractionEvent[];
  readonly timers: Set<NodeJS.Timeout>;
  readonly dispatchedEventIndexes: Set<number>;
  readonly recordEvent: RecordProcessCaptureEvent;
  readonly signal?: AbortSignal;
}): Promise<StartedCaptureRuntime> => {
  const { scenario } = options;
  let replay: LoopbackReplay | undefined;
  let renderer: TerminalRenderer | undefined;
  let checkpoints: ProcessCheckpoints | undefined;
  let shimReplay: CommandShimReplay | undefined;
  let terminal: IPty | undefined;
  try {
    const { spawn } = await import("@lydell/node-pty");
    replay = await startLoopbackReplay(scenario, options.recordEvent);
    const startedAt = new Date();
    const started = Date.now();
    let lastOutput = started;
    renderer = createTerminalRenderer(
      scenario,
      options.temporaryRoot,
      () => terminal?.pid ?? -1,
      options.recordEvent,
    );
    checkpoints = new ProcessCheckpoints(scenario, started, options.before, {
      signal: options.signal,
      recordEvent: options.recordEvent,
    });
    shimReplay = await startCommandShimReplay(
      scenario,
      options.temporaryRoot,
      started,
      options.recordEvent,
    );
    terminal = spawn(scenario.executable, [...scenario.arguments], {
      cwd: scenario.working_directory,
      env: makeEnvironment({ ...options, replay, shimReplay }),
      cols: scenario.terminal.columns,
      rows: scenario.terminal.rows,
      name: "xterm-256color",
    });
    const framesTruncated = captureTerminalFrames({
      ...options,
      terminal,
      started,
      onOutput: () => (lastOutput = Date.now()),
      renderer,
      checkpoints,
    });
    scheduleScenarioInteractions({
      ...options,
      getTerminal: () => terminal,
      renderer,
      started,
    });
    const stopSampler = startProcessSampler({
      rootPid: terminal.pid,
      runId: options.runId,
      started,
      limit: scenario.limits.processes,
      samples: options.samples,
      recordEvent: options.recordEvent,
    });
    return {
      replay,
      renderer,
      checkpoints,
      shimReplay,
      terminal,
      started,
      startedAt,
      lastOutput: () => lastOutput,
      framesTruncated,
      stopSampler,
    };
  } catch (cause: unknown) {
    return cleanupFailedStartup({
      cause,
      timers: options.timers,
      replay,
      terminal,
      renderer,
      shimReplay,
      checkpoints,
      runId: options.runId,
      temporaryRoot: options.temporaryRoot,
    });
  }
};

const normalizedShimEvents = (
  runtime: StartedCaptureRuntime,
  scenario: ProcessScenario,
  temporaryRoot: string,
): ProcessCapture["shim_events"] =>
  runtime.shimReplay.events.map((event) => ({
    ...event,
    arguments: event.arguments.map((argument) =>
      normalizeProcessText(
        argument,
        scenario,
        temporaryRoot,
        runtime.terminal.pid,
      ),
    ),
    working_directory: normalizeProcessText(
      event.working_directory,
      scenario,
      temporaryRoot,
      runtime.terminal.pid,
    ),
  }));

const finishProcessRun = async (options: {
  readonly runtime: StartedCaptureRuntime | undefined;
  readonly timers: Set<NodeJS.Timeout>;
  readonly runId: string;
  readonly temporaryRoot: string;
  readonly samples: readonly ProcessSample[];
  readonly stopSampler: () => Promise<{ readonly partial: boolean }>;
  readonly capture: ProcessCapture | undefined;
  readonly executionFailure: unknown;
}): Promise<ProcessCapture> => {
  await options.stopSampler();
  const cleanupFailure = await releaseProcessResources({
    timers: options.timers,
    replay: options.runtime?.replay,
    terminal: options.runtime?.terminal,
    renderer: options.runtime?.renderer,
    shimReplay: options.runtime?.shimReplay,
    checkpoints: options.runtime?.checkpoints,
    runId: options.runId,
    temporaryRoot: options.temporaryRoot,
    capturedProcessGroupIds:
      options.runtime === undefined
        ? []
        : selectCapturedProcessGroupIds(
            options.runtime.terminal.pid,
            options.samples,
          ),
  });
  let { capture, executionFailure } = options;
  if (capture !== undefined) {
    capture = {
      ...capture,
      settlement: {
        ...capture.settlement,
        cleanup_outcome:
          capture.settlement.state === "quiesced"
            ? "not_required"
            : cleanupFailure === undefined
              ? "cleaned"
              : "failed",
      },
    };
    const issue = validateProcessCapture(capture)[0];
    if (issue !== undefined)
      executionFailure = new ProcessCaptureError(
        `process capture validation failed: ${issue.path}: ${issue.message}`,
      );
  }
  return resolveProcessResult(capture, executionFailure, cleanupFailure);
};

const completeCapture = async (options: {
  readonly scenario: ProcessScenario;
  readonly runtime: StartedCaptureRuntime;
  readonly runId: string;
  readonly temporaryRoot: string;
  readonly before: Awaited<ReturnType<typeof snapshotRoots>>;
  readonly frames: readonly TerminalFrame[];
  readonly samples: readonly ProcessSample[];
  readonly interactions: readonly InteractionEvent[];
  readonly exit: Awaited<ReturnType<typeof awaitTerminalExit>>;
  readonly signal?: AbortSignal;
  readonly initiallyTruncated: boolean;
  readonly eventJournal: readonly ProcessCaptureEventJournalEntry[];
  readonly recordEvent: RecordProcessCaptureEvent;
}): Promise<ProcessCapture> => {
  const { runtime, scenario } = options;
  runtime.checkpoints.trigger("root_exit");
  const { reason } = options.exit;
  if (reason === "cancelled") throw processCaptureCancelled();
  const settlement = await observeSettlement(
    options.runId,
    selectCapturedProcessGroupIds(runtime.terminal.pid, options.samples),
    scenario.settle_ms,
    options.recordEvent,
  );
  runtime.checkpoints.trigger("settled");
  const samplingPartial = (await runtime.stopSampler()).partial;
  assertNotCancelled(options.signal);
  const after = await snapshotRoots(scenario, options.signal);
  const renderedFrames = await runtime.renderer.frames();
  const checkpoints = await runtime.checkpoints.finish(after);
  await runtime.replay.close();
  const manifest = await createRunManifest(
    scenario,
    runtime.startedAt,
    new Date(),
  );
  const truncated =
    options.initiallyTruncated ||
    after.truncated ||
    runtime.replay.truncated ||
    runtime.shimReplay.truncated ||
    runtime.framesTruncated() ||
    checkpoints.some(({ truncated: partial }) => partial) ||
    samplingPartial ||
    runtime.renderer.truncated();
  return buildCaptureResult({
    frames: options.frames,
    exit: { ...options.exit, reason },
    samples: options.samples,
    replay: runtime.replay,
    before: options.before,
    after,
    truncated,
    scenario,
    rootPid: runtime.terminal.pid,
    samplingPartial,
    renderedFrames,
    interactions: options.interactions,
    checkpoints,
    shimEvents: normalizedShimEvents(runtime, scenario, options.temporaryRoot),
    settlement: { ...settlement, cleanup_outcome: "not_required" },
    manifest,
    eventJournal: options.eventJournal,
  });
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
  const { entries: eventJournal, recordEvent } = createProcessCaptureJournal();
  let runtime: StartedCaptureRuntime | undefined;
  const timers = new Set<NodeJS.Timeout>();
  let capture: ProcessCapture | undefined;
  let executionFailure: unknown;
  let stopSampler = async () => ({ partial: false });
  const interactions: InteractionEvent[] = [];
  const dispatchedEventIndexes = new Set<number>();

  try {
    runtime = await startCaptureRuntime({
      scenario,
      home,
      temporaryRoot,
      runId,
      before,
      frames,
      samples,
      interactions,
      timers,
      dispatchedEventIndexes,
      recordEvent,
      ...(signal === undefined ? {} : { signal }),
    });
    stopSampler = runtime.stopSampler;
    const exit = await awaitTerminalExit({
      terminal: runtime.terminal,
      scenario,
      started: runtime.started,
      lastOutput: runtime.lastOutput,
      signal,
      timers,
      interactions,
      dispatchedEventIndexes,
      recordEvent,
    });
    capture = await completeCapture({
      scenario,
      runtime,
      runId,
      temporaryRoot,
      before,
      frames,
      samples,
      interactions,
      exit,
      initiallyTruncated: before.truncated,
      eventJournal,
      recordEvent,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (cause: unknown) {
    runtime?.terminal.kill("SIGKILL");
    executionFailure = cause;
  }
  return finishProcessRun({
    runtime,
    timers,
    runId,
    temporaryRoot,
    samples,
    stopSampler,
    capture,
    executionFailure,
  });
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
