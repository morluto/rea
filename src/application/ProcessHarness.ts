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
import {
  normalizeProcessShimEvent,
  normalizeProcessText,
} from "./ProcessNormalization.js";
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
  type ProcessCaptureJournal,
} from "./ProcessCaptureJournal.js";
import {
  assertSupportedReactiveScenario,
  projectProcessReactiveRun,
  startProcessReactiveHarness,
  type ProcessReactiveHarness,
} from "./ProcessReactiveHarness.js";
import { makeProcessCaptureEnvironment } from "./ProcessCaptureEnvironment.js";
export { probeProcessCaptureCapability } from "./ProcessCaptureCapability.js";

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
  readonly reactive: ProcessReactiveHarness | undefined;
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

interface StartCaptureRuntimeOptions {
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
  readonly journal: ProcessCaptureJournal;
  readonly signal?: AbortSignal;
}

const reactiveCapture = (
  options: StartCaptureRuntimeOptions,
  protocolEvents: () => LoopbackReplay["events"],
): Parameters<typeof startProcessReactiveHarness>[0]["capture"] => ({
  ...options,
  processSamples: options.samples,
  protocolEvents,
});

const startCaptureRuntime = async (
  options: StartCaptureRuntimeOptions,
): Promise<StartedCaptureRuntime> => {
  const { scenario } = options;
  let replay: LoopbackReplay | undefined;
  let renderer: TerminalRenderer | undefined;
  let checkpoints: ProcessCheckpoints | undefined;
  let shimReplay: CommandShimReplay | undefined;
  let terminal: IPty | undefined;
  let reactive: ProcessReactiveHarness | undefined;
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
      env: makeProcessCaptureEnvironment({ ...options, replay, shimReplay }),
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
    reactive = startProcessReactiveHarness({
      capture: reactiveCapture(options, () => replay?.events ?? []),
      scenario,
      terminal: () => terminal,
      renderer,
      checkpoints,
      shimReplay,
      started,
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
      reactive,
    };
  } catch (cause: unknown) {
    reactive?.unsubscribe();
    await reactive?.coordinator.close();
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
  runtime.shimReplay.events.map((event) =>
    normalizeProcessShimEvent(
      event,
      scenario,
      temporaryRoot,
      runtime.terminal.pid,
    ),
  );

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
  options.runtime?.reactive?.unsubscribe();
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
  if (cleanupFailure !== undefined)
    await options.runtime?.reactive?.coordinator.submit({
      kind: "cleanup_failed",
    });
  await options.runtime?.reactive?.coordinator.close();
  let { capture, executionFailure } = options;
  if (capture !== undefined) {
    capture = {
      ...capture,
      reactive_run: projectProcessReactiveRun(options.runtime?.reactive),
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
  if (reason === "cancelled") {
    if (runtime.reactive !== undefined) {
      await runtime.reactive.coordinator.submit({ kind: "cancelled" });
      runtime.reactive.unsubscribe();
    }
    throw processCaptureCancelled();
  }
  if (runtime.reactive !== undefined) {
    await runtime.reactive.coordinator.submit({ kind: "target_lost" });
    runtime.reactive.unsubscribe();
  }
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
    reactiveRun: projectProcessReactiveRun(runtime.reactive),
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
  assertSupportedReactiveScenario(scenario);
  const { temporaryRoot, runId, home, before } = await prepareProcessCapture(
    scenario,
    policy,
    signal,
  );
  const frames: TerminalFrame[] = [];
  const samples: ProcessSample[] = [];
  const journal = createProcessCaptureJournal();
  const { entries: eventJournal, recordEvent } = journal;
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
      journal,
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
