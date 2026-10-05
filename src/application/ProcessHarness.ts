import type { IPty } from "@lydell/node-pty";
import type {
  InteractionEvent,
  ProcessCapture,
  UnverifiedProcessCapture,
  ProcessCaptureEventJournalEntry,
  ProcessSample,
  ProcessScenario,
  RecordProcessCaptureEvent,
  TerminalFrame,
} from "../domain/processCapture.js";
import { parseProcessCapture } from "../domain/processCapture.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  AnalysisCapabilityUnavailableError,
  type AnalysisError,
} from "../domain/errors.js";
import {
  ProcessCaptureError,
  processCaptureCancelled,
} from "./ProcessCaptureError.js";
export { ProcessCaptureError } from "./ProcessCaptureError.js";
import { startProcessSampler } from "./ProcessSampling.js";
import { snapshotRoots } from "./FilesystemSnapshot.js";
import { TerminalRenderer } from "./TerminalRenderer.js";
import type { ProcessTimer } from "./ProcessTimer.js";
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
  settleProcessCaptureJournal,
  type PendingProcessCapture,
} from "./ProcessCaptureLifecycle.js";
import {
  assertNotCancelled,
  resolveProcessScenarioRuntimePaths,
} from "./ProcessScenarioRuntimeValidation.js";
import {
  createProcessCaptureJournal,
  scheduleScenarioInteractions,
} from "./ProcessCaptureJournal.js";
import { makeProcessCaptureEnvironment } from "./ProcessCaptureEnvironment.js";
import { classifyFilesystemEffects } from "./ProcessFilesystemEffects.js";
import { processCaptureOwnershipUnavailableReason } from "./ProcessCaptureCapability.js";
export { probeProcessCaptureCapability } from "./ProcessCaptureCapability.js";

interface StartedCaptureRuntime {
  readonly renderer: TerminalRenderer;
  readonly terminal: IPty;
  readonly started: number;
  readonly startedAt: Date;
  readonly lastOutput: () => number;
  readonly framesTruncated: () => boolean;
  readonly stopSampler: () => Promise<{ readonly partial: boolean }>;
}

const cleanupFailedStartup = async (options: {
  readonly cause: unknown;
  readonly timers: Set<ProcessTimer>;
  readonly terminal: IPty | undefined;
  readonly renderer: TerminalRenderer | undefined;
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
    maxBytes: scenario.limits.output_bytes,
    normalize: (value) =>
      normalizeProcessText(value, scenario, temporaryRoot, terminalPid()),
    recordEvent,
  });

interface StartCaptureRuntimeOptions {
  readonly scenario: ProcessScenario;
  readonly hostEnvironment: Readonly<Record<string, string | undefined>>;
  readonly temporaryRoot: string;
  readonly runId: string;
  readonly frames: TerminalFrame[];
  readonly samples: ProcessSample[];
  readonly interactions: InteractionEvent[];
  readonly timers: Set<ProcessTimer>;
  readonly dispatchedEventIndexes: Set<number>;
  readonly recordEvent: RecordProcessCaptureEvent;
  readonly signal?: AbortSignal;
}

const startCaptureRuntime = async (
  options: StartCaptureRuntimeOptions,
): Promise<StartedCaptureRuntime> => {
  const { scenario } = options;
  let renderer: TerminalRenderer | undefined;
  let terminal: IPty | undefined;
  try {
    const { spawn } = await import("@lydell/node-pty");
    const startedAt = new Date();
    const started = Date.now();
    let lastOutput = started;
    renderer = createTerminalRenderer(
      scenario,
      options.temporaryRoot,
      () => terminal?.pid ?? -1,
      options.recordEvent,
    );
    terminal = spawn(scenario.executable, [...scenario.arguments], {
      cwd: scenario.working_directory,
      env: makeProcessCaptureEnvironment(options),
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
      renderer,
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
      terminal,
      renderer,
      runId: options.runId,
      temporaryRoot: options.temporaryRoot,
    });
  }
};

const finishProcessRun = async (options: {
  readonly runtime: StartedCaptureRuntime | undefined;
  readonly timers: Set<ProcessTimer>;
  readonly runId: string;
  readonly temporaryRoot: string;
  readonly samples: readonly ProcessSample[];
  readonly stopSampler: () => Promise<{ readonly partial: boolean }>;
  readonly capture: PendingProcessCapture | undefined;
  readonly executionFailure: unknown;
}): Promise<ProcessCapture> => {
  await options.stopSampler();
  const cleanupFailure = await releaseProcessResources({
    timers: options.timers,
    terminal: options.runtime?.terminal,
    renderer: options.runtime?.renderer,
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
  let verifiedCapture: ProcessCapture | undefined;
  if (capture !== undefined && cleanupFailure === undefined) {
    const settlement: UnverifiedProcessCapture["settlement"] =
      capture.settlement.state === "quiesced"
        ? { ...capture.settlement, cleanup_outcome: "not_required" }
        : { ...capture.settlement, cleanup_outcome: "cleaned" };
    const completedCapture: UnverifiedProcessCapture = {
      ...capture,
      settlement,
      cleanup: {
        owned_process_group: "verified",
        temporary_root: "removed",
      },
    };
    try {
      verifiedCapture = parseProcessCapture(completedCapture);
    } catch (cause: unknown) {
      executionFailure = new ProcessCaptureError(
        `process capture validation failed${cause instanceof Error ? `: ${cause.message}` : ""}`,
        { cause },
      );
    }
  }
  return resolveProcessResult(
    verifiedCapture,
    executionFailure,
    cleanupFailure,
  );
};

const completeCapture = async (options: {
  readonly scenario: ProcessScenario;
  readonly hostPlatform: NodeJS.Platform;
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
}): Promise<PendingProcessCapture> => {
  const { runtime, scenario } = options;
  const { reason } = options.exit;
  if (reason === "cancelled") throw processCaptureCancelled();
  const settlement = await observeSettlement(
    options.runId,
    selectCapturedProcessGroupIds(runtime.terminal.pid, options.samples),
    scenario.settle_ms,
    options.recordEvent,
    options.hostPlatform,
  );
  const samplingPartial = (await runtime.stopSampler()).partial;
  await settleProcessCaptureJournal(options.eventJournal);
  assertNotCancelled(options.signal);
  const after = await snapshotRoots(scenario, options.signal);
  options.recordEvent("filesystem_checkpoints", 1);
  const renderedFrames = await runtime.renderer.frames();
  const checkpoints: UnverifiedProcessCapture["filesystem_checkpoints"] = [
    {
      name: "before",
      at_ms: 0,
      files: options.before.files,
      effects: [],
      truncated: options.before.truncated,
    },
    {
      name: "after_settlement",
      at_ms: Math.max(0, Date.now() - runtime.started),
      files: after.files,
      effects: classifyFilesystemEffects(options.before.files, after.files),
      truncated: after.truncated,
    },
  ];
  const manifest = await createRunManifest(
    scenario,
    runtime.startedAt,
    new Date(),
    { platform: options.hostPlatform, architecture: process.arch },
  );
  const truncated =
    options.initiallyTruncated ||
    after.truncated ||
    runtime.framesTruncated() ||
    checkpoints.some(({ truncated: partial }) => partial) ||
    samplingPartial ||
    runtime.renderer.truncated();
  return buildCaptureResult({
    frames: options.frames,
    exit: { ...options.exit, reason },
    samples: options.samples,
    before: options.before,
    after,
    truncated,
    scenario,
    rootPid: runtime.terminal.pid,
    samplingPartial,
    renderedFrames,
    interactions: options.interactions,
    checkpoints,
    settlement,
    manifest,
    eventJournal: options.eventJournal,
  });
};

/** Execute one caller-selected scenario and return bounded observations. */
const runProcessScenario = async (
  scenario: ProcessScenario,
  signal?: AbortSignal,
  hostEnvironment: Readonly<Record<string, string | undefined>> = process.env,
  hostPlatform: NodeJS.Platform = process.platform,
): Promise<ProcessCapture> => {
  const { temporaryRoot, runId, before } = await prepareProcessCapture(
    scenario,
    signal,
  );
  const frames: TerminalFrame[] = [];
  const samples: ProcessSample[] = [];
  const journal = createProcessCaptureJournal();
  const { entries: eventJournal, recordEvent } = journal;
  recordEvent("filesystem_checkpoints", 0);
  let runtime: StartedCaptureRuntime | undefined;
  const timers = new Set<ProcessTimer>();
  let capture: PendingProcessCapture | undefined;
  let executionFailure: unknown;
  let stopSampler = async () => ({ partial: false });
  const interactions: InteractionEvent[] = [];
  const dispatchedEventIndexes = new Set<number>();

  try {
    runtime = await startCaptureRuntime({
      scenario,
      hostEnvironment,
      temporaryRoot,
      runId,
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
      hostPlatform,
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
  signal?: AbortSignal,
  platform: NodeJS.Platform = process.platform,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<Result<ProcessCapture, ProcessCaptureError | AnalysisError>> => {
  const ownershipReason = processCaptureOwnershipUnavailableReason(platform);
  if (ownershipReason !== undefined)
    return err(
      new AnalysisCapabilityUnavailableError(
        "rea-process",
        "capture_process_scenario",
        ownershipReason,
      ),
    );
  try {
    assertNotCancelled(signal);
    const resolvedScenario = await resolveProcessScenarioRuntimePaths(
      scenario,
      environment,
    );
    return ok(
      await runProcessScenario(resolvedScenario, signal, environment, platform),
    );
  } catch (cause: unknown) {
    return err(
      cause instanceof ProcessCaptureError
        ? cause
        : new ProcessCaptureError("process capture failed", { cause }),
    );
  }
};
