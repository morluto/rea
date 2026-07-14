import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IPty } from "node-pty";

import type {
  FilesystemCheckpoint,
  InteractionEvent,
  ProcessCapture,
  ProcessExecutionPolicy,
  ProcessPolicyDecision,
  ProcessSample,
  ProcessScenario,
  TerminalFrame,
} from "../domain/processCapture.js";
import {
  authorizeProcessScenario,
  digestProcessCommitment,
  processComparisonContract,
  processScenarioCommitment,
} from "../domain/processCapture.js";
import { PRODUCT_IDENTITY } from "../identity.js";
import type { SnapshotResult } from "./FilesystemSnapshot.js";
import { snapshotRoots } from "./FilesystemSnapshot.js";
import type { LoopbackReplay } from "./LoopbackReplay.js";
import {
  cleanupOwnedProcessGroup,
  observeOwnedProcessGroup,
} from "./ProcessOwnership.js";
import {
  classifyFilesystemEffects,
  ProcessCheckpoints,
} from "./ProcessCheckpoints.js";
import { ProcessCaptureError } from "./ProcessCaptureError.js";
import {
  assertNotCancelled,
  assertRealPathAuthority,
} from "./ProcessCaptureAuthority.js";
import {
  normalizeProcessSamples,
  normalizeProcessText,
  redactProtocolEvents,
} from "./ProcessNormalization.js";
import type { CommandShimReplay } from "./CommandShimReplay.js";
import { PROCESS_PROVIDER } from "./ProcessEvidence.js";
import { TerminalRenderer } from "./TerminalRenderer.js";

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

export const buildCaptureResult = (
  options: CaptureResultOptions,
): ProcessCapture => ({
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

export const createRunManifest = async (
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

export const observeSettlement = async (
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

export const awaitTerminalExit = async ({
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

export const releaseProcessResources = async (options: {
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

export const captureTerminalFrames = (options: {
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

export const resolveProcessResult = (
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
    throw new ProcessCaptureError(cleanupFailure, {
      reason: "cleanup_incomplete",
    });
  if (capture === undefined)
    throw new ProcessCaptureError("process capture produced no result");
  return capture;
};

export const prepareProcessCapture = async (
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
  if (!decision.allowed)
    throw new ProcessCaptureError(decision.reason, {
      userCategory: "permission_required",
      userMessage: processPolicyMessage(decision.reason),
    });
  await assertRealPathAuthority(scenario, policy);
  assertNotCancelled(signal);
  const before = await snapshotRoots(scenario, signal);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "rea-process-"));
  const runId = randomUUID();
  const home = join(temporaryRoot, "home");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(home));
  return { temporaryRoot, runId, home, before };
};

const processPolicyMessage = (
  reason: Exclude<ProcessPolicyDecision, { readonly allowed: true }>["reason"],
): string => {
  if (reason === "process capture is disabled")
    return "Process capture is disabled. Set `REA_PROCESS_CAPTURE_ENABLED=true`, configure approved roots, then restart REA.";
  if (reason === "host network access is not approved by operator policy")
    return "This capture requests host network access, but policy does not allow it. Use replayed network access or ask the operator to enable external network capture.";
  if (reason === "executable is outside approved roots")
    return "The executable is outside the approved capture directories. Choose an approved executable or add its directory to `REA_PROCESS_EXECUTABLE_ROOTS_JSON`.";
  if (reason === "working directory is outside approved roots")
    return "The working directory is outside the approved capture directories. Choose an approved directory or add it to `REA_PROCESS_WORKING_ROOTS_JSON`.";
  if (reason === "filesystem root is outside approved roots")
    return "A requested filesystem root is outside the approved capture directories. Remove it or add its directory to `REA_PROCESS_WORKING_ROOTS_JSON`.";
  if (
    reason === "scenario requests an environment variable not allowed by policy"
  )
    return "The capture requests an environment variable that policy does not allow. Remove it or add its name to `REA_PROCESS_ALLOWED_ENV_JSON`.";
  return reason satisfies never;
};
