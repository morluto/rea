import type { IPty } from "@lydell/node-pty";
import type { TerminalRetention } from "../../domain/process/processCaptureCoverage.js";
import type { ProcessCapture } from "../../domain/process/processCaptureParsing.js";
import type { ProcessScenario } from "../../domain/process/processScenario.js";
import { parseProcessCapture } from "../../domain/process/processCaptureParsing.js";
import { err, ok, type Result } from "../../domain/result.js";
import { AnalysisCapabilityUnavailableError } from "../../domain/analysisErrorCore.js";
import { type AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  describeProcessCaptureExecutionFailure,
  ProcessCaptureError,
  normalizeCaptureFailure,
  processCaptureCancelled,
} from "./ProcessCaptureError.js";
import type {
  InteractionEvent,
  UnverifiedProcessCapture,
  ProcessCaptureEventJournalEntry,
  ProcessSample,
  RecordProcessCaptureEvent,
  TerminalFrame,
} from "../../domain/process/processCapture.js";
import { startProcessSampler } from "./ProcessSampling.js";
import { snapshotRoots } from "./FilesystemSnapshot.js";
import { TerminalRenderer } from "./TerminalRenderer.js";
import type { ProcessTimer } from "./ProcessTimer.js";
import { normalizeProcessText } from "./ProcessNormalization.js";
import { selectCapturedProcessGroupIds } from "../ProcessOwnershipProcessTree.js";
import {
  awaitTerminalExit,
  buildCaptureResult,
  cleanupReportFailure,
  captureTerminalFrames,
  createProcessCaptureObservationBuffer,
  createRunManifest,
  observeLaunchedExecutable,
  observeSelectedExecutable,
  observeSettlement,
  prepareProcessCapture,
  releaseProcessResources,
  resolveProcessResult,
  settleProcessCaptureJournal,
  type ProcessCaptureCleanupHost,
  type ProcessCaptureObservationBuffer,
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
import {
  createProcessCaptureProgressTracker,
  type ProcessCaptureProgress,
  type ProcessCaptureProgressCounts,
  type ProcessCaptureProgressDisposition,
  type ProcessCaptureProgressTracker,
} from "./ProcessCaptureProgress.js";
import type { ProcessOwnershipBaseline } from "../ProcessOwnership.js";

interface StartedCaptureRuntime {
  readonly renderer: TerminalRenderer;
  readonly terminal: IPty;
  readonly started: number;
  readonly startedAt: Date;
  readonly executableIdentity: ReturnType<typeof observeLaunchedExecutable>;
  readonly lastOutput: () => number;
  readonly rawTerminalRetention: () => TerminalRetention;
  readonly stopSampler: ReturnType<typeof startProcessSampler>;
}

const cleanupFailedStartup = async (options: {
  readonly cause: unknown;
  readonly timers: Set<ProcessTimer>;
  readonly terminal: IPty | undefined;
  readonly renderer: TerminalRenderer | undefined;
  readonly runId: string;
  readonly captureBaseline: ProcessOwnershipBaseline;
  readonly scenario: ProcessScenario;
  readonly cleanupHost?: ProcessCaptureCleanupHost;
  readonly observations?: ProcessCaptureObservationBuffer;
  readonly temporaryRoot: string;
}): Promise<never> => {
  const sampledProcessGroupIds =
    options.terminal !== undefined &&
    options.observations?.process_samples.state === "available"
      ? selectCapturedProcessGroupIds(
          options.terminal.pid,
          options.observations.process_samples.value,
        ).filter((groupId) => groupId !== options.terminal?.pid)
      : undefined;
  if (options.observations !== undefined && options.renderer !== undefined) {
    try {
      options.observations.rendered_frames = {
        state: "available",
        value: await options.renderer.frames(),
      };
    } catch (cause: unknown) {
      options.observations.rendered_frames = {
        state: "unavailable",
        reason: `Rendered terminal frame collection failed: ${cause instanceof Error ? cause.message : "unknown failure"}`,
      };
    }
  }
  const cleanupFailure = await releaseProcessResources({
    timers: options.timers,
    terminal: options.terminal,
    renderer: options.renderer,
    runId: options.runId,
    captureBaseline: options.captureBaseline,
    ...(sampledProcessGroupIds === undefined ? {} : { sampledProcessGroupIds }),
    temporaryRoot: options.temporaryRoot,
    ...(options.cleanupHost === undefined ? {} : { host: options.cleanupHost }),
  });
  if (cleanupReportFailure(cleanupFailure) !== undefined) {
    resolveProcessResult(
      undefined,
      options.cause,
      cleanupFailure,
      options.observations,
      {
        scenario: options.scenario,
        ...(options.terminal === undefined
          ? {}
          : { rootPid: options.terminal.pid }),
      },
    );
  }
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
  readonly ownershipBaseline: ProcessOwnershipBaseline;
  readonly cleanupHost?: ProcessCaptureCleanupHost;
  readonly observationBuffer: ProcessCaptureObservationBuffer;
  readonly onSpawn: (pid: number) => void;
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
    const selectedExecutable = await observeSelectedExecutable(
      scenario.executable,
      options.signal,
    );
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
    options.onSpawn(terminal.pid);
    options.observationBuffer.target_pid = {
      state: "available",
      value: scenario.normalization.pids ? 1 : terminal.pid,
    };
    const executableIdentity = observeLaunchedExecutable(
      scenario.executable,
      selectedExecutable,
    );
    const rawTerminalRetention = captureTerminalFrames({
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
      executableIdentity,
      lastOutput: () => lastOutput,
      rawTerminalRetention,
      stopSampler,
    };
  } catch (cause: unknown) {
    return cleanupFailedStartup({
      cause,
      timers: options.timers,
      terminal,
      renderer,
      runId: options.runId,
      captureBaseline: options.ownershipBaseline,
      scenario,
      ...(options.cleanupHost === undefined
        ? {}
        : { cleanupHost: options.cleanupHost }),
      observations: options.observationBuffer,
      temporaryRoot: options.temporaryRoot,
    });
  }
};

const finishProcessRun = async (options: {
  readonly runtime: StartedCaptureRuntime | undefined;
  readonly timers: Set<ProcessTimer>;
  readonly runId: string;
  readonly captureBaseline: ProcessOwnershipBaseline;
  readonly cleanupHost?: ProcessCaptureCleanupHost;
  readonly temporaryRoot: string;
  readonly scenario: ProcessScenario;
  readonly samples: readonly ProcessSample[];
  readonly stopSampler: () => Promise<{ readonly partial: boolean }>;
  readonly capture: PendingProcessCapture | undefined;
  readonly executionFailure: unknown;
  readonly observations?: ProcessCaptureObservationBuffer;
  readonly rootPid?: number;
  readonly progress: ProcessCaptureProgressTracker;
  readonly progressCounts: () => ProcessCaptureProgressCounts;
}): Promise<ProcessCapture> => {
  options.progress.closeLive();
  await options.stopSampler();
  const sampledProcessGroupIds =
    options.runtime === undefined
      ? undefined
      : selectCapturedProcessGroupIds(
          options.runtime.terminal.pid,
          options.samples,
        ).filter((groupId) => groupId !== options.runtime?.terminal.pid);
  const cleanup = await releaseProcessResources({
    timers: options.timers,
    terminal: options.runtime?.terminal,
    renderer: options.runtime?.renderer,
    runId: options.runId,
    captureBaseline: options.captureBaseline,
    ...(sampledProcessGroupIds === undefined ? {} : { sampledProcessGroupIds }),
    temporaryRoot: options.temporaryRoot,
    ...(options.cleanupHost === undefined ? {} : { host: options.cleanupHost }),
  });
  const observedExit =
    options.observations?.exit.state === "available"
      ? options.observations.exit.value.reason
      : options.capture?.exit.reason;
  await options.progress.report({
    phase: "cleanup",
    counts: options.progressCounts(),
    terminal: true,
    disposition: captureProgressDisposition(
      observedExit,
      options.executionFailure,
    ),
    cleanup,
  });
  const cleanupFailure = cleanupReportFailure(cleanup);
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
  const rootPid = options.runtime?.terminal.pid ?? options.rootPid;
  const partialContext =
    rootPid === undefined
      ? { scenario: options.scenario }
      : { scenario: options.scenario, rootPid };
  return resolveProcessResult(
    cleanupFailure === undefined ? verifiedCapture : capture,
    executionFailure,
    cleanup,
    options.observations,
    partialContext,
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
  readonly captureSnapshot: typeof snapshotRoots;
  readonly eventJournal: readonly ProcessCaptureEventJournalEntry[];
  readonly observationBuffer: ProcessCaptureObservationBuffer;
  readonly recordEvent: RecordProcessCaptureEvent;
  readonly onLiveProgress?: () => void;
}): Promise<PendingProcessCapture> => {
  const unavailableReason = (stage: string, cause: unknown): string =>
    `${stage} failed: ${cause instanceof Error ? cause.message : "unknown failure"}`;
  const { runtime, scenario } = options;
  const { reason } = options.exit;
  if (reason === "cancelled") throw processCaptureCancelled();
  let settlement: Awaited<ReturnType<typeof observeSettlement>>;
  try {
    settlement = await observeSettlement(
      options.runId,
      selectCapturedProcessGroupIds(runtime.terminal.pid, options.samples),
      scenario.settle_ms,
      options.recordEvent,
      options.hostPlatform,
      options.signal,
      options.onLiveProgress,
    );
  } catch (cause: unknown) {
    options.observationBuffer.settlement = {
      state: "unavailable",
      reason: unavailableReason("Process settlement observation", cause),
    };
    throw cause;
  }
  options.observationBuffer.settlement = {
    state: "available",
    value: settlement,
  };
  const sampling = await runtime.stopSampler();
  const samplingPartial = sampling.partial;
  await settleProcessCaptureJournal(options.eventJournal);
  assertNotCancelled(options.signal);
  let after: Awaited<ReturnType<typeof snapshotRoots>>;
  try {
    after = await options.captureSnapshot(scenario, options.signal);
  } catch (cause: unknown) {
    options.observationBuffer.filesystem_snapshots = {
      ...options.observationBuffer.filesystem_snapshots,
      after: {
        state: "unavailable",
        reason: unavailableReason("Final filesystem snapshot", cause),
      },
    };
    throw cause;
  }
  options.observationBuffer.filesystem_snapshots = {
    ...options.observationBuffer.filesystem_snapshots,
    after: {
      state: "available",
      value: after,
    },
  };
  options.recordEvent("filesystem_checkpoints", 1);
  let renderedFrames: Awaited<ReturnType<TerminalRenderer["frames"]>>;
  try {
    renderedFrames = await runtime.renderer.frames();
  } catch (cause: unknown) {
    options.observationBuffer.rendered_frames = {
      state: "unavailable",
      reason: unavailableReason("Rendered terminal frame collection", cause),
    };
    throw cause;
  }
  options.observationBuffer.rendered_frames = {
    state: "available",
    value: renderedFrames,
  };
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
      effects: classifyFilesystemEffects(options.before, after),
      truncated: after.truncated,
    },
  ];
  let manifest: Awaited<ReturnType<typeof createRunManifest>>;
  try {
    manifest = await createRunManifest(
      scenario,
      runtime.startedAt,
      new Date(),
      runtime.executableIdentity,
      { platform: options.hostPlatform, architecture: process.arch },
    );
  } catch (cause: unknown) {
    options.observationBuffer.manifest = {
      state: "unavailable",
      reason: unavailableReason("Capture manifest creation", cause),
    };
    throw cause;
  }
  options.observationBuffer.manifest = { state: "available", value: manifest };
  return buildCaptureResult({
    frames: options.frames,
    exit: { ...options.exit, reason },
    samples: options.samples,
    before: options.before,
    after,
    truncationDetails: {
      raw_terminal: runtime.rawTerminalRetention(),
      rendered_terminal: runtime.renderer.retention(),
      filesystem_before: options.before.coverage,
      filesystem_after: after.coverage,
      process: sampling.coverage,
    },
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

const captureProgressDisposition = (
  exitReason: string | undefined,
  executionFailure: unknown,
): ProcessCaptureProgressDisposition => {
  if (
    exitReason === "exited" ||
    exitReason === "timeout" ||
    exitReason === "idle_timeout" ||
    exitReason === "cancelled"
  )
    return exitReason;
  if (
    executionFailure instanceof ProcessCaptureError &&
    executionFailure.reason === "cancelled"
  )
    return "cancelled";
  return "failed";
};

/** Execute one caller-selected scenario and return bounded observations. */
const runProcessScenario = async (
  scenario: ProcessScenario,
  signal?: AbortSignal,
  hostEnvironment: Readonly<Record<string, string | undefined>> = process.env,
  hostPlatform: NodeJS.Platform = process.platform,
  captureSnapshot: typeof snapshotRoots = snapshotRoots,
  cleanupHost?: ProcessCaptureCleanupHost,
  progress?: ProcessCaptureProgress,
): Promise<ProcessCapture> => {
  const progressTracker = createProcessCaptureProgressTracker(progress);
  const frames: TerminalFrame[] = [];
  const samples: ProcessSample[] = [];
  const interactions: InteractionEvent[] = [];
  const progressCounts = (): ProcessCaptureProgressCounts => ({
    frames: frames.length,
    samples: samples.length,
    interactions: interactions.length,
  });
  const reportRunning = () => {
    void progressTracker.report({ phase: "running", counts: progressCounts() });
  };
  const reportSettling = () => {
    void progressTracker.report({
      phase: "settling",
      counts: progressCounts(),
    });
  };
  let prepared: Awaited<ReturnType<typeof prepareProcessCapture>>;
  try {
    await progressTracker.report({
      phase: "prepare",
      counts: progressCounts(),
    });
    prepared = await prepareProcessCapture(scenario, signal, captureSnapshot);
  } catch (cause: unknown) {
    progressTracker.closeLive();
    await progressTracker.report({
      phase: "cleanup",
      counts: progressCounts(),
      terminal: true,
      disposition: signal?.aborted === true ? "cancelled" : "failed",
    });
    throw cause;
  }
  const { temporaryRoot, runId, ownershipBaseline, before } = prepared;
  const journal = createProcessCaptureJournal();
  const { entries: eventJournal, recordEvent } = journal;
  recordEvent("filesystem_checkpoints", 0);
  const observations = createProcessCaptureObservationBuffer({
    frames,
    interactions,
    samples,
    eventJournal,
    before,
  });
  let runtime: StartedCaptureRuntime | undefined;
  let actualRootPid: number | undefined;
  const timers = new Set<ProcessTimer>();
  let capture: PendingProcessCapture | undefined;
  let executionFailure: unknown;
  let stopSampler = async () => ({ partial: false });
  const dispatchedEventIndexes = new Set<number>();

  try {
    runtime = await startCaptureRuntime({
      scenario,
      hostEnvironment,
      temporaryRoot,
      runId,
      ownershipBaseline,
      ...(cleanupHost === undefined ? {} : { cleanupHost }),
      observationBuffer: observations,
      onSpawn: (pid) => {
        actualRootPid = pid;
      },
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
      ...(progress === undefined ? {} : { onLiveProgress: reportRunning }),
    });
    observations.exit = {
      state: "available",
      value: {
        code:
          exit.reason === "exited" && exit.exitCode >= 0 ? exit.exitCode : null,
        signal: exit.signal ?? null,
        reason: exit.reason,
      },
    };
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
      eventJournal,
      observationBuffer: observations,
      recordEvent,
      captureSnapshot,
      ...(signal === undefined ? {} : { signal }),
      ...(progress === undefined ? {} : { onLiveProgress: reportSettling }),
    });
  } catch (cause: unknown) {
    executionFailure = normalizeCaptureFailure(cause, signal);
    if (
      runtime !== undefined &&
      observations.rendered_frames.state === "unavailable" &&
      observations.rendered_frames.reason.startsWith(
        "Rendered terminal frames were not collected",
      )
    ) {
      try {
        observations.rendered_frames = {
          state: "available",
          value: await runtime.renderer.frames(),
        };
      } catch (renderCause: unknown) {
        const renderFailure =
          renderCause instanceof Error
            ? renderCause.message
            : "unknown failure";
        observations.rendered_frames = {
          state: "unavailable",
          reason: `Rendered terminal frame collection failed: ${renderFailure}`,
        };
      }
    }
  }
  return finishProcessRun({
    runtime,
    timers,
    runId,
    captureBaseline: ownershipBaseline,
    ...(cleanupHost === undefined ? {} : { cleanupHost }),
    temporaryRoot,
    scenario,
    samples,
    stopSampler,
    capture,
    executionFailure,
    observations,
    ...(actualRootPid === undefined ? {} : { rootPid: actualRootPid }),
    progress: progressTracker,
    progressCounts,
  });
};

/** Execute one scenario through a typed expected-failure channel. */
export const captureProcessScenario = async (
  scenario: ProcessScenario,
  signal?: AbortSignal,
  platform: NodeJS.Platform = process.platform,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  captureSnapshot?: typeof snapshotRoots,
  cleanupHost?: ProcessCaptureCleanupHost,
  progress?: ProcessCaptureProgress,
): Promise<Result<ProcessCapture, ProcessCaptureError | AnalysisError>> => {
  const ownershipReason = processCaptureOwnershipUnavailableReason(platform);
  if (ownershipReason !== undefined)
    return err(
      new AnalysisCapabilityUnavailableError(
        "rea-process",
        "capture_process_scenario",
        ownershipReason,
        { userMessage: ownershipReason },
      ),
    );
  try {
    assertNotCancelled(signal);
    const resolvedScenario = await resolveProcessScenarioRuntimePaths(
      scenario,
      environment,
    );
    return ok(
      await runProcessScenario(
        resolvedScenario,
        signal,
        environment,
        platform,
        captureSnapshot ?? snapshotRoots,
        cleanupHost,
        progress,
      ),
    );
  } catch (cause: unknown) {
    const failure = normalizeCaptureFailure(cause, signal);
    const executionFailureReason =
      describeProcessCaptureExecutionFailure(cause);
    return err(
      failure instanceof ProcessCaptureError
        ? failure
        : new ProcessCaptureError("process capture failed", {
            cause,
            ...(executionFailureReason === undefined
              ? {}
              : { executionFailure: executionFailureReason }),
          }),
    );
  }
};
