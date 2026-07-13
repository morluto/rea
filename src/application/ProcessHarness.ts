import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type IPty } from "node-pty";
import type {
  FilesystemCheckpoint,
  InteractionEvent,
  ProcessCapture,
  ProcessExecutionPolicy,
  ProcessSample,
  ProcessScenario,
  TerminalFrame,
} from "../domain/processCapture.js";
import {
  authorizeProcessScenario,
  digestProcessCommitment,
  processComparisonContract,
  processScenarioCommitment,
  validateProcessCapture,
} from "../domain/processCapture.js";
import { err, ok, type Result } from "../domain/result.js";
import { AnalysisError } from "../domain/errors.js";
import { PRODUCT_IDENTITY } from "../identity.js";
import { startLoopbackReplay, type LoopbackReplay } from "./LoopbackReplay.js";
import {
  cleanupOwnedProcessGroup,
  observeOwnedProcessGroup,
} from "./ProcessOwnership.js";
import { startProcessSampler } from "./ProcessSampling.js";
import { snapshotRoots, type SnapshotResult } from "./FilesystemSnapshot.js";
import {
  classifyFilesystemEffects,
  ProcessCheckpoints,
} from "./ProcessCheckpoints.js";
import { TerminalRenderer } from "./TerminalRenderer.js";
import {
  startCommandShimReplay,
  type CommandShimReplay,
} from "./CommandShimReplay.js";
import {
  normalizeProcessSamples,
  normalizeProcessText,
  redactProtocolEvents,
} from "./ProcessNormalization.js";
import { PROCESS_PROVIDER } from "./ProcessEvidence.js";

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

const startScenarioEvents = (options: ScenarioEventOptions): (() => void) => {
  let eventsStarted = false;
  return () => {
    if (eventsStarted) return;
    eventsStarted = true;
    scheduleScenarioEvents(options);
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
  readonly interactions: InteractionEvent[];
  readonly dispatchedEventIndexes: ReadonlySet<number>;
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
  readonly renderedFrames: ProcessCapture["rendered_frames"];
  readonly interactions: readonly InteractionEvent[];
  readonly checkpoints: readonly FilesystemCheckpoint[];
  readonly shimEvents: ProcessCapture["shim_events"];
  readonly settlement: ProcessCapture["settlement"];
  readonly manifest: ProcessCapture["manifest"];
}

const buildCaptureResult = (options: CaptureResultOptions): ProcessCapture => ({
  schema_version: 4,
  manifest: options.manifest,
  normalization: options.scenario.normalization,
  frames: options.frames,
  rendered_frames: [...options.renderedFrames]
    .sort(
      (left, right) =>
        left.at_ms - right.at_ms || left.sequence - right.sequence,
    )
    .map((frame, sequence) => ({ ...frame, sequence })),
  interaction_events: options.interactions,
  exit: {
    code:
      options.exit.reason === "exited" && options.exit.exitCode >= 0
        ? options.exit.exitCode
        : null,
    signal: options.exit.signal ?? null,
    reason: options.exit.reason,
  },
  settlement: options.settlement,
  process_samples: normalizeProcessSamples(
    options.samples,
    options.scenario,
    options.rootPid,
  ),
  filesystem_checkpoints: options.checkpoints,
  shim_events: options.shimEvents,
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

const hashFile = async (path: string): Promise<string> => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
};

const createRunManifest = async (
  scenario: ProcessScenario,
  startedAt: Date,
  completedAt: Date,
): Promise<ProcessCapture["manifest"]> => {
  const executableSha256 = await hashFile(scenario.executable);
  const scenarioCommitment = processScenarioCommitment(
    scenario,
    executableSha256,
  );
  const comparisonContract = processComparisonContract(scenario);
  return {
    rea_version: PRODUCT_IDENTITY.packageVersion,
    provider_version: PROCESS_PROVIDER.version,
    platform: process.platform,
    architecture: process.arch,
    pty_backend: "node-pty",
    started_at: startedAt.toISOString(),
    completed_at: completedAt.toISOString(),
    scenario: scenarioCommitment,
    comparison_contract: comparisonContract,
    shim_plan: scenario.command_shims,
    replay_plan: scenario.replay,
    full_scenario_sha256: digestProcessCommitment(scenarioCommitment),
    comparison_contract_sha256: digestProcessCommitment(comparisonContract),
    executable_sha256: executableSha256,
    normalization_sha256: digestProcessCommitment(scenario.normalization),
    shim_plan_sha256: digestProcessCommitment(scenario.command_shims),
    replay_plan_sha256: digestProcessCommitment(scenario.replay),
  };
};

const observeSettlement = async (
  runId: string,
  processGroupIds: readonly number[],
  settleMs: number,
): Promise<Omit<ProcessCapture["settlement"], "cleanup_outcome">> => {
  if (process.platform === "win32")
    return { state: "unverifiable", elapsed_ms: 0 };
  const started = Date.now();
  let consecutiveEmpty = 0;
  let deadlineReached = false;
  while (!deadlineReached) {
    const observations = await Promise.all(
      [...new Set(processGroupIds)].map((processGroupId) =>
        observeOwnedProcessGroup({
          runId,
          leaderPid: processGroupId,
          processGroupId,
        }),
      ),
    );
    if (observations.some(({ state }) => state === "unverifiable"))
      return { state: "unverifiable", elapsed_ms: Date.now() - started };
    if (observations.every(({ state }) => state === "empty")) {
      consecutiveEmpty += 1;
      if (consecutiveEmpty >= 2)
        return { state: "quiesced", elapsed_ms: Date.now() - started };
    } else consecutiveEmpty = 0;
    deadlineReached = Date.now() - started >= settleMs;
    if (deadlineReached) break;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  return { state: "alive_at_deadline", elapsed_ms: Date.now() - started };
};

const awaitTerminalExit = async ({
  terminal,
  scenario,
  started,
  lastOutput,
  signal,
  timers,
  interactions,
  dispatchedEventIndexes,
}: TerminalExitOptions): Promise<{
  exitCode: number;
  signal?: number;
  reason: "exited" | "timeout" | "idle_timeout" | "cancelled";
}> =>
  new Promise((resolveExit) => {
    // The kill caused by a deadline is observed later as an ordinary PTY exit.
    // Keep the initiating lifecycle reason so comparisons distinguish a target
    // exit from harness-owned timeout, idle-timeout, and cancellation cleanup.
    let reason: "exited" | "timeout" | "idle_timeout" | "cancelled" = "exited";
    terminal.onExit((exit) => {
      for (const [eventIndex, event] of scenario.events.entries()) {
        if (dispatchedEventIndexes.has(eventIndex)) continue;
        interactions.push({
          sequence: interactions.length,
          scheduled_at_ms: event.at_ms,
          dispatched_at_ms: Math.max(0, Date.now() - started),
          type: event.type,
          data:
            event.type === "input"
              ? "<not-dispatched>"
              : event.type === "resize"
                ? `${String(event.columns)}x${String(event.rows)}`
                : event.signal,
          outcome: "target_exited",
        });
      }
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
  readonly renderer: TerminalRenderer | undefined;
  readonly shimReplay: CommandShimReplay | undefined;
  readonly checkpoints: ProcessCheckpoints | undefined;
  readonly runId: string;
  readonly temporaryRoot: string;
  readonly sampledProcessGroupIds: readonly number[];
}): Promise<string | undefined> => {
  for (const timer of options.timers) clearTimeout(timer);
  let failure: string | undefined;
  try {
    await options.replay?.close();
  } catch {
    failure = "loopback replay cleanup failed";
  }
  try {
    await options.shimReplay?.close();
  } catch {
    failure ??= "command shim replay cleanup failed";
  }
  try {
    await options.renderer?.dispose();
  } catch {
    failure ??= "terminal renderer cleanup failed";
  }
  try {
    await options.checkpoints?.dispose();
  } catch {
    failure ??= "filesystem checkpoint cleanup failed";
  }
  if (options.terminal !== undefined && process.platform !== "win32") {
    const processGroupIds = new Set([
      options.terminal.pid,
      ...options.sampledProcessGroupIds,
    ]);
    for (const processGroupId of processGroupIds) {
      const cleaned = await cleanupOwnedProcessGroup({
        runId: options.runId,
        leaderPid: processGroupId,
        processGroupId,
      });
      if (!cleaned.cleaned) failure ??= cleaned.reason;
    }
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
  readonly renderer: TerminalRenderer;
  readonly checkpoints: ProcessCheckpoints;
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
    const atMs =
      Math.floor(
        (Date.now() - options.started) /
          options.scenario.normalization.time_bucket_ms,
      ) * options.scenario.normalization.time_bucket_ms;
    const normalized = normalizeProcessText(
      data,
      options.scenario,
      options.temporaryRoot,
      options.terminal.pid,
    );
    options.frames.push({
      sequence: options.frames.length,
      at_ms: atMs,
      data: normalized,
    });
    options.renderer.write(data, atMs);
    options.checkpoints.observeTerminal(normalized);
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
  let renderer: TerminalRenderer | undefined;
  let checkpoints: ProcessCheckpoints | undefined;
  let shimReplay: CommandShimReplay | undefined;
  let started = 0;
  let startedAt = new Date(0);
  let lastOutput = 0;
  const timers = new Set<NodeJS.Timeout>();
  let capture: ProcessCapture | undefined;
  let executionFailure: unknown;
  let framesTruncated = (): boolean => false;
  let stopSampler = async () => ({ partial: false });
  let samplingPartial = false;
  let settlement: Omit<ProcessCapture["settlement"], "cleanup_outcome"> = {
    state: "unverifiable",
    elapsed_ms: 0,
  };
  const interactions: InteractionEvent[] = [];
  const dispatchedEventIndexes = new Set<number>();

  try {
    replay = await startLoopbackReplay(scenario);
    startedAt = new Date();
    started = Date.now();
    lastOutput = started;
    renderer = new TerminalRenderer({
      columns: scenario.terminal.columns,
      rows: scenario.terminal.rows,
      scrollback: scenario.terminal.scrollback,
      maxFrames: scenario.limits.frames,
      maxBytes: scenario.limits.output_bytes,
      normalize: (value) =>
        normalizeProcessText(
          value,
          scenario,
          temporaryRoot,
          terminal?.pid ?? -1,
        ),
    });
    checkpoints = new ProcessCheckpoints(scenario, started, before, signal);
    shimReplay = await startCommandShimReplay(scenario, temporaryRoot, started);
    terminal = spawn(scenario.executable, [...scenario.arguments], {
      cwd: scenario.working_directory,
      env: makeEnvironment({ scenario, home, replay, shimReplay, runId }),
      cols: scenario.terminal.columns,
      rows: scenario.terminal.rows,
      name: "xterm-256color",
    });
    const startEvents = startScenarioEvents({
      scenario,
      getTerminal: () => terminal,
      timers,
      interactions,
      renderer,
      started,
      dispatchedEventIndexes,
    });
    if (!eventsRequireReadiness(scenario)) startEvents();
    framesTruncated = captureTerminalFrames({
      terminal,
      scenario,
      frames,
      started,
      temporaryRoot,
      onOutput: () => (lastOutput = Date.now()),
      onFirstOutput: startEvents,
      renderer,
      checkpoints,
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
      interactions,
      dispatchedEventIndexes,
    });
    const exitReason = exit.reason;
    checkpoints.trigger("root_exit");
    if (exitReason === "cancelled")
      throw new ProcessCaptureError("process capture was cancelled");
    settlement = await observeSettlement(
      runId,
      [
        terminal.pid,
        ...samples.flatMap(({ process_group_id }) =>
          process_group_id === null ? [] : [process_group_id],
        ),
      ],
      scenario.settle_ms,
    );
    checkpoints.trigger("settled");
    samplingPartial = (await stopSampler()).partial;
    assertNotCancelled(signal);
    const after = await snapshotRoots(scenario, signal);
    const renderedFrames = await renderer.frames();
    const filesystemCheckpoints = await checkpoints.finish(after);
    const manifest = await createRunManifest(scenario, startedAt, new Date());
    truncated ||=
      after.truncated ||
      replay.truncated ||
      shimReplay.truncated ||
      framesTruncated() ||
      filesystemCheckpoints.some(({ truncated: partial }) => partial) ||
      samplingPartial;
    truncated ||= renderer.truncated();
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
      renderedFrames,
      interactions,
      checkpoints: filesystemCheckpoints,
      shimEvents: shimReplay.events.map((event) => ({
        ...event,
        arguments: event.arguments.map((argument) =>
          normalizeProcessText(
            argument,
            scenario,
            temporaryRoot,
            terminal?.pid ?? -1,
          ),
        ),
        working_directory: normalizeProcessText(
          event.working_directory,
          scenario,
          temporaryRoot,
          terminal?.pid ?? -1,
        ),
      })),
      settlement: { ...settlement, cleanup_outcome: "not_required" },
      manifest,
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
    renderer,
    shimReplay,
    checkpoints,
    runId,
    temporaryRoot,
    sampledProcessGroupIds: samples.flatMap(({ process_group_id }) =>
      process_group_id === null ? [] : [process_group_id],
    ),
  });
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
    const issues = validateProcessCapture(capture);
    if (issues.length > 0)
      executionFailure = new ProcessCaptureError(
        `process capture validation failed: ${issues[0]!.path}: ${issues[0]!.message}`,
      );
  }
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
