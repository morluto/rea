import { spawn, type IPty } from "node-pty";
import type {
  InteractionEvent,
  ProcessCapture,
  ProcessExecutionPolicy,
  ProcessSample,
  ProcessScenario,
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

interface ScenarioEventOptions {
  readonly scenario: ProcessScenario;
  readonly getTerminal: () => IPty | undefined;
  readonly timers: Set<NodeJS.Timeout>;
  readonly interactions: InteractionEvent[];
  readonly renderer: TerminalRenderer;
  readonly started: number;
  readonly dispatchedEventIndexes: Set<number>;
}

const scheduleScenarioEvents = (options: ScenarioEventOptions): void => {
  const { scenario, getTerminal, timers, interactions, renderer, started } =
    options;
  for (const [eventIndex, event] of scenario.events.entries()) {
    const timer = setTimeout(() => {
      options.dispatchedEventIndexes.add(eventIndex);
      const terminal = getTerminal();
      const dispatchedAt = Math.max(0, Date.now() - started);
      let outcome: InteractionEvent["outcome"] = "dispatched";
      if (terminal === undefined) outcome = "target_exited";
      else {
        try {
          if (event.type === "input") terminal.write(event.data);
          else if (event.type === "resize") {
            terminal.resize(event.columns, event.rows);
            renderer.resize(event.columns, event.rows, dispatchedAt);
          } else terminal.kill(event.signal);
        } catch {
          outcome = "failed";
        }
      }
      interactions.push({
        sequence: interactions.length,
        scheduled_at_ms: event.at_ms,
        dispatched_at_ms: dispatchedAt,
        type: event.type,
        data:
          event.type === "input"
            ? event.sensitive
              ? `<redacted-input:${String(Buffer.byteLength(event.data))}-bytes>`
              : normalizeProcessText(
                  event.data,
                  scenario,
                  "<no-temporary-root>",
                  -1,
                )
            : event.type === "resize"
              ? `${String(event.columns)}x${String(event.rows)}`
              : event.signal,
        outcome,
      });
    }, event.at_ms);
    timers.add(timer);
  }
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
    sampledProcessGroupIds: [],
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
): TerminalRenderer =>
  new TerminalRenderer({
    columns: scenario.terminal.columns,
    rows: scenario.terminal.rows,
    scrollback: scenario.terminal.scrollback,
    maxFrames: scenario.limits.frames,
    maxBytes: scenario.limits.output_bytes,
    normalize: (value) =>
      normalizeProcessText(value, scenario, temporaryRoot, terminalPid()),
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
  readonly signal?: AbortSignal;
}): Promise<StartedCaptureRuntime> => {
  const { scenario } = options;
  let replay: LoopbackReplay | undefined;
  let renderer: TerminalRenderer | undefined;
  let checkpoints: ProcessCheckpoints | undefined;
  let shimReplay: CommandShimReplay | undefined;
  let terminal: IPty | undefined;
  try {
    replay = await startLoopbackReplay(scenario);
    const startedAt = new Date();
    const started = Date.now();
    let lastOutput = started;
    renderer = createTerminalRenderer(
      scenario,
      options.temporaryRoot,
      () => terminal?.pid ?? -1,
    );
    checkpoints = new ProcessCheckpoints(
      scenario,
      started,
      options.before,
      options.signal,
    );
    shimReplay = await startCommandShimReplay(
      scenario,
      options.temporaryRoot,
      started,
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
    scheduleScenarioEvents({
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
    sampledProcessGroupIds: options.samples.flatMap(({ process_group_id }) =>
      process_group_id === null ? [] : [process_group_id],
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
}): Promise<ProcessCapture> => {
  const { runtime, scenario } = options;
  runtime.checkpoints.trigger("root_exit");
  const { reason } = options.exit;
  if (reason === "cancelled") throw processCaptureCancelled();
  const settlement = await observeSettlement(
    options.runId,
    [
      runtime.terminal.pid,
      ...options.samples.flatMap(({ process_group_id }) =>
        process_group_id === null ? [] : [process_group_id],
      ),
    ],
    scenario.settle_ms,
  );
  runtime.checkpoints.trigger("settled");
  const samplingPartial = (await runtime.stopSampler()).partial;
  assertNotCancelled(options.signal);
  const after = await snapshotRoots(scenario, options.signal);
  const renderedFrames = await runtime.renderer.frames();
  const checkpoints = await runtime.checkpoints.finish(after);
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
