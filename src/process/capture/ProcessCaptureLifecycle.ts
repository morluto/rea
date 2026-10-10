import { createHash, randomUUID } from "node:crypto";
import { constants, statSync, type BigIntStats } from "node:fs";
import { open, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { IPty } from "@lydell/node-pty";

import type { ProcessCapture } from "../../domain/process/processCaptureParsing.js";
import type { ProcessScenario } from "../../domain/process/processScenario.js";
import {
  digestProcessCommitment,
  processComparisonContract,
  processScenarioCommitment,
} from "../../domain/process/processScenario.js";
import { parseProcessCapture } from "../../domain/process/processCaptureParsing.js";
import { PRODUCT_IDENTITY } from "../../identity.js";
import { snapshotRoots } from "./FilesystemSnapshot.js";
import { classifyFilesystemEffects } from "./ProcessFilesystemEffects.js";
import {
  cleanupOwnedProcessGroup,
  verifyNoTokenOwnedProcesses,
  type OwnedProcessGroup,
  type ProcessCleanupResult,
  type ProcessOwnershipBaseline,
} from "../ProcessOwnership.js";
import {
  observeOwnedProcessGroup,
  prepareProcessOwnershipInspection,
  systemProcessOwnershipHost,
} from "../ProcessOwnershipObservation.js";
import {
  describeProcessCaptureExecutionFailure,
  normalizeCaptureFailure,
  ProcessCaptureError,
} from "./ProcessCaptureError.js";
import { assertNotCancelled } from "./ProcessScenarioRuntimeValidation.js";
import {
  normalizeProcessElapsedTime,
  normalizeProcessSamples,
  normalizeProcessText,
} from "./ProcessNormalization.js";
import { PROCESS_PROVIDER } from "../../domain/process/processEvidenceProvider.js";
import { TerminalRenderer } from "./TerminalRenderer.js";
import {
  hasCaptureTruncation,
  type TerminalRetention,
  type ProcessCaptureTruncationDetails,
} from "../../domain/process/processCaptureCoverage.js";
import { scheduleProcessInterval, type ProcessTimer } from "./ProcessTimer.js";

import type {
  FilesystemCheckpoint,
  InteractionEvent,
  ProcessCaptureFinalization,
  UnverifiedProcessCapture,
  ProcessSample,
  ProcessSettlement,
  ProcessCaptureCleanupReport,
  PartialProcessCaptureObservation,
  IncompleteProcessCaptureObservations,
  ProcessFilesystemSnapshot,
  PartialProcessObservationField,
  ProcessCaptureEventJournalEntry,
  RecordProcessCaptureEvent,
  TerminalFrame,
} from "../../domain/process/processCapture.js";
import { partialProcessCaptureObservationSchema } from "../../domain/process/processCapture.js";
interface TerminalExitOptions {
  readonly terminal: Pick<IPty, "onExit" | "kill">;
  readonly scenario: ProcessScenario;
  readonly started: number;
  readonly lastOutput: () => number;
  readonly signal: AbortSignal | undefined;
  /** Identity-checked signal to the captured root, used only during finalization. */
  readonly signalTarget: (
    signal: FinalizationSignal,
  ) => Promise<FinalizationDelivery>;
  /** Receives the attempts so far, so a later failure keeps them. */
  readonly recordFinalization: (
    finalization: ProcessCaptureFinalization,
  ) => void;
  readonly timers: Set<ProcessTimer>;
  readonly interactions: InteractionEvent[];
  readonly dispatchedEventIndexes: ReadonlySet<number>;
  readonly recordEvent: RecordProcessCaptureEvent;
  readonly onLiveProgress?: () => void;
}

type FinalizationSignal =
  ProcessCaptureFinalization["signals"][number]["signal"];
type FinalizationDelivery =
  ProcessCaptureFinalization["signals"][number]["delivery"];

/** The capture's exit, or the facts known when no exit could be observed. */
export type TerminalExitResult =
  | {
      readonly unobserved?: false;
      readonly exitCode: number;
      readonly signal?: number;
      readonly reason: "exited" | "timeout" | "idle_timeout" | "cancelled";
      readonly finalization?: ProcessCaptureFinalization;
    }
  | {
      readonly unobserved: true;
      readonly reason: "timeout" | "idle_timeout" | "cancelled";
      readonly finalization: ProcessCaptureFinalization;
    };

interface CaptureResultOptions {
  readonly frames: readonly TerminalFrame[];
  readonly exit: {
    readonly exitCode: number;
    readonly signal?: number;
    readonly reason: "exited" | "timeout" | "idle_timeout";
    readonly finalization?: ProcessCaptureFinalization;
  };
  readonly samples: readonly ProcessSample[];
  readonly before: ProcessFilesystemSnapshot;
  readonly after: ProcessFilesystemSnapshot;
  readonly truncationDetails: ProcessCaptureTruncationDetails;
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

/** Mutable collection of facts available if completion stops before a capture exists. */
export interface ProcessCaptureObservationBuffer {
  target_pid: PartialProcessObservationField<number>;
  frames: PartialProcessObservationField<readonly TerminalFrame[]>;
  rendered_frames: PartialProcessObservationField<
    UnverifiedProcessCapture["rendered_frames"]
  >;
  interaction_events: PartialProcessObservationField<
    UnverifiedProcessCapture["interaction_events"]
  >;
  exit: IncompleteProcessCaptureObservations["exit"];
  finalization?: IncompleteProcessCaptureObservations["finalization"];
  settlement: IncompleteProcessCaptureObservations["settlement"];
  process_samples: PartialProcessObservationField<readonly ProcessSample[]>;
  filesystem_snapshots: {
    before: PartialProcessObservationField<ProcessFilesystemSnapshot>;
    after: PartialProcessObservationField<ProcessFilesystemSnapshot>;
  };
  event_journal: PartialProcessObservationField<
    readonly ProcessCaptureEventJournalEntry[]
  >;
  manifest: IncompleteProcessCaptureObservations["manifest"];
}

/** Seed explicit observation availability before capture completion begins. */
export const createProcessCaptureObservationBuffer = (options: {
  readonly frames: readonly TerminalFrame[];
  readonly interactions: readonly InteractionEvent[];
  readonly samples: readonly ProcessSample[];
  readonly eventJournal: readonly ProcessCaptureEventJournalEntry[];
  readonly before: ProcessFilesystemSnapshot;
  /** Seed a finalization observation only for a scenario with an interval. */
  readonly finalizationEnabled?: boolean;
}): ProcessCaptureObservationBuffer => ({
  target_pid: {
    state: "unavailable",
    reason: "No PTY process was spawned before the run failed.",
  },
  frames: { state: "available", value: options.frames },
  rendered_frames: {
    state: "unavailable",
    reason:
      "Rendered terminal frames were not collected before capture completion finished.",
  },
  interaction_events: { state: "available", value: options.interactions },
  exit: {
    state: "unavailable",
    reason: "Terminal exit was not observed before the run failed.",
  },
  ...(options.finalizationEnabled === true
    ? {
        finalization: {
          state: "unavailable" as const,
          reason:
            "Finalization was not observed before capture completion finished.",
        },
      }
    : {}),
  settlement: {
    state: "unavailable",
    reason:
      "Process settlement was not observed before capture completion finished.",
  },
  process_samples: { state: "available", value: options.samples },
  filesystem_snapshots: {
    before: {
      state: "available",
      value: options.before,
    },
    after: {
      state: "unavailable",
      reason:
        "Final filesystem snapshot was not collected before capture completion finished.",
    },
  },
  event_journal: { state: "available", value: options.eventJournal },
  manifest: {
    state: "unavailable",
    reason:
      "Capture manifest was not produced before capture completion finished.",
  },
});

const normalizePartialProcessObservations = (
  observations: IncompleteProcessCaptureObservations,
  context: { readonly scenario: ProcessScenario; readonly rootPid?: number },
): IncompleteProcessCaptureObservations => {
  const targetPid = observations.target_pid;
  const target_pid =
    targetPid.state === "available" && context.rootPid !== undefined
      ? {
          state: "available" as const,
          value: context.scenario.normalization.pids ? 1 : context.rootPid,
        }
      : targetPid;
  const samples = observations.process_samples;
  const process_samples =
    samples.state === "available" && context.rootPid !== undefined
      ? {
          state: "available" as const,
          value: normalizeProcessSamples(
            samples.value,
            context.scenario,
            context.rootPid,
          ),
        }
      : samples;
  return { ...observations, target_pid, process_samples };
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
  const filesystemEffects = classifyFilesystemEffects(
    options.before,
    options.after,
  );
  const filesystemUnknowns = [
    ...new Set(
      filesystemEffects.flatMap((effect) =>
        effect.status === "unknown" ? [effect.reason] : [],
      ),
    ),
  ];
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
      ...(options.exit.finalization === undefined
        ? {}
        : { finalization: options.exit.finalization }),
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
    filesystem_effects: filesystemEffects,
    truncated: hasCaptureTruncation(options.truncationDetails),
    truncation_details: options.truncationDetails,
    limitations: [
      "The executable digest is a prelaunch file sample; matching path metadata immediately after spawn does not prove an atomic operating-system image binding.",
      "Process trees are sampled and may omit short-lived descendants.",
      ...(options.samplingPartial
        ? ["Process-tree sampling ended with an incomplete observation."]
        : []),
      "Filesystem observations are before/after snapshots, not syscall traces.",
      "Inherited host environment variables are not recorded and may affect results.",
      ...(!hasFilesystemObservations ? [filesystemObservationUnknown] : []),
      ...filesystemUnknowns,
      ...captureCoverageUnknowns(options.truncationDetails).map(
        ({ reason }) => reason,
      ),
      ...(hasSensitiveScriptedInput ? [sensitiveInputUnknown] : []),
    ],
    residual_unknowns: [
      {
        scope: "process",
        reason:
          "Process trees are sampled and may omit short-lived descendants.",
      },
      {
        scope: "process",
        reason:
          "The executable digest is a prelaunch file sample; operating-system image binding is not atomically observed.",
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
      ...filesystemUnknowns.map((reason) => ({
        scope: "filesystem" as const,
        reason,
      })),
      ...(hasSensitiveScriptedInput
        ? [{ scope: "interaction" as const, reason: sensitiveInputUnknown }]
        : []),
      ...captureCoverageUnknowns(options.truncationDetails).filter(
        ({ scope }) => scope !== "terminal",
      ),
    ],
  };
};

const captureCoverageUnknowns = (
  details: ProcessCaptureTruncationDetails,
): UnverifiedProcessCapture["residual_unknowns"] => {
  const unknowns: Array<UnverifiedProcessCapture["residual_unknowns"][number]> =
    [];
  if (
    details.raw_terminal.observed_frames > details.raw_terminal.retained_frames
  )
    unknowns.push({
      scope: "terminal",
      reason:
        "Raw PTY chunks exceeded output_bytes and were omitted; rendered states also lack those inputs. See truncation_details.raw_terminal.",
    });
  if (
    details.rendered_terminal.observed_frames >
    details.rendered_terminal.retained_frames
  )
    unknowns.push({
      scope: "terminal",
      reason:
        "Cumulative rendered state and visible-line bytes exceeded output_bytes; whole rendered frames were omitted. Raw PTY coverage is reported separately. See truncation_details.rendered_terminal.",
    });
  for (const [name, coverage] of [
    ["before", details.filesystem_before],
    ["after_settlement", details.filesystem_after],
  ] as const) {
    if (coverage.enumeration_truncated)
      unknowns.push({
        scope: "filesystem",
        reason: `Filesystem ${name} path enumeration was incomplete: ${coverage.enumeration_reasons.join(", ")}. See truncation_details.`,
      });
    if (coverage.hash_omissions.length > 0)
      unknowns.push({
        scope: "filesystem",
        reason: `Filesystem ${name} omitted ${String(coverage.hash_omissions.length)} whole-file digests; per-path reasons and remaining file_bytes budget are in truncation_details.`,
      });
  }
  if (details.process.sampling_partial)
    unknowns.push({
      scope: "process",
      reason:
        "Process sampling stopped with incomplete observations; sample_limit is reported in truncation_details.process.",
    });
  return unknowns;
};

interface ExecutableFileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

export interface SelectedExecutableObservation {
  readonly sha256: string | null;
  readonly identity: ExecutableFileIdentity | null;
  readonly reason: string | null;
}

export interface LaunchedExecutableObservation {
  readonly selectedSha256: string | null;
  readonly sha256: string | null;
  readonly state: "path_metadata_unchanged" | "unknown";
  readonly reason: string | null;
}

const identityFromStats = (stats: BigIntStats): ExecutableFileIdentity => ({
  dev: stats.dev,
  ino: stats.ino,
  mode: stats.mode,
  size: stats.size,
  mtimeNs: stats.mtimeNs,
  ctimeNs: stats.ctimeNs,
});

const sameExecutableIdentity = (
  left: ExecutableFileIdentity,
  right: ExecutableFileIdentity,
): boolean =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.mode === right.mode &&
  left.size === right.size &&
  left.mtimeNs === right.mtimeNs &&
  left.ctimeNs === right.ctimeNs;

const filesystemFailure = (cause: unknown): string | undefined => {
  if (!(cause instanceof Error) || !("code" in cause) || !("syscall" in cause))
    return undefined;
  return `Executable file observation failed: ${cause.message}`;
};

/** Metadata IO seam for deterministic prelaunch cancellation and identity checks. */
export interface SelectedExecutableFileSystem {
  open(path: string, flags: number): ReturnType<typeof open>;
  stat(path: string): Promise<BigIntStats>;
}

const selectedExecutableFileSystem: SelectedExecutableFileSystem = {
  open,
  stat: (path) => stat(path, { bigint: true }),
};

/** Sample the selected file without launching it; retain cancellation and file identity. */
export const observeSelectedExecutable = async (
  path: string,
  signal?: AbortSignal,
  fileSystem: SelectedExecutableFileSystem = selectedExecutableFileSystem,
): Promise<SelectedExecutableObservation> => {
  assertNotCancelled(signal);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await fileSystem.open(
      path,
      constants.O_RDONLY | constants.O_NONBLOCK,
    );
    const openedStats = await handle.stat({ bigint: true });
    if (!openedStats.isFile())
      return {
        sha256: null,
        identity: null,
        reason: "Selected executable is not a regular file.",
      };
    const openedIdentity = identityFromStats(openedStats);
    const selectedPathIdentity = identityFromStats(await fileSystem.stat(path));
    if (!sameExecutableIdentity(openedIdentity, selectedPathIdentity))
      return {
        sha256: null,
        identity: null,
        reason: "Selected executable path changed while it was being opened.",
      };

    // IO above can settle after cancellation. Do not construct a stream with an
    // already-aborted signal: Node can emit a second, unhandled AbortError.
    assertNotCancelled(signal);
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({
      autoClose: false,
      signal,
    })) {
      assertNotCancelled(signal);
      hash.update(chunk);
    }
    assertNotCancelled(signal);
    const finalIdentity = identityFromStats(
      await handle.stat({ bigint: true }),
    );
    if (!sameExecutableIdentity(openedIdentity, finalIdentity))
      return {
        sha256: null,
        identity: null,
        reason: "Selected executable changed while its contents were sampled.",
      };
    return {
      sha256: hash.digest("hex"),
      identity: openedIdentity,
      reason: null,
    };
  } catch (cause: unknown) {
    assertNotCancelled(signal);
    const reason = filesystemFailure(cause);
    if (reason !== undefined) return { sha256: null, identity: null, reason };
    throw cause;
  } finally {
    await handle?.close();
  }
};

/** Compare the selected file metadata with the path immediately after PTY spawn. */
export const observeLaunchedExecutable = (
  path: string,
  selected: SelectedExecutableObservation,
): LaunchedExecutableObservation => {
  if (selected.identity === null || selected.sha256 === null)
    return {
      selectedSha256: selected.sha256,
      sha256: null,
      state: "unknown",
      reason: selected.reason ?? "Selected executable identity is unavailable.",
    };
  try {
    const currentStats = statSync(path, { bigint: true });
    const currentIdentity = identityFromStats(currentStats);
    if (
      currentStats.isFile() &&
      sameExecutableIdentity(selected.identity, currentIdentity)
    )
      return {
        selectedSha256: selected.sha256,
        sha256: selected.sha256,
        state: "path_metadata_unchanged",
        reason: null,
      };
    return {
      selectedSha256: selected.sha256,
      sha256: null,
      state: "unknown",
      reason: "Executable path metadata changed between sampling and spawn.",
    };
  } catch (cause: unknown) {
    const reason = filesystemFailure(cause);
    if (reason !== undefined)
      return {
        selectedSha256: selected.sha256,
        sha256: null,
        state: "unknown",
        reason,
      };
    throw cause;
  }
};

export const createRunManifest = async (
  scenario: ProcessScenario,
  startedAt: Date,
  completedAt: Date,
  executable: LaunchedExecutableObservation,
  host: {
    readonly platform: NodeJS.Platform;
    readonly architecture: NodeJS.Architecture;
  } = {
    platform: process.platform,
    architecture: process.arch,
  },
): Promise<UnverifiedProcessCapture["manifest"]> => {
  const scenarioCommitment = processScenarioCommitment(
    scenario,
    executable.selectedSha256 ?? undefined,
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
    selected_executable_sha256: executable.selectedSha256,
    executable_sha256: executable.sha256,
    executable_identity: {
      state: executable.state,
      reason: executable.reason,
    },
    normalization_sha256: digestProcessCommitment(scenario.normalization),
  };
};

export const observeSettlement = async (
  runId: string,
  processGroupIds: readonly number[],
  settleMs: number,
  recordEvent: RecordProcessCaptureEvent = () => undefined,
  platform: NodeJS.Platform = process.platform,
  signal?: AbortSignal,
  onLiveProgress?: () => void,
): Promise<ObservedProcessSettlement> => {
  assertNotCancelled(signal);
  onLiveProgress?.();
  if (platform === "win32") {
    recordEvent("lifecycle", 1);
    return { state: "unverifiable", elapsed_ms: 0 };
  }
  const started = Date.now();
  let consecutiveEmpty = 0;
  let deadlineReached = false;
  while (!deadlineReached) {
    onLiveProgress?.();
    assertNotCancelled(signal);
    const observations = await Promise.all(
      [...new Set(processGroupIds)].map((processGroupId) =>
        observeOwnedProcessGroup(
          { runId, leaderPid: processGroupId, processGroupId },
          undefined,
          signal,
        ),
      ),
    );
    assertNotCancelled(signal);
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
    await delay(50, undefined, { signal });
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
  signalTarget,
  recordFinalization,
  timers,
  interactions,
  dispatchedEventIndexes,
  recordEvent,
  onLiveProgress,
}: TerminalExitOptions): Promise<TerminalExitResult> =>
  new Promise((resolveExit) => {
    // The kill caused by a deadline is observed later as an ordinary PTY exit.
    // Keep the initiating lifecycle reason so comparisons distinguish a target
    // exit from harness-owned timeout, idle-timeout, and cancellation cleanup.
    let reason: "exited" | "timeout" | "idle_timeout" | "cancelled" = "exited";
    onLiveProgress?.();
    // A deadline with a finalization interval sends SIGTERM first and keeps
    // observing; SIGKILL follows only when the interval elapses or the request
    // is cancelled. Both go through the identity-checked signaller.
    // The interval is measured on the monotonic clock so a wall-clock change
    // cannot shorten it or produce a negative elapsed time.
    let finalizationStartedAt: number | undefined;
    let escalationSent = false;
    let settled = false;
    let exitObserved = false;
    const finalizationSignals: {
      signal: FinalizationSignal;
      sent_at_ms: number;
      delivery: FinalizationDelivery;
    }[] = [];
    const pendingDeliveries: Promise<void>[] = [];
    const snapshot = (elapsed: number | null): ProcessCaptureFinalization => ({
      requested_ms: scenario.finalization_ms,
      elapsed_ms: elapsed,
      signals: finalizationSignals.map((attempt) => ({ ...attempt })),
    });
    const unobservedExit = (): void => {
      if (settled || exitObserved || finalizationStartedAt === undefined)
        return;
      settled = true;
      for (const timer of timers) timer.cancel();
      timers.clear();
      resolveExit({
        unobserved: true,
        reason: reason === "exited" ? "timeout" : reason,
        finalization: snapshot(null),
      });
    };
    // An attempt is recorded before its delivery is awaited, so a hung or
    // failed delivery still leaves the attempt in the observations.
    const attempt = (finalizationSignal: FinalizationSignal): void => {
      if (finalizationStartedAt === undefined) return;
      const record = {
        signal: finalizationSignal,
        sent_at_ms: Math.round(performance.now() - finalizationStartedAt),
        delivery: "unverified" as FinalizationDelivery,
      };
      finalizationSignals.push(record);
      recordFinalization(snapshot(null));
      const deliveryBound = new AbortController();
      // The wait is bounded by the cleanup verification grace: a delivery that
      // never settles is recorded as unverified instead of holding the capture.
      pendingDeliveries.push(
        Promise.race([
          signalTarget(finalizationSignal),
          delay(PROCESS_CLEANUP_VERIFICATION_GRACE_MS, "unverified" as const, {
            ref: false,
            signal: deliveryBound.signal,
          }).catch(() => "unverified" as const),
        ])
          .finally(() => {
            deliveryBound.abort();
          })
          .then(
            (delivery) => {
              record.delivery = delivery;
            },
            () => {
              record.delivery = "unverified";
            },
          )
          .then(() => {
            recordFinalization(snapshot(null));
            // A kill that cannot reach the root leaves no exit to wait for.
            if (
              finalizationSignal === "SIGKILL" &&
              record.delivery !== "signaled" &&
              record.delivery !== "gone"
            )
              unobservedExit();
          }),
      );
    };
    const forceKill = (): void => {
      if (finalizationStartedAt !== undefined) {
        if (escalationSent) return;
        escalationSent = true;
        attempt("SIGKILL");
        return;
      }
      terminal.kill("SIGKILL");
    };
    const terminateAtDeadline = (): void => {
      if (scenario.finalization_ms === 0) {
        terminal.kill("SIGKILL");
        return;
      }
      finalizationStartedAt = performance.now();
      attempt("SIGTERM");
    };
    terminal.onExit((exit) => {
      if (settled) return;
      exitObserved = true;
      // Measures when the exit was observed, not when the operating system
      // ended the process; the PTY layer can deliver the notification late.
      const finalizationElapsedMs =
        finalizationStartedAt === undefined
          ? undefined
          : Math.round(performance.now() - finalizationStartedAt);
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
      const finish = (): void => {
        if (settled) return;
        settled = true;
        resolveExit({
          ...exit,
          reason,
          ...(finalizationElapsedMs === undefined
            ? {}
            : { finalization: snapshot(finalizationElapsedMs) }),
        });
      };
      if (pendingDeliveries.length === 0) {
        finish();
        return;
      }
      // A delivery that never settles must not hold back an observed exit;
      // its attempt stays recorded as unverified.
      const grace = new AbortController();
      void Promise.race([
        Promise.allSettled(pendingDeliveries),
        delay(PROCESS_CLEANUP_VERIFICATION_GRACE_MS, undefined, {
          ref: false,
          signal: grace.signal,
        }).catch(() => undefined),
      ])
        .finally(() => {
          grace.abort();
        })
        .then(finish);
    });
    const timeout = scheduleProcessInterval(() => {
      onLiveProgress?.();
      if (signal?.aborted === true) {
        reason = "cancelled";
        forceKill();
      } else if (finalizationStartedAt !== undefined) {
        if (
          performance.now() - finalizationStartedAt >=
          scenario.finalization_ms
        )
          forceKill();
      } else if (Date.now() - started >= scenario.timeout_ms) {
        reason = "timeout";
        terminateAtDeadline();
      } else if (Date.now() - lastOutput() >= scenario.idle_timeout_ms) {
        reason = "idle_timeout";
        terminateAtDeadline();
      }
    }, 20);
    timers.add(timeout);
  });

/** Host operations used when releasing one captured process run. */
export interface ProcessCaptureCleanupHost {
  readonly platform: NodeJS.Platform;
  readonly cleanupProcessGroup: typeof cleanupOwnedProcessGroup;
  readonly verifyTokenOwnedProcesses: typeof verifyNoTokenOwnedProcesses;
  readonly removeTemporaryRoot: (path: string) => Promise<void>;
}

const processCaptureCleanupHost: ProcessCaptureCleanupHost = {
  platform: process.platform,
  cleanupProcessGroup: cleanupOwnedProcessGroup,
  verifyTokenOwnedProcesses: verifyNoTokenOwnedProcesses,
  removeTemporaryRoot: (path) => rm(path, { recursive: true, force: true }),
};

const PROCESS_CLEANUP_VERIFICATION_GRACE_MS = 1_000;
const PROCESS_CLEANUP_VERIFICATION_INTERVAL_MS = 25;

const verifyTokenOwnedProcessesUntilSettled = async (
  verify: () => Promise<ProcessCleanupResult>,
): Promise<ProcessCleanupResult> => {
  const deadline = Date.now() + PROCESS_CLEANUP_VERIFICATION_GRACE_MS;
  let result = await verify();
  while (!result.cleaned) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return result;
    await new Promise<void>((resolve) =>
      setTimeout(
        resolve,
        Math.min(PROCESS_CLEANUP_VERIFICATION_INTERVAL_MS, remaining),
      ),
    );
    result = await verify();
  }
  return result;
};

const releaseCapturedProcessGroup = async (
  ownership: OwnedProcessGroup,
  host: ProcessCaptureCleanupHost,
): Promise<ProcessCaptureCleanupReport["owned_process_group"]> => {
  if (host.platform === "win32")
    return {
      state: "unverified",
      reason:
        "owned process cleanup is unverifiable on Windows without process-job authority",
    };
  let outcome: ProcessCaptureCleanupReport["owned_process_group"] = {
    state: "cleaned",
    reason: null,
  };
  const unverified: Array<{
    readonly pid: number;
    readonly diagnostic: string;
  }> = [];
  try {
    const cleaned = await host.cleanupProcessGroup(ownership);
    unverified.push(...(cleaned.unverified ?? []));
    if (!cleaned.cleaned) {
      outcome = { state: "unverified", reason: cleaned.reason };
    } else {
      const verified = await verifyTokenOwnedProcessesUntilSettled(() =>
        host.verifyTokenOwnedProcesses(
          ownership.runId,
          undefined,
          ownership.captureBaseline,
          ownership,
        ),
      );
      unverified.push(...(verified.unverified ?? []));
      if (!verified.cleaned)
        outcome = { state: "unverified", reason: verified.reason };
    }
  } catch (cause: unknown) {
    outcome = {
      state: "failed",
      reason:
        cause instanceof Error
          ? cause.message || cause.name || "owned process cleanup failed"
          : "owned process cleanup failed",
    };
  }
  return unverified.length === 0
    ? outcome
    : {
        ...outcome,
        unverified_processes: [
          ...new Map(
            unverified.map(({ pid, diagnostic }) => [
              `${String(pid)}:${diagnostic}`,
              { pid, reason: diagnostic },
            ]),
          ).values(),
        ],
      };
};

export const releaseProcessResources = async (options: {
  readonly timers: ReadonlySet<ProcessTimer>;
  readonly terminal: Pick<IPty, "pid"> | undefined;
  readonly renderer: TerminalRenderer | undefined;
  readonly runId: string;
  readonly temporaryRoot: string;
  readonly captureBaseline?: ProcessOwnershipBaseline;
  readonly sampledProcessGroupIds?: readonly number[];
  readonly host?: ProcessCaptureCleanupHost;
}): Promise<ProcessCaptureCleanupReport> => {
  const host = options.host ?? processCaptureCleanupHost;
  for (const timer of options.timers) timer.cancel();
  let terminalRenderer: ProcessCaptureCleanupReport["terminal_renderer"] = {
    state: options.renderer === undefined ? "not_required" : "cleaned",
    reason: null,
  };
  try {
    await options.renderer?.dispose();
  } catch (cause: unknown) {
    terminalRenderer = {
      state: "failed",
      reason:
        cause instanceof Error
          ? cause.message || cause.name || "renderer dispose failed"
          : "renderer dispose failed",
    };
  }
  const ownedProcessGroup =
    options.terminal === undefined
      ? { state: "not_required" as const, reason: null }
      : await releaseCapturedProcessGroup(
          {
            runId: options.runId,
            leaderPid: options.terminal.pid,
            processGroupId: options.terminal.pid,
            sweepTokenOwnedProcesses: true,
            ...(options.sampledProcessGroupIds === undefined
              ? {}
              : { sampledProcessGroupIds: options.sampledProcessGroupIds }),
            ...(options.captureBaseline === undefined
              ? {}
              : { captureBaseline: options.captureBaseline }),
          },
          host,
        );
  let temporaryRoot: ProcessCaptureCleanupReport["temporary_root"] = {
    state: "cleaned",
    reason: null,
  };
  try {
    await host.removeTemporaryRoot(options.temporaryRoot);
  } catch (cause: unknown) {
    temporaryRoot = {
      state: "failed",
      reason:
        cause instanceof Error
          ? cause.message || cause.name || "temporary root removal failed"
          : "temporary root removal failed",
    };
  }
  return {
    owned_process_group: ownedProcessGroup,
    terminal_renderer: terminalRenderer,
    temporary_root: temporaryRoot,
  };
};

export const cleanupReportFailure = (
  report: ProcessCaptureCleanupReport,
): string | undefined => {
  const failures = Object.entries(report).filter(
    ([, outcome]) =>
      outcome.state === "failed" || outcome.state === "unverified",
  );
  return failures.length === 0
    ? undefined
    : failures
        .map(
          ([resource, outcome]) =>
            `${resource}: ${outcome.reason ?? outcome.state}`,
        )
        .join("; ");
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
}): (() => TerminalRetention) => {
  let outputBytes = 0;
  let observedBytes = 0;
  let observedFrames = 0;
  options.terminal.onData((data) => {
    options.onOutput();
    const bytes = Buffer.byteLength(data);
    observedBytes += bytes;
    observedFrames += 1;
    if (outputBytes + bytes > options.scenario.limits.output_bytes) {
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
      ...(normalized === data ? {} : { raw_data: data }),
    });
    options.renderer.write(data, atMs);
    options.recordEvent("frames", sequence);
  });
  return () => ({
    budget_bytes: options.scenario.limits.output_bytes,
    observed_bytes: observedBytes,
    retained_bytes: outputBytes,
    observed_frames: observedFrames,
    retained_frames: options.frames.length,
  });
};

export const resolveProcessResult = (
  capture: PendingProcessCapture | ProcessCapture | undefined,
  executionFailure: unknown,
  cleanup: ProcessCaptureCleanupReport,
  observations?: IncompleteProcessCaptureObservations,
  partialContext?: {
    readonly scenario: ProcessScenario;
    readonly rootPid?: number;
  },
): ProcessCapture => {
  const cleanupFailure = cleanupReportFailure(cleanup);
  const executionFailureReason =
    describeProcessCaptureExecutionFailure(executionFailure);
  let partialObservation: PartialProcessCaptureObservation | undefined;
  if (
    (cleanupFailure !== undefined || executionFailure !== undefined) &&
    (capture !== undefined || observations !== undefined)
  ) {
    const normalizedObservations =
      observations === undefined || partialContext === undefined
        ? observations
        : normalizePartialProcessObservations(observations, partialContext);
    if (capture === undefined) {
      if (normalizedObservations !== undefined) {
        const partialResult = partialProcessCaptureObservationSchema.safeParse({
          observations: normalizedObservations,
          cleanup,
          execution_failure: executionFailureReason ?? null,
        });
        if (partialResult.success) partialObservation = partialResult.data;
      }
    } else {
      const captureData =
        "cleanup" in capture
          ? (() => {
              const { cleanup: _cleanup, ...data } = capture;
              void _cleanup;
              return data;
            })()
          : capture;
      const settlement =
        cleanupFailure !== undefined
          ? { ...capture.settlement, cleanup_outcome: "failed" as const }
          : capture.settlement.state === "quiesced"
            ? {
                ...capture.settlement,
                cleanup_outcome: "not_required" as const,
              }
            : { ...capture.settlement, cleanup_outcome: "cleaned" as const };
      const partialResult = partialProcessCaptureObservationSchema.safeParse({
        capture: { ...captureData, settlement },
        cleanup,
        execution_failure: executionFailureReason ?? null,
      });
      if (partialResult.success) partialObservation = partialResult.data;
    }
  }
  if (cleanupFailure !== undefined) {
    const cleanupResources = Object.entries(cleanup)
      .filter(
        ([, outcome]) =>
          outcome.state === "failed" || outcome.state === "unverified",
      )
      .map(([resource]) => resource);
    throw new ProcessCaptureError(cleanupFailure, {
      cause: executionFailure,
      reason: "cleanup_incomplete",
      cleanupResources,
      ...(executionFailureReason === undefined
        ? {}
        : { executionFailure: executionFailureReason }),
      ...(partialObservation === undefined ? {} : { partialObservation }),
      cleanupReport: cleanup,
    });
  }
  if (executionFailure instanceof ProcessCaptureError) {
    const retainedExecutionFailure =
      executionFailure.executionFailure ?? executionFailureReason;
    const retainedPartialObservation =
      executionFailure.partialObservation ?? partialObservation;
    throw new ProcessCaptureError(executionFailure.message, {
      cause: executionFailure,
      ...(executionFailure.userMessage === undefined
        ? {}
        : { userMessage: executionFailure.userMessage }),
      ...(executionFailure.userCategory === undefined
        ? {}
        : { userCategory: executionFailure.userCategory }),
      reason: executionFailure.reason,
      cleanupResources: executionFailure.cleanupResources,
      ...(retainedExecutionFailure === undefined
        ? {}
        : { executionFailure: retainedExecutionFailure }),
      ...(retainedPartialObservation === undefined
        ? {}
        : { partialObservation: retainedPartialObservation }),
      cleanupReport: executionFailure.cleanupReport ?? cleanup,
    });
  }
  if (executionFailure !== undefined) {
    throw new ProcessCaptureError("process capture failed", {
      cause: executionFailure,
      reason: "capture_failed",
      ...(executionFailureReason === undefined
        ? {}
        : { executionFailure: executionFailureReason }),
      ...(partialObservation === undefined ? {} : { partialObservation }),
      cleanupReport: cleanup,
    });
  }
  if (capture === undefined)
    throw new ProcessCaptureError("process capture produced no result");
  const unverifiedProcesses = cleanup.owned_process_group.unverified_processes;
  if ("cleanup" in capture && unverifiedProcesses === undefined) return capture;

  const settlement: UnverifiedProcessCapture["settlement"] =
    capture.settlement.state === "quiesced"
      ? { ...capture.settlement, cleanup_outcome: "not_required" }
      : { ...capture.settlement, cleanup_outcome: "cleaned" };
  try {
    return parseProcessCapture({
      ...capture,
      settlement,
      residual_unknowns: [
        ...capture.residual_unknowns,
        ...(unverifiedProcesses ?? []).map(({ pid, reason }) => ({
          scope: "process" as const,
          reason: `Ownership of unrelated process ${String(pid)} could not be verified; it was left untouched: ${reason}`,
        })),
      ],
      cleanup: {
        ...("cleanup" in capture ? capture.cleanup : {}),
        owned_process_group: "verified",
        temporary_root: "removed",
        ...(unverifiedProcesses === undefined
          ? {}
          : { unverified_processes: unverifiedProcesses }),
      },
    });
  } catch (cause: unknown) {
    throw new ProcessCaptureError(
      `process capture validation failed${cause instanceof Error ? `: ${cause.message}` : ""}`,
      { cause },
    );
  }
};

export const prepareProcessCapture = async (
  scenario: ProcessScenario,
  signal: AbortSignal | undefined,
  captureSnapshot: typeof snapshotRoots = snapshotRoots,
  host: ProcessPreparationHost = systemProcessPreparationHost,
): Promise<{
  readonly temporaryRoot: string;
  readonly runId: string;
  readonly ownershipBaseline: ProcessOwnershipBaseline;
  readonly before: ProcessFilesystemSnapshot;
}> => {
  assertNotCancelled(signal);
  await host.prepareOwnershipInspector?.(signal);
  assertNotCancelled(signal);
  const before = await captureSnapshot(scenario, signal);
  const runId = randomUUID();
  const temporaryRoot = await host.createTemporaryRoot();
  try {
    assertNotCancelled(signal);
    const ownershipBaseline =
      (await host.captureOwnershipBaseline?.(signal)) ?? [];
    assertNotCancelled(signal);
    return { temporaryRoot, runId, ownershipBaseline, before };
  } catch (cause: unknown) {
    const cleanup = await releaseProcessResources({
      timers: new Set(),
      terminal: undefined,
      renderer: undefined,
      runId,
      temporaryRoot,
      host: { ...processCaptureCleanupHost, removeTemporaryRoot: host.cleanup },
    });
    resolveProcessResult(
      undefined,
      normalizeCaptureFailure(cause, signal),
      cleanup,
      createProcessCaptureObservationBuffer({
        frames: [],
        interactions: [],
        samples: [],
        eventJournal: [],
        before,
        finalizationEnabled: scenario.finalization_ms > 0,
      }),
      { scenario },
    );
    throw cause;
  }
};

/** Filesystem seam for allocating and cleaning a capture's temporary root. */
export interface ProcessPreparationHost {
  prepareOwnershipInspector?(signal?: AbortSignal): Promise<void>;
  /** Capture the process baseline with the caller's startup cancellation. */
  captureOwnershipBaseline?(
    signal?: AbortSignal,
  ): Promise<ProcessOwnershipBaseline>;
  createTemporaryRoot(): Promise<string>;
  cleanup(path: string): Promise<void>;
}

const systemProcessPreparationHost: ProcessPreparationHost = {
  prepareOwnershipInspector: prepareProcessOwnershipInspection,
  captureOwnershipBaseline: (signal) =>
    systemProcessOwnershipHost.captureBaseline?.(signal) ?? Promise.resolve([]),
  createTemporaryRoot: () => mkdtemp(join(tmpdir(), "rea-process-")),
  cleanup: (path) => rm(path, { recursive: true, force: true }),
};
