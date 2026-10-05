import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IPty } from "@lydell/node-pty";

import type {
  FilesystemCheckpoint,
  InteractionEvent,
  ProcessCapture,
  UnverifiedProcessCapture,
  ProcessSample,
  ProcessSettlement,
  ProcessScenario,
  ProcessCaptureEventJournalEntry,
  RecordProcessCaptureEvent,
  TerminalFrame,
} from "../domain/processCapture.js";
import {
  digestProcessCommitment,
  processComparisonContract,
  processScenarioCommitment,
} from "../domain/processCapture.js";
import { PRODUCT_IDENTITY } from "../identity.js";
import type { SnapshotResult } from "./FilesystemSnapshot.js";
import { snapshotRoots } from "./FilesystemSnapshot.js";
import { classifyFilesystemEffects } from "./ProcessFilesystemEffects.js";
import { cleanupOwnedProcessGroup } from "../process/ProcessOwnership.js";
import { observeOwnedProcessGroup } from "../process/ProcessOwnershipObservation.js";
import { ProcessCaptureError } from "./ProcessCaptureError.js";
import { assertNotCancelled } from "./ProcessScenarioRuntimeValidation.js";
import {
  normalizeProcessElapsedTime,
  normalizeProcessSamples,
  normalizeProcessText,
} from "./ProcessNormalization.js";
import { PROCESS_PROVIDER } from "./ProcessEvidence.js";
import { TerminalRenderer } from "./TerminalRenderer.js";
import { scheduleProcessInterval, type ProcessTimer } from "./ProcessTimer.js";

interface TerminalExitOptions {
  readonly terminal: IPty;
  readonly scenario: ProcessScenario;
  readonly started: number;
  readonly lastOutput: () => number;
  readonly signal: AbortSignal | undefined;
  readonly timers: Set<ProcessTimer>;
  readonly interactions: InteractionEvent[];
  readonly dispatchedEventIndexes: ReadonlySet<number>;
  readonly recordEvent: RecordProcessCaptureEvent;
}

interface CaptureResultOptions {
  readonly frames: readonly TerminalFrame[];
  readonly exit: {
    readonly exitCode: number;
    readonly signal?: number;
    readonly reason: "exited" | "timeout" | "idle_timeout";
  };
  readonly samples: readonly ProcessSample[];
  readonly before: SnapshotResult;
  readonly after: SnapshotResult;
  readonly truncated: boolean;
  readonly scenario: ProcessScenario;
  readonly rootPid: number;
  readonly samplingPartial: boolean;
  readonly renderedFrames: UnverifiedProcessCapture["rendered_frames"];
  readonly interactions: readonly InteractionEvent[];
  readonly checkpoints: readonly FilesystemCheckpoint[];
  readonly settlement: ObservedProcessSettlement;
  readonly manifest: UnverifiedProcessCapture["manifest"];
  readonly eventJournal: readonly ProcessCaptureEventJournalEntry[];
}

/** Settlement observation before process-resource cleanup has completed. */
export type ObservedProcessSettlement =
  | Pick<
      Extract<ProcessSettlement, { readonly state: "quiesced" }>,
      "state" | "elapsed_ms"
    >
  | Pick<
      Exclude<ProcessSettlement, { readonly state: "quiesced" }>,
      "state" | "elapsed_ms"
    >;

/** Capture observations before owned-resource cleanup has been verified. */
export type PendingProcessCapture = Omit<
  UnverifiedProcessCapture,
  "cleanup" | "settlement"
> & {
  readonly settlement: ObservedProcessSettlement;
};

/** Wait for trailing PTY callbacks before the capture becomes immutable. */
export const settleProcessCaptureJournal = async (
  journal: readonly ProcessCaptureEventJournalEntry[],
  quietMs = 25,
  maxWaitMs = 500,
): Promise<void> => {
  const deadline = Date.now() + maxWaitMs;
  let observed = journal.length;
  let lastChangeAt = Date.now();
  while (Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 4));
    if (journal.length !== observed) {
      observed = journal.length;
      lastChangeAt = Date.now();
    } else if (Date.now() - lastChangeAt >= quietMs) return;
  }
};

export const buildCaptureResult = (
  options: CaptureResultOptions,
): PendingProcessCapture => {
  const hasSensitiveScriptedInput = options.scenario.events.some(
    (event) => event.type === "input" && event.sensitive,
  );
  const sensitiveInputUnknown =
    "Sensitive scripted input values are redacted from process capture Evidence.";
  const filesystemObservationUnknown =
    "No filesystem observation paths were selected; filesystem effects remain unknown.";
  const hasFilesystemObservations =
    options.scenario.filesystem_observation_paths.length > 0;
  return {
    manifest: options.manifest,
    normalization: options.scenario.normalization,
    frames: options.frames,
    rendered_frames: options.renderedFrames,
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
    event_journal: options.eventJournal,
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
      "Inherited host environment variables are not recorded and may affect results.",
      ...(!hasFilesystemObservations ? [filesystemObservationUnknown] : []),
      ...(hasSensitiveScriptedInput ? [sensitiveInputUnknown] : []),
    ],
    residual_unknowns: [
      {
        scope: "process",
        reason:
          "Process trees are sampled and may omit short-lived descendants.",
      },
      {
        scope: "environment",
        reason: "Inherited host environment variables are not recorded.",
      },
      {
        scope: "network",
        reason: "Network activity is not observed by this capture.",
      },
      ...(!hasFilesystemObservations
        ? [
            {
              scope: "filesystem" as const,
              reason: filesystemObservationUnknown,
            },
          ]
        : []),
      ...(hasSensitiveScriptedInput
        ? [{ scope: "interaction" as const, reason: sensitiveInputUnknown }]
        : []),
    ],
  };
};

const hashFile = async (path: string): Promise<string> => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
};

export const createRunManifest = async (
  scenario: ProcessScenario,
  startedAt: Date,
  completedAt: Date,
  host: {
    readonly platform: NodeJS.Platform;
    readonly architecture: NodeJS.Architecture;
  } = {
    platform: process.platform,
    architecture: process.arch,
  },
): Promise<UnverifiedProcessCapture["manifest"]> => {
  const executableSha256 = await hashFile(scenario.executable);
  const scenarioCommitment = processScenarioCommitment(
    scenario,
    executableSha256,
  );
  const comparisonContract = processComparisonContract(scenario);
  return {
    rea_version: PRODUCT_IDENTITY.packageVersion,
    provider_version: PROCESS_PROVIDER.version,
    platform: host.platform,
    architecture: host.architecture,
    pty_backend: "node-pty",
    started_at: startedAt.toISOString(),
    completed_at: completedAt.toISOString(),
    scenario: scenarioCommitment,
    comparison_contract: comparisonContract,
    full_scenario_sha256: digestProcessCommitment(scenarioCommitment),
    comparison_contract_sha256: digestProcessCommitment(comparisonContract),
    executable_sha256: executableSha256,
    normalization_sha256: digestProcessCommitment(scenario.normalization),
  };
};

export const observeSettlement = async (
  runId: string,
  processGroupIds: readonly number[],
  settleMs: number,
  recordEvent: RecordProcessCaptureEvent = () => undefined,
  platform: NodeJS.Platform = process.platform,
): Promise<ObservedProcessSettlement> => {
  if (platform === "win32") {
    recordEvent("lifecycle", 1);
    return { state: "unverifiable", elapsed_ms: 0 };
  }
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
    if (observations.some(({ state }) => state === "unverifiable")) {
      recordEvent("lifecycle", 1);
      return { state: "unverifiable", elapsed_ms: Date.now() - started };
    }
    if (observations.every(({ state }) => state === "empty")) {
      consecutiveEmpty += 1;
      if (consecutiveEmpty >= 2) {
        recordEvent("lifecycle", 1);
        return { state: "quiesced", elapsed_ms: Date.now() - started };
      }
    } else consecutiveEmpty = 0;
    deadlineReached = Date.now() - started >= settleMs;
    if (deadlineReached) break;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  recordEvent("lifecycle", 1);
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
  recordEvent,
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
      recordEvent("lifecycle", 0);
      for (const [eventIndex, event] of scenario.events.entries()) {
        if (dispatchedEventIndexes.has(eventIndex)) continue;
        const sequence = interactions.length;
        interactions.push({
          sequence,
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
        recordEvent("interaction_events", sequence);
      }
      for (const timer of timers) {
        timer.cancel();
      }
      timers.clear();
      resolveExit({ ...exit, reason });
    });
    const timeout = scheduleProcessInterval(() => {
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

/** Host operations used when releasing one captured process run. */
export interface ProcessCaptureCleanupHost {
  readonly platform: NodeJS.Platform;
  readonly cleanupProcessGroup: typeof cleanupOwnedProcessGroup;
  readonly removeTemporaryRoot: (path: string) => Promise<void>;
}

const processCaptureCleanupHost: ProcessCaptureCleanupHost = {
  platform: process.platform,
  cleanupProcessGroup: cleanupOwnedProcessGroup,
  removeTemporaryRoot: (path) => rm(path, { recursive: true, force: true }),
};

export const releaseProcessResources = async (options: {
  readonly timers: ReadonlySet<ProcessTimer>;
  readonly terminal: IPty | undefined;
  readonly renderer: TerminalRenderer | undefined;
  readonly runId: string;
  readonly temporaryRoot: string;
  readonly capturedProcessGroupIds: readonly number[];
  readonly host?: ProcessCaptureCleanupHost;
}): Promise<string | undefined> => {
  const host = options.host ?? processCaptureCleanupHost;
  for (const timer of options.timers) timer.cancel();
  let failure: string | undefined;
  try {
    await options.renderer?.dispose();
  } catch (cause: unknown) {
    void cause;
    failure ??= "terminal renderer cleanup failed";
  }
  if (options.terminal !== undefined && host.platform !== "win32") {
    for (const processGroupId of new Set(options.capturedProcessGroupIds)) {
      const cleaned = await host.cleanupProcessGroup({
        runId: options.runId,
        leaderPid: processGroupId,
        processGroupId,
      });
      if (!cleaned.cleaned) failure ??= cleaned.reason;
    }
  }
  try {
    await host.removeTemporaryRoot(options.temporaryRoot);
  } catch (cause: unknown) {
    void cause;
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
  readonly renderer: TerminalRenderer;
  readonly recordEvent: RecordProcessCaptureEvent;
}): (() => boolean) => {
  let outputBytes = 0;
  let truncated = false;
  options.terminal.onData((data) => {
    options.onOutput();
    const bytes = Buffer.byteLength(data);
    if (outputBytes + bytes > options.scenario.limits.output_bytes) {
      truncated = true;
      return;
    }
    outputBytes += bytes;
    const atMs = normalizeProcessElapsedTime(
      Date.now() - options.started,
      options.scenario.normalization.time_bucket_ms,
    );
    const normalized = normalizeProcessText(
      data,
      options.scenario,
      options.temporaryRoot,
      options.terminal.pid,
    );
    const sequence = options.frames.length;
    options.frames.push({
      sequence,
      at_ms: atMs,
      data: normalized,
    });
    options.renderer.write(data, atMs);
    options.recordEvent("frames", sequence);
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
  signal: AbortSignal | undefined,
  host: ProcessPreparationHost = systemProcessPreparationHost,
): Promise<{
  readonly temporaryRoot: string;
  readonly runId: string;
  readonly before: SnapshotResult;
}> => {
  assertNotCancelled(signal);
  const before = await snapshotRoots(scenario, signal);
  const temporaryRoot = await host.createTemporaryRoot();
  try {
    const runId = randomUUID();
    return { temporaryRoot, runId, before };
  } catch (cause: unknown) {
    await host.cleanup(temporaryRoot);
    throw cause;
  }
};

/** Filesystem seam for allocating and cleaning a capture's temporary root. */
export interface ProcessPreparationHost {
  createTemporaryRoot(): Promise<string>;
  cleanup(path: string): Promise<void>;
}

const systemProcessPreparationHost: ProcessPreparationHost = {
  createTemporaryRoot: () => mkdtemp(join(tmpdir(), "rea-process-")),
  cleanup: (path) => rm(path, { recursive: true, force: true }),
};
