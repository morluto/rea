import { err, ok, type Result } from "../domain/result.js";
import { AnalysisCleanupRelease } from "../domain/analysisCleanupRelease.js";
import type { AnalysisCleanupReleaseClaim } from "../domain/analysisErrorBase.js";
import { HOST_PLATFORM } from "../platform/HostPlatform.js";
import { DarwinProcessOwnershipInspectionError } from "./DarwinProcessRunTokenReader.js";
import {
  processInspectionCleanupFailures,
  type ProcessInspectionCleanupFailure,
} from "./ProcessInspectionCleanup.js";
import { assertProcessOwnershipInspectionActive } from "./ProcessInspectionCancellation.js";
import { ProcessAdmissionError } from "./ProcessAdmissionError.js";
import { nameSpawnedExecutable } from "./launchFailure.js";
import { spawn, type ChildProcess } from "node:child_process";
import type { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";

import { WindowsOwnedProcess } from "../windows/WindowsOwnedProcess.js";

import {
  materializeProcessOutputToken,
  ProcessOutputTokenScanner,
  type ProviderProcessOutputToken,
  type RawProcessOutputToken,
} from "./ProcessOutputTokenScanner.js";

import type {
  OwnedProcessGroup,
  ProcessOwnershipBaseline,
  ProcessCleanupFailure,
  ProcessCleanupResult,
  ProcessOwnershipHost,
} from "./ProcessOwnership.js";
import { cleanupOwnedProcessGroup } from "./ProcessOwnership.js";
import {
  prepareProcessOwnershipInspection,
  systemProcessOwnershipHost,
} from "./ProcessOwnershipObservation.js";
import { ProcessOwnershipEvidenceOwner } from "./ProcessOwnershipEvidence.js";
import { mergeEnvironmentOverrides } from "./snapshotEnvironment.js";
import {
  RUNTIME_EXHAUSTION_TOKENS,
  runtimeExhaustion,
  type ManagedRuntime,
  type RuntimeExhaustion,
} from "./RuntimeExhaustion.js";
import { isStrictUtf8 } from "../domain/strictUtf8.js";
import { errorMessage } from "../kernel/errorMessage.js";

const DEFAULT_TERMINATION_GRACE_MS = 250;
const DEFAULT_KILL_GRACE_MS = 1_000;
const OUTPUT_CLOSE_GRACE_MS = 1_000;
const MAX_LATE_OUTPUT_BYTES = 64 * 1024;

/** Spawn coordinates shared by owned, long-lived provider processes. */
export interface OwnedProviderProcessSpawnOptions {
  readonly command: string;
  readonly arguments: readonly string[];
  readonly runId: string;
  /** Null disables argv-prefix matching for interpreter-driven launch scripts. */
  readonly expectedCommand?: string | null;
  /** Preserve a pre-quoted Windows command-interpreter invocation exactly. */
  readonly windowsVerbatimArguments?: boolean;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Host platform used to choose detached process-group behavior. */
  readonly platform?: NodeJS.Platform;
  /** Host environment used as the base for the child environment. */
  readonly hostEnvironment?: NodeJS.ProcessEnv;
  /** Identity inspection owner shared by admission, baseline, and cleanup. */
  readonly ownershipHost?: ProcessOwnershipHost;
  /** Opt into a writable protocol stream; other providers retain ignored stdin. */
  readonly stdin?: "pipe";
  /**
   * Commit limit in bytes for the whole owned process tree, enforced by its
   * Windows Job Object. Other launchers cannot enforce it and refuse it.
   */
  readonly memoryLimitBytes?: number;
  /** Sweep exact run-token descendants during POSIX cleanup. */
  readonly sweepTokenOwnedProcesses?: boolean;
  /** Cancels native ownership preparation before provider process creation. */
  readonly signal?: AbortSignal;
}

/** Spawned process paired with the identity proof required for group cleanup. */
export interface SpawnedOwnedProviderProcess {
  readonly process: ProviderProcessHandle;
  readonly ownership: OwnedProcessGroup;
  readonly cleanup?: () => Promise<ProcessCleanupResult>;
  /** See the owned `ProviderProcessLaunch.requestStop`. */
  readonly requestStop?: (signal: NodeJS.Signals) => boolean;
}

/**
 * A command's own stop request before owned cleanup: `signal` goes to the
 * launched process group, and cleanup waits up to `graceMs` for the leader to
 * exit before it kills what remains. For a command that rolls back work it
 * started when asked to stop, such as `hdiutil attach` on SIGTERM.
 */
export interface ProcessTerminationPolicy {
  readonly signal: NodeJS.Signals;
  readonly graceMs: number;
}

/** Process events and streams required by provider lifecycle supervision. */
export interface ProviderProcessHandle extends Pick<
  EventEmitter,
  "on" | "once" | "off"
> {
  readonly pid?: number | undefined;
  readonly stdout: Readable | null;
  readonly stdin?: Writable | null;
  readonly stderr: Readable | null;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  /** True once an enforced process memory limit reported an allocation failure.
   * A live owner emits `memory-limit` on the first transition to true.
   */
  readonly memoryLimitReached?: boolean;
  /** True if a Windows backpressured stream was destroyed before output drained. */
  readonly outputIncomplete?: boolean;
  kill(signal?: NodeJS.Signals | number): boolean;
  unref?(): void;
  ref?(): void;
}

/** Process handle returned by a provider-specific launcher. */
export type ProviderProcessLaunch =
  | {
      readonly process: ProviderProcessHandle;
      readonly ownsProcessLifetime: false;
      readonly ownership?: never;
      readonly cleanup?: never;
    }
  | {
      readonly process: ProviderProcessHandle;
      readonly ownsProcessLifetime: true;
      readonly ownership?: OwnedProcessGroup;
      readonly cleanup?: () => Promise<ProcessCleanupResult>;
      /**
       * Signal the launched process group while its leader is unreaped, so the
       * leader's PID still names the group this launch created. False when
       * nothing was signaled, such as after the leader exited or on a host
       * without process groups.
       */
      readonly requestStop?: (signal: NodeJS.Signals) => boolean;
    };

/**
 * Process exit recorded by the supervisor.
 * Independent of retained stream diagnostics.
 */
export interface ProviderProcessExitObservation {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

/** Detached diagnostics captured for one supervised provider process. */
export interface ProviderProcessSnapshot {
  /** True when retained diagnostics omit bytes due to the budget or provider output loss. */
  readonly diagnosticTruncated?: boolean;
  readonly stdout: {
    readonly text: string;
    /** True when retained bytes cannot be represented exactly as UTF-8 text. */
    readonly invalidUtf8?: true;
    /** Bytes retained in text, limited by maxDiagnosticBytes when configured. */
    readonly bytes: number;
    /** All bytes drained from this stream since construction or resetOutput. */
    readonly observedBytes: number;
  };
  readonly stderr: {
    readonly text: string;
    /** True when retained bytes cannot be represented exactly as UTF-8 text. */
    readonly invalidUtf8?: true;
    /** Bytes retained in text, limited by maxDiagnosticBytes when configured. */
    readonly bytes: number;
    readonly observedBytes: number;
  };
  readonly exitCode: number | null | undefined;
  readonly signal: NodeJS.Signals | null | undefined;
  /** Present only when the process tree reached its enforced memory limit. */
  readonly memoryLimitReached?: true;
  /**
   * Present once this supervisor began stopping the process, before any signal
   * it sends. An exit signal observed without it did not come from the owner.
   */
  readonly stopRequested?: true;
  /** Present when a provider stream was destroyed before all bytes were observed. */
  readonly outputIncomplete?: true;
  /**
   * The latest memory exhaustion report of the supervised runtime, observed
   * from every drained byte regardless of the retention budget.
   */
  readonly runtimeExhaustion?: RuntimeExhaustion;
}

declare const processOutputCheckpointBrand: unique symbol;
/** Opaque cursor into one supervisor's raw, byte-counted output history. */
export interface ProviderProcessOutputCheckpoint {
  readonly [processOutputCheckpointBrand]: true;
}

/** Output produced after a checkpoint; incomplete when bytes were not retained or drained. */
export interface ProviderProcessOutputSince {
  readonly snapshot: ProviderProcessSnapshot;
  readonly complete: boolean;
  /**
   * Latest configured output marker per stream produced after the checkpoint,
   * observed from every drained byte regardless of the retention budget.
   */
  readonly markers?: readonly (ProviderProcessOutputToken & {
    readonly stream: "stdout" | "stderr";
  })[];
}

const outputCheckpoints = new WeakMap<
  ProviderProcessOutputCheckpoint,
  {
    readonly owner: ProviderProcessSupervisor;
    readonly epoch: number;
    readonly stdout: number;
    readonly stderr: number;
  }
>();

/** Resource-safe events emitted without imposing provider protocol semantics. */
export type ProviderProcessDiagnostic =
  | {
      readonly type: "output";
      readonly stream: "stdout" | "stderr";
      readonly bytes: number;
      readonly totalBytes: number;
      readonly truncated?: boolean;
    }
  | {
      readonly type: "exit";
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly snapshot: ProviderProcessSnapshot;
    }
  | {
      readonly type: "output-close";
      readonly snapshot: ProviderProcessSnapshot;
    }
  | {
      readonly type: "error";
      readonly message: string;
      readonly cause?: Error;
    };

/** Aggregate byte budget, or independent retained stdout and stderr byte budgets. */
export type ProcessDiagnosticBudget =
  | number
  | { readonly stdout: number; readonly stderr: number };

/** Options for process lifecycle diagnostics. */
export interface ProviderProcessSupervisorOptions {
  /** Retain stdout for diagnostics; disable when it carries a parsed protocol. Defaults to true. */
  readonly captureStdout?: boolean;
  /** Retained output budget; overflow is drained and reported, not retained. */
  readonly maxDiagnosticBytes?: ProcessDiagnosticBudget;
  /**
   * Which bytes the budget keeps: the first ones (the default), or each
   * stream's latest, where a failing command's last words are.
   */
  readonly diagnosticRetention?: "head" | "tail";
  readonly onDiagnostic?: (event: ProviderProcessDiagnostic) => void;
  /** Wake a waiter when a live process owner first observes a memory refusal. */
  readonly onMemoryLimit?: () => void;
}

/** One output token located before retention applies, so it survives an exhausted budget. */
export type ProviderProcessOutputTokenOptions =
  | {
      /**
       * Single-line token ending at a non-ASCII-word byte or EOF; its latest
       * occurrence is reported as a marker.
       */
      readonly outputToken?: string;
      readonly runtime?: never;
    }
  | {
      /**
       * The managed runtime this process hosts. Its memory exhaustion report is
       * the scanned token and is surfaced as `runtimeExhaustion`.
       */
      readonly runtime: ManagedRuntime;
      readonly outputToken?: never;
    };

/** Optional result of provider-specific cleanup performed before stop. */
export interface ProviderProcessStopOptions {
  readonly cleanupResult?: ProcessCleanupResult;
  readonly terminationGraceMs?: number;
  readonly killGraceMs?: number;
  /** The command's own stop request before owned group cleanup. */
  readonly termination?: ProcessTerminationPolicy;
}

/** Non-JSON snapshot of the exact inspection facts retained by a stop attempt. */
export interface ProviderProcessInspectionCleanup {
  readonly causes: readonly unknown[];
  readonly failures: readonly {
    readonly failure: ProcessInspectionCleanupFailure;
    readonly cause: unknown;
  }[];
}

/** Exact disposition of one owned process stop attempt. */
export type ProviderProcessStopResult =
  | {
      readonly status:
        | "not-owned"
        | "already-exited"
        | "verified-cleanup"
        | "terminated"
        | "killed";
    }
  | {
      readonly status: "incomplete";
      readonly reason: string;
      readonly cleanupResult?: ProcessCleanupFailure;
      /** Current retained capabilities and their exact originating inspection facts; never JSON diagnostics. */
      readonly inspectionCleanup?: ProviderProcessInspectionCleanup;
    };

const incompleteCleanup = (
  failure: ProcessCleanupFailure,
): ProviderProcessStopResult => ({
  status: "incomplete",
  reason: failure.reason,
  cleanupResult: failure,
});

/**
 * Spawn a provider in an owned Windows job or dedicated POSIX process group.
 *
 * The caller remains responsible for persisting any ownership manifest and for
 * selecting provider-specific command arguments or environment values.
 */
export const spawnOwnedProviderProcess = async (
  options: OwnedProviderProcessSpawnOptions,
): Promise<SpawnedOwnedProviderProcess> => {
  assertProcessOwnershipInspectionActive(options.signal);
  const ownershipHost = options.ownershipHost ?? systemProcessOwnershipHost;
  await prepareProcessOwnershipInspection(options.signal, ownershipHost);
  assertProcessOwnershipInspectionActive(options.signal);
  const platform = options.platform ?? HOST_PLATFORM.platform;
  const sweepTokenOwnedProcesses =
    options.sweepTokenOwnedProcesses === true && platform !== "win32";
  let captureBaseline: ProcessOwnershipBaseline | undefined;
  if (sweepTokenOwnedProcesses) {
    const capture = ownershipHost.captureBaseline;
    if (capture === undefined)
      throw new ProcessAdmissionError("baseline_unavailable");
    captureBaseline = await capture.call(ownershipHost, options.signal);
    assertProcessOwnershipInspectionActive(options.signal);
  }
  const hostEnvironment = options.hostEnvironment ?? process.env;
  const selectedEnvironment = mergeEnvironmentOverrides(
    hostEnvironment,
    options.env ?? {},
    platform,
  );
  // Ownership is the final layer, including when a caller used another casing.
  // Resolve undefined overrides before the launchers omit unset variables.
  const environment = mergeEnvironmentOverrides(
    selectedEnvironment,
    { REA_PROCESS_RUN_ID: options.runId },
    platform,
  );
  if (platform === "win32" && HOST_PLATFORM.platform === "win32") {
    const child = new WindowsOwnedProcess(
      options.command,
      options.arguments,
      options.cwd,
      environment,
      options.windowsVerbatimArguments ?? false,
      {
        protocolStdin: options.stdin === "pipe",
        ...(options.memoryLimitBytes === undefined
          ? {}
          : { memoryLimitBytes: options.memoryLimitBytes }),
      },
    );
    return {
      process: child,
      ownership: {
        runId: options.runId,
        leaderPid: child.pid,
        processGroupId: child.pid,
        expectedParentPid: process.pid,
      },
      cleanup: () => child.cleanup(),
    };
  }
  if (options.memoryLimitBytes !== undefined)
    throw new ProcessAdmissionError("memory_limit_unsupported");
  let child: ChildProcess;
  try {
    child = spawn(options.command, [...options.arguments], {
      shell: false,
      windowsHide: true,
      stdio: [options.stdin ?? "ignore", "pipe", "pipe"],
      detached: platform !== "win32",
      windowsVerbatimArguments: options.windowsVerbatimArguments ?? false,
      env: environment,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    });
  } catch (cause: unknown) {
    throw nameSpawnedExecutable(cause, options.command);
  }
  await waitForSpawn(child);
  const pid = child.pid;
  if (pid === undefined)
    throw new ProcessAdmissionError("launcher_pid_missing");
  const ownership: OwnedProcessGroup = {
    runId: options.runId,
    leaderPid: pid,
    processGroupId: pid,
    expectedParentPid: process.pid,
    evidenceOwner: new ProcessOwnershipEvidenceOwner(),
    ...(sweepTokenOwnedProcesses
      ? {
          sweepTokenOwnedProcesses: true,
          captureBaseline: captureBaseline!,
        }
      : {}),
    ...(options.expectedCommand === null
      ? {}
      : { expectedCommand: options.expectedCommand ?? options.command }),
  };
  return {
    process: child,
    ownership,
    // Preserve the default launch contract: callers may own direct-child cleanup.
    ...(options.ownershipHost === undefined
      ? {}
      : { cleanup: () => cleanupOwnedProcessGroup(ownership, ownershipHost) }),
    requestStop: (signal) => signalUnreapedGroup(child, pid, signal),
  };
};

/**
 * Node sets exitCode or signalCode in the callback that reaps the leader, so
 * until then the leader's PID still names the group the launch created.
 */
const signalUnreapedGroup = (
  child: ChildProcess,
  processGroupId: number,
  signal: NodeJS.Signals,
): boolean => {
  if (child.exitCode !== null || child.signalCode !== null) return false;
  try {
    process.kill(-processGroupId, signal);
    return true;
  } catch {
    return false;
  }
};

/**
 * Supervises only generic process resources; wire protocol remains adapter-owned.
 *
 * Output retention is complete per stream; adapters own resource budgets. Stop
 * first honors token-verified group cleanup when supplied, otherwise it uses a
 * bounded TERM-to-KILL escalation for a directly owned child.
 */
export class ProviderProcessSupervisor {
  readonly #options: ProviderProcessSupervisorOptions &
    ProviderProcessOutputTokenOptions;
  readonly #stdout = new ProcessOutputCapture();
  readonly #stderr = new ProcessOutputCapture();
  readonly #exit = deferred<ProviderProcessExitObservation>();
  readonly #outputClose = deferred<void>();
  #outputClosed = false;
  #outputIncomplete = false;
  #stdoutObservedBytes = 0;
  #stderrObservedBytes = 0;
  #diagnosticTruncated = false;
  #stdoutMarker: ProcessOutputTokenScanner | undefined;
  #stderrMarker: ProcessOutputTokenScanner | undefined;
  readonly #onStdout = (chunk: Buffer | string): void => {
    this.#capture("stdout", this.#stdout, chunk);
  };
  readonly #onStderr = (chunk: Buffer | string): void => {
    this.#capture("stderr", this.#stderr, chunk);
  };
  readonly #onStdoutEnd = (): void => {
    this.#stdoutMarker?.finish();
  };
  readonly #onStderrEnd = (): void => {
    this.#stderrMarker?.finish();
  };
  readonly #onStdoutError = (cause: Error): void => {
    this.#recordStreamError("stdout", cause);
  };
  readonly #onStderrError = (cause: Error): void => {
    this.#recordStreamError("stderr", cause);
  };
  readonly #onExit = (
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void => {
    this.#recordExit(code, signal);
  };
  readonly #onClose = (
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void => {
    this.#recordExit(code, signal);
    this.#outputClosed = true;
    const onDiagnostic = this.#options.onDiagnostic;
    if (!this.#disposed && onDiagnostic !== undefined) {
      const raw = this.#captureSnapshotRaw();
      onDiagnostic(
        diagnosticEventWithLazySnapshot({ type: "output-close" }, raw),
      );
    }
    this.#outputClose.resolve(undefined);
  };
  readonly #onMemoryLimit = (): void => {
    this.#options.onMemoryLimit?.();
  };
  readonly #onError = (cause: Error): void => {
    this.#options.onDiagnostic?.({
      type: "error",
      message: cause.message,
      cause,
    });
  };
  #exitObservation: ProviderProcessExitObservation | undefined;
  #stopPromise: Promise<ProviderProcessStopResult> | undefined;
  #stopRequested = false;
  readonly #release = new AnalysisCleanupRelease();
  #disposed = false;
  #maxAggregateDiagnosticBytes: number | undefined;
  readonly #maxStreamDiagnosticBytes:
    | Exclude<ProcessDiagnosticBudget, number>
    | undefined;
  #outputEpoch = 0;
  readonly #inspectionCleanup = new Map<
    object,
    {
      readonly failure: ProcessInspectionCleanupFailure;
      readonly origin: unknown;
      cause: unknown;
    }
  >();

  constructor(
    readonly launch: ProviderProcessLaunch,
    options: ProviderProcessSupervisorOptions &
      ProviderProcessOutputTokenOptions = {},
  ) {
    this.#options = options;
    const budget = options.maxDiagnosticBytes;
    if (typeof budget === "number") this.#maxAggregateDiagnosticBytes = budget;
    else if (budget !== undefined)
      this.#maxStreamDiagnosticBytes = {
        stdout: budget.stdout,
        stderr: budget.stderr,
      };
    this.#resetMarkers();
    if (options.captureStdout !== false)
      this.#attach(launch.process.stdout, "stdout");
    this.#attach(launch.process.stderr, "stderr");
    launch.process.once("exit", this.#onExit);
    launch.process.once("close", this.#onClose);
    launch.process.on("error", this.#onError);
    if (this.#options.onMemoryLimit !== undefined)
      launch.process.once("memory-limit", this.#onMemoryLimit);
    if (launch.process.exitCode !== null || launch.process.signalCode !== null)
      this.#recordExit(launch.process.exitCode, launch.process.signalCode);
  }

  /**
   * Recorded process exit without concatenating retained stream diagnostics.
   * Undefined until exit or close is observed.
   */
  observedExit(): ProviderProcessExitObservation | undefined {
    const exit = this.#exitObservation;
    if (exit === undefined) return undefined;
    return { code: exit.code, signal: exit.signal };
  }

  /** Whether the process owner acknowledged output closure, separately from exit. */
  observedOutputClose(): boolean {
    return this.#outputClosed;
  }

  /** Latest retained output and exit observation, with explicit configured truncation. */
  snapshot(): ProviderProcessSnapshot {
    const outputIncomplete =
      this.#outputIncomplete || this.launch.process.outputIncomplete === true;
    return {
      ...(this.#diagnosticTruncated || outputIncomplete
        ? { diagnosticTruncated: true }
        : {}),
      stdout: this.#stdout.snapshot(this.#stdoutObservedBytes),
      stderr: this.#stderr.snapshot(this.#stderrObservedBytes),
      exitCode: this.#exitObservation?.code,
      signal: this.#exitObservation?.signal,
      ...(this.launch.process.memoryLimitReached === true
        ? { memoryLimitReached: true }
        : {}),
      ...(this.#stopRequested ? { stopRequested: true } : {}),
      ...(outputIncomplete ? { outputIncomplete: true } : {}),
      ...this.#runtimeExhaustionWithin({ stdout: 0, stderr: 0 }),
    };
  }

  /** Capture event-time bytes and flags without materializing UTF-8 strings yet. */
  #captureSnapshotRaw(): RawProviderProcessSnapshot {
    const outputIncomplete =
      this.#outputIncomplete || this.launch.process.outputIncomplete === true;
    return {
      diagnosticTruncated: this.#diagnosticTruncated || outputIncomplete,
      stdout: this.#stdout.snapshotRaw(this.#stdoutObservedBytes),
      stderr: this.#stderr.snapshotRaw(this.#stderrObservedBytes),
      exitCode: this.#exitObservation?.code,
      signal: this.#exitObservation?.signal,
      memoryLimitReached: this.launch.process.memoryLimitReached === true,
      stopRequested: this.#stopRequested,
      outputIncomplete,
      runtimeExhaustion: this.#captureRuntimeExhaustionWithin({
        stdout: 0,
        stderr: 0,
      }),
    };
  }

  /** Mark the current raw-byte position without copying or retaining output. */
  checkpointOutput(): ProviderProcessOutputCheckpoint {
    const checkpoint = Object.freeze({}) as ProviderProcessOutputCheckpoint;
    outputCheckpoints.set(checkpoint, {
      owner: this,
      epoch: this.#outputEpoch,
      stdout: this.#stdoutObservedBytes,
      stderr: this.#stderrObservedBytes,
    });
    return checkpoint;
  }

  /** Snapshot only bytes produced after a valid checkpoint on this supervisor. */
  snapshotOutputSince(
    checkpoint: ProviderProcessOutputCheckpoint,
  ): ProviderProcessOutputSince {
    const position =
      typeof checkpoint === "object" && checkpoint !== null
        ? outputCheckpoints.get(checkpoint)
        : undefined;
    if (
      position === undefined ||
      position.owner !== this ||
      position.epoch !== this.#outputEpoch
    )
      return {
        snapshot: {
          stdout: { text: "", bytes: 0, observedBytes: 0 },
          stderr: { text: "", bytes: 0, observedBytes: 0 },
          exitCode: this.#exitObservation?.code,
          signal: this.#exitObservation?.signal,
          outputIncomplete: true,
          diagnosticTruncated: true,
        },
        complete: false,
      };
    const stdout = this.#stdout.snapshotRange(
      position.stdout,
      this.#stdoutObservedBytes,
    );
    const stderr = this.#stderr.snapshotRange(
      position.stderr,
      this.#stderrObservedBytes,
    );
    const incomplete =
      stdout.complete === false ||
      stderr.complete === false ||
      this.#outputIncomplete ||
      this.launch.process.outputIncomplete === true;
    return {
      snapshot: {
        ...(incomplete ? { diagnosticTruncated: true } : {}),
        stdout: stdout.stream,
        stderr: stderr.stream,
        exitCode: this.#exitObservation?.code,
        signal: this.#exitObservation?.signal,
        ...(this.launch.process.memoryLimitReached === true
          ? { memoryLimitReached: true }
          : {}),
        ...(incomplete ? { outputIncomplete: true } : {}),
        ...this.#runtimeExhaustionWithin(position),
      },
      complete: !incomplete,
      ...this.#markersWithin(position),
    };
  }

  #markersWithin(position: {
    readonly stdout: number;
    readonly stderr: number;
  }): Pick<ProviderProcessOutputSince, "markers"> {
    const stdout = this.#stdoutMarker?.latestWithin(
      position.stdout,
      this.#stdoutObservedBytes,
    );
    const stderr = this.#stderrMarker?.latestWithin(
      position.stderr,
      this.#stderrObservedBytes,
    );
    const markers = [
      ...(stdout === undefined
        ? []
        : [{ stream: "stdout" as const, ...stdout }]),
      ...(stderr === undefined
        ? []
        : [{ stream: "stderr" as const, ...stderr }]),
    ];
    return markers.length === 0 ? {} : { markers };
  }

  /** The runtime's exhaustion report after a position; stderr is preferred. */
  #captureRuntimeExhaustionWithin(position: {
    readonly stdout: number;
    readonly stderr: number;
  }): RawRuntimeExhaustion | undefined {
    const runtime = this.#options.runtime;
    if (runtime === undefined) return undefined;
    const stderr = this.#stderrMarker?.snapshotLatestWithin(
      position.stderr,
      this.#stderrObservedBytes,
    );
    if (stderr !== undefined)
      return { runtime, stream: "stderr", token: stderr };
    const stdout = this.#stdoutMarker?.snapshotLatestWithin(
      position.stdout,
      this.#stdoutObservedBytes,
    );
    return stdout === undefined
      ? undefined
      : { runtime, stream: "stdout", token: stdout };
  }

  #runtimeExhaustionWithin(position: {
    readonly stdout: number;
    readonly stderr: number;
  }): Pick<ProviderProcessSnapshot, "runtimeExhaustion"> {
    const raw = this.#captureRuntimeExhaustionWithin(position);
    return raw === undefined
      ? {}
      : { runtimeExhaustion: materializeRuntimeExhaustion(raw) };
  }

  #resetMarkers(): void {
    const runtime = this.#options.runtime;
    const marker =
      runtime === undefined
        ? this.#options.outputToken
        : RUNTIME_EXHAUSTION_TOKENS[runtime];
    this.#stdoutMarker =
      marker === undefined ? undefined : new ProcessOutputTokenScanner(marker);
    this.#stderrMarker =
      marker === undefined ? undefined : new ProcessOutputTokenScanner(marker);
  }

  /** Begin a new observation on a retained process without retaining earlier output. */
  resetOutput(): void {
    this.#outputEpoch += 1;
    this.#stdout.reset();
    this.#stderr.reset();
    this.#stdoutObservedBytes = 0;
    this.#stderrObservedBytes = 0;
    this.#diagnosticTruncated = false;
    this.#resetMarkers();
  }

  /** Wait for process exit up to a caller-owned bounded interval. */
  async waitForExit(timeoutMs: number): Promise<boolean> {
    return waitForProcessEvent(
      this.#exitObservation !== undefined,
      this.#exit.promise,
      timeoutMs,
    );
  }

  /** Wait until output streams close; omit the timeout to await physical completion.
   * WindowsOwnedProcess closes only after its whole Job Object settles.
   */
  async waitForOutputClose(
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return waitForProcessEvent(
      this.#outputClosed,
      this.#outputClose.promise,
      timeoutMs,
      signal,
    );
  }

  /** Bound additional retained bytes while still draining all later output. */
  limitAdditionalOutputBytes(maxBytes: number): void {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
      throw new RangeError(
        "Additional output limit must be a non-negative safe integer.",
      );
    const retained = this.#stdout.bytes + this.#stderr.bytes;
    const requestedLimit = Math.min(
      Number.MAX_SAFE_INTEGER,
      retained + maxBytes,
    );
    this.#maxAggregateDiagnosticBytes =
      this.#maxAggregateDiagnosticBytes === undefined
        ? requestedLimit
        : Math.min(this.#maxAggregateDiagnosticBytes, requestedLimit);
  }

  /** Unreference inherited output pipes without closing streams shared with descendants. */
  unrefOutputStreams(): void {
    for (const stream of [
      this.launch.process.stdout,
      this.launch.process.stderr,
    ]) {
      const unref = (stream as (Readable & { unref?: () => void }) | null)
        ?.unref;
      unref?.call(stream);
    }
  }

  /** Adopt only explicit inspection capabilities into this process owner's existing lifetime. */
  retainInspectionFailure(cause: unknown): void {
    for (const failure of processInspectionCleanupFailures(cause)) {
      const owner =
        failure instanceof DarwinProcessOwnershipInspectionError
          ? failure.cleanupOwner
          : failure.owner;
      const key = owner ?? failure;
      if (this.#inspectionCleanup.has(key)) continue;
      this.#inspectionCleanup.set(key, {
        failure,
        origin: cause,
        cause:
          failure instanceof DarwinProcessOwnershipInspectionError
            ? (failure.cleanupFailure ?? failure)
            : failure.cleanupCause,
      });
    }
  }

  async #retryInspectionCleanup(): Promise<void> {
    for (const [key, retained] of this.#inspectionCleanup) {
      const owner =
        retained.failure instanceof DarwinProcessOwnershipInspectionError
          ? retained.failure.cleanupOwner
          : retained.failure.owner;
      if (owner === undefined) continue;
      try {
        await owner.close();
        this.#inspectionCleanup.delete(key);
      } catch (cause: unknown) {
        retained.cause = cause;
      }
    }
  }

  #inspectionCleanupSnapshot(): ProviderProcessInspectionCleanup {
    const retained = [...this.#inspectionCleanup.values()];
    return {
      causes: [...new Set(retained.map(({ origin }) => origin))],
      failures: retained.map(({ failure, cause }) => ({ failure, cause })),
    };
  }

  /** Retry only held inspection resources; success makes no process-cleanup claim. */
  async retryInspectionCleanup(): Promise<
    Result<void, ProviderProcessInspectionCleanup>
  > {
    await this.#retryInspectionCleanup();
    return this.#inspectionCleanup.size === 0
      ? ok(undefined)
      : err(this.#inspectionCleanupSnapshot());
  }

  #inspectionStopFailure(reason: string): ProviderProcessStopResult {
    return {
      status: "incomplete",
      reason,
      ...(this.#inspectionCleanup.size === 0
        ? {}
        : { inspectionCleanup: this.#inspectionCleanupSnapshot() }),
    };
  }

  /**
   * Confirmed once a stop proves this process ended; errors reporting the
   * process read it instead of being told.
   */
  get cleanupRelease(): AnalysisCleanupReleaseClaim {
    return this.#release;
  }

  /** Share each stop attempt; incomplete cleanup retains ownership and permits retry. */
  stop(
    options: ProviderProcessStopOptions = {},
  ): Promise<ProviderProcessStopResult> {
    if (this.launch.ownsProcessLifetime && this.#exitObservation === undefined)
      this.#stopRequested = true;
    this.#stopPromise ??= this.#stop(options).then((result) => {
      if (result.status === "incomplete") this.#stopPromise = undefined;
      else if (result.status !== "not-owned") this.#release.confirm();
      return result;
    });
    return this.#stopPromise;
  }

  /** Detach capture and process listeners after an adapter releases ownership. */
  dispose(): void {
    if (this.#disposed) return;
    // Releasing capture before close cannot establish a complete output history.
    if (!this.#outputClosed) this.#outputIncomplete = true;
    this.#disposed = true;
    this.launch.process.stdout?.off("data", this.#onStdout);
    this.launch.process.stdout?.off("error", this.#onStdoutError);
    this.launch.process.stdout?.off("end", this.#onStdoutEnd);
    this.launch.process.stderr?.off("data", this.#onStderr);
    this.launch.process.stderr?.off("error", this.#onStderrError);
    this.launch.process.stderr?.off("end", this.#onStderrEnd);
    this.launch.process.off("exit", this.#onExit);
    this.launch.process.off("close", this.#onClose);
    this.launch.process.off("error", this.#onError);
    this.launch.process.off("memory-limit", this.#onMemoryLimit);
  }

  /** Release event-loop references so incomplete cleanup does not prevent host exit. */
  unref(): void {
    const process = this.launch.process;
    process.unref?.();
    (process.stdin as { unref?: () => void } | null | undefined)?.unref?.();
    (process.stdout as { unref?: () => void } | null | undefined)?.unref?.();
    (process.stderr as { unref?: () => void } | null | undefined)?.unref?.();
  }

  /** Restore event-loop references when retrying supervised process cleanup. */
  ref(): void {
    const process = this.launch.process;
    process.ref?.();
    (process.stdin as { ref?: () => void } | null | undefined)?.ref?.();
    (process.stdout as { ref?: () => void } | null | undefined)?.ref?.();
    (process.stderr as { ref?: () => void } | null | undefined)?.ref?.();
  }

  async #stop(
    options: ProviderProcessStopOptions,
  ): Promise<ProviderProcessStopResult> {
    if (this.launch.ownsProcessLifetime) {
      this.ref();
      // Bound retention throughout termination and failed cleanup, including retries.
      this.limitAdditionalOutputBytes(MAX_LATE_OUTPUT_BYTES);
    }
    let completed = false;
    try {
      const result = await this.#stopWithin(options);
      completed = result.status !== "incomplete";
      if (completed && result.status !== "not-owned" && !this.#outputClosed) {
        // Exit proves process lifetime only. Bound final retention while draining
        // inherited pipes; a lost output tail does not revoke verified cleanup.
        if (!(await this.waitForOutputClose(OUTPUT_CLOSE_GRACE_MS))) {
          this.#outputIncomplete = true;
          this.unref();
        }
      }
      if (!completed) this.unref();
      return result;
    } finally {
      if (completed) this.dispose();
    }
  }

  async #stopWithin(
    options: ProviderProcessStopOptions,
  ): Promise<ProviderProcessStopResult> {
    try {
      if (!this.launch.ownsProcessLifetime) return { status: "not-owned" };
      await this.#retryInspectionCleanup();
      if (this.#inspectionCleanup.size > 0)
        return this.#inspectionStopFailure(
          [...this.#inspectionCleanup.values()]
            .map(({ cause }) => errorMessage(cause))
            .join("; "),
        );
      if (this.launch.cleanup !== undefined) {
        // The command's own stop request comes first; owned cleanup then
        // kills whatever remains, so the grace period only delays it.
        if (
          options.termination !== undefined &&
          options.cleanupResult === undefined &&
          this.#exitObservation === undefined &&
          this.launch.requestStop?.(options.termination.signal) === true
        )
          await this.waitForExit(options.termination.graceMs);
        const graceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
        const exitObservedBeforeCleanup = this.#exitObservation !== undefined;
        const cleanup = await this.#ownedCleanup(options.cleanupResult);
        if (!cleanup.cleaned) {
          // Process tables can show the launcher mid-exit until verification
          // gives up. The supervisor's own exit observation is positive proof
          // that verification lacked, so verify again only after it arrives.
          if (exitObservedBeforeCleanup || !(await this.waitForExit(graceMs)))
            return incompleteCleanup(cleanup);
          const settled = await this.launch.cleanup();
          return settled.cleaned
            ? { status: "verified-cleanup" }
            : incompleteCleanup(settled);
        }
        if (await this.waitForExit(graceMs))
          return { status: "verified-cleanup" };
        const retried = await this.launch.cleanup();
        if (!retried.cleaned) return incompleteCleanup(retried);
        if (await this.waitForExit(graceMs))
          return { status: "verified-cleanup" };
        return {
          status: "incomplete",
          reason: "verified process-group cleanup did not stop the launcher",
        };
      }

      if (this.#exitObservation !== undefined)
        return { status: "already-exited" };

      this.#signal("SIGTERM");
      if (
        await this.waitForExit(
          options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS,
        )
      )
        return { status: "terminated" };
      this.#signal("SIGKILL");
      if (await this.waitForExit(options.killGraceMs ?? DEFAULT_KILL_GRACE_MS))
        return { status: "killed" };
      return {
        status: "incomplete",
        reason: "owned provider process did not exit after SIGKILL",
      };
    } catch (cause: unknown) {
      this.retainInspectionFailure(cause);
      return this.#inspectionStopFailure(
        cause instanceof Error
          ? cause.message
          : "owned provider process cleanup failed",
      );
    }
  }

  #ownedCleanup(
    supplied: ProcessCleanupResult | undefined,
  ): Promise<ProcessCleanupResult> {
    if (supplied !== undefined) return Promise.resolve(supplied);
    const cleanup = this.launch.cleanup;
    return cleanup === undefined
      ? Promise.resolve({
          cleaned: false,
          reason: "owned provider process has no cleanup capability",
        })
      : cleanup();
  }

  #signal(signal: NodeJS.Signals): void {
    if (this.#exitObservation !== undefined) return;
    this.launch.process.kill(signal);
  }

  #attach(stream: Readable | null, name: "stdout" | "stderr"): void {
    if (name === "stdout") {
      stream?.on("data", this.#onStdout);
      stream?.on("error", this.#onStdoutError);
      stream?.on("end", this.#onStdoutEnd);
    } else {
      stream?.on("data", this.#onStderr);
      stream?.on("error", this.#onStderrError);
      stream?.on("end", this.#onStderrEnd);
    }
  }

  #recordStreamError(stream: "stdout" | "stderr", cause: Error): void {
    this.#outputIncomplete = true;
    this.#options.onDiagnostic?.({
      type: "error",
      message: `${stream} stream failed: ${cause.message}`,
      cause,
    });
  }

  #capture(
    stream: "stdout" | "stderr",
    capture: ProcessOutputCapture,
    chunk: Buffer | string,
  ): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (stream === "stdout") {
      this.#stdoutMarker?.scan(bytes, this.#stdoutObservedBytes);
      this.#stdoutObservedBytes += bytes.byteLength;
    } else {
      this.#stderrMarker?.scan(bytes, this.#stderrObservedBytes);
      this.#stderrObservedBytes += bytes.byteLength;
    }
    const aggregateRemaining =
      this.#maxAggregateDiagnosticBytes === undefined
        ? bytes.byteLength
        : Math.max(
            0,
            this.#maxAggregateDiagnosticBytes -
              this.#stdout.bytes -
              this.#stderr.bytes,
          );
    const streamLimit = this.#maxStreamDiagnosticBytes?.[stream];
    const streamRemaining =
      streamLimit === undefined
        ? bytes.byteLength
        : Math.max(0, streamLimit - capture.bytes);
    let truncated: boolean;
    if (this.#options.diagnosticRetention === "tail") {
      // The stream may give up its own earlier bytes to keep these.
      const limit = Math.min(
        capture.bytes + aggregateRemaining,
        streamLimit ?? Number.MAX_SAFE_INTEGER,
      );
      truncated = capture.appendTail(bytes, limit) > 0;
    } else {
      const retained = Math.min(
        bytes.byteLength,
        aggregateRemaining,
        streamRemaining,
      );
      if (retained > 0) capture.append(bytes.subarray(0, retained));
      truncated = retained < bytes.byteLength;
    }
    if (truncated) this.#diagnosticTruncated = true;
    this.#options.onDiagnostic?.({
      type: "output",
      stream,
      bytes: bytes.byteLength,
      totalBytes:
        stream === "stdout"
          ? this.#stdoutObservedBytes
          : this.#stderrObservedBytes,
      ...(truncated ? { truncated: true } : {}),
    });
  }

  #recordExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.#exitObservation !== undefined) return;
    this.#exitObservation = { code, signal };
    this.#exit.resolve(this.#exitObservation);
    const onDiagnostic = this.#options.onDiagnostic;
    if (onDiagnostic === undefined) return;
    const raw = this.#captureSnapshotRaw();
    onDiagnostic(
      diagnosticEventWithLazySnapshot({ type: "exit", code, signal }, raw),
    );
  }
}

interface RawRuntimeExhaustion {
  readonly runtime: ManagedRuntime;
  readonly stream: "stdout" | "stderr";
  readonly token: RawProcessOutputToken;
}

interface RawOutputCapture {
  readonly chunks: readonly Buffer[];
  readonly bytes: number;
  readonly observedBytes: number;
}

interface RawProviderProcessSnapshot {
  readonly diagnosticTruncated: boolean;
  readonly stdout: RawOutputCapture;
  readonly stderr: RawOutputCapture;
  readonly exitCode: number | null | undefined;
  readonly signal: NodeJS.Signals | null | undefined;
  readonly memoryLimitReached: boolean;
  readonly stopRequested: boolean;
  readonly outputIncomplete: boolean;
  readonly runtimeExhaustion: RawRuntimeExhaustion | undefined;
}

const materializeRuntimeExhaustion = (
  raw: RawRuntimeExhaustion,
): RuntimeExhaustion =>
  runtimeExhaustion(
    raw.runtime,
    raw.stream,
    materializeProcessOutputToken(raw.token),
  );

const materializeProviderProcessSnapshot = (
  raw: RawProviderProcessSnapshot,
): ProviderProcessSnapshot => ({
  ...(raw.diagnosticTruncated ? { diagnosticTruncated: true } : {}),
  stdout: materializeCapturedOutput(
    raw.stdout.chunks,
    raw.stdout.bytes,
    raw.stdout.observedBytes,
  ),
  stderr: materializeCapturedOutput(
    raw.stderr.chunks,
    raw.stderr.bytes,
    raw.stderr.observedBytes,
  ),
  exitCode: raw.exitCode,
  signal: raw.signal,
  ...(raw.memoryLimitReached ? { memoryLimitReached: true } : {}),
  ...(raw.stopRequested ? { stopRequested: true } : {}),
  ...(raw.outputIncomplete ? { outputIncomplete: true } : {}),
  ...(raw.runtimeExhaustion === undefined
    ? {}
    : {
        runtimeExhaustion: materializeRuntimeExhaustion(raw.runtimeExhaustion),
      }),
});

const diagnosticEventWithLazySnapshot = <
  Event extends { readonly type: "exit" | "output-close" },
>(
  fields: Event,
  raw: RawProviderProcessSnapshot,
): Event & { readonly snapshot: ProviderProcessSnapshot } => {
  let pending: RawProviderProcessSnapshot | undefined = raw;
  let snapshot: ProviderProcessSnapshot | undefined;
  return Object.defineProperty({ ...fields }, "snapshot", {
    enumerable: true,
    get() {
      if (snapshot === undefined) {
        snapshot = materializeProviderProcessSnapshot(pending!);
        pending = undefined;
      }
      return snapshot;
    },
  }) as Event & { readonly snapshot: ProviderProcessSnapshot };
};

const EMPTY_CHUNKS: readonly Buffer[] = [];
const DISCARDED_CHUNK = Buffer.alloc(0);
const EMPTY_OUTPUT_BUFFER = Buffer.alloc(0);

const materializeCapturedOutput = (
  chunks: readonly Buffer[],
  bytes: number,
  observedBytes: number,
): ProviderProcessSnapshot["stdout"] => {
  const buffer =
    chunks.length === 0
      ? EMPTY_OUTPUT_BUFFER
      : chunks.length === 1
        ? chunks[0]!
        : Buffer.concat(chunks, bytes);
  return snapshotOutputBuffer(buffer, observedBytes);
};

const snapshotOutputBuffer = (
  buffer: Buffer,
  observedBytes: number,
): ProviderProcessSnapshot["stdout"] => {
  if (buffer.byteLength === 0) return { text: "", bytes: 0, observedBytes };
  const text = buffer.toString("utf8");
  const invalidUtf8 = !isStrictUtf8(buffer);
  return {
    text,
    bytes: buffer.byteLength,
    observedBytes,
    ...(invalidUtf8 ? { invalidUtf8: true } : {}),
  };
};

class ProcessOutputCapture {
  #chunks: Buffer[] = [];
  #head = 0;
  #headOffset = 0;
  // Copy-on-write: shared with pending lazy snapshots until the next mutation or reset.
  #sharedChunks = false;
  // not-an-allowance: retained length of a tail buffer that drops its front past the limit instead of refusing input.
  #bytes = 0;
  /** Observed bytes before the first retained one, which tail retention dropped. */
  #start = 0;

  get bytes(): number {
    return this.#bytes;
  }

  #activeChunks(): Buffer[] {
    if (this.#head === 0 && this.#headOffset === 0) return this.#chunks;
    const active = this.#chunks.slice(this.#head);
    if (active.length > 0 && this.#headOffset > 0)
      active[0] = active[0]!.subarray(this.#headOffset);
    return active;
  }

  #mutableChunks(): Buffer[] {
    if (this.#sharedChunks) {
      this.#chunks = this.#chunks.slice();
      this.#sharedChunks = false;
    }
    return this.#chunks;
  }

  reset(): void {
    if (this.#sharedChunks) {
      this.#chunks = [];
      this.#sharedChunks = false;
    } else {
      this.#chunks.length = 0;
    }
    this.#head = 0;
    this.#headOffset = 0;
    this.#bytes = 0;
    this.#start = 0;
  }

  append(chunk: Buffer): void {
    this.#bytes += chunk.byteLength;
    this.#mutableChunks().push(Buffer.from(chunk));
  }

  /**
   * Keep the latest `limit` bytes; returns how many observed bytes this
   * dropped. A UTF-8 character the cut splits is dropped whole.
   */
  appendTail(chunk: Buffer, limit: number): number {
    const before = this.#start;
    const kept = chunk.subarray(Math.max(0, chunk.byteLength - limit));
    this.append(kept);
    this.#start += chunk.byteLength - kept.byteLength;
    const cut = kept.byteLength < chunk.byteLength || this.#bytes > limit;
    this.#dropFront(this.#bytes - limit, cut);
    return this.#start - before;
  }

  /** Drop the first `count` retained bytes and, after a cut, the rest of a character it split. */
  #dropFront(count: number, cut: boolean): void {
    let remaining = Math.max(0, count);
    while (this.#head < this.#chunks.length) {
      const first = this.#chunks[this.#head]!;
      const available = first.byteLength - this.#headOffset;
      let drop = Math.min(remaining, available);
      // UTF-8 continuation bytes are 0b10xxxxxx.
      while (
        cut &&
        drop < available &&
        ((first[this.#headOffset + drop] ?? 0) & 0xc0) === 0x80
      )
        drop += 1;
      this.#bytes -= drop;
      this.#start += drop;
      remaining -= Math.min(remaining, drop);
      if (drop === available) {
        this.#chunks[this.#head] = DISCARDED_CHUNK;
        this.#head += 1;
        this.#headOffset = 0;
      } else {
        if (drop > 0) this.#headOffset += drop;
        break;
      }
    }
    if (this.#head === this.#chunks.length) {
      if (this.#sharedChunks) {
        this.#chunks = [];
        this.#sharedChunks = false;
      } else {
        this.#chunks.length = 0;
      }
      this.#head = 0;
      this.#headOffset = 0;
    } else if (this.#head >= 64 && this.#head * 2 >= this.#chunks.length) {
      this.#chunks = this.#chunks.slice(this.#head);
      this.#head = 0;
      this.#sharedChunks = false;
    }
  }

  snapshotRaw(observedBytes: number): RawOutputCapture {
    if (this.#head >= this.#chunks.length)
      return { chunks: EMPTY_CHUNKS, bytes: 0, observedBytes };
    if (this.#head > 0 || this.#headOffset > 0) {
      this.#chunks = this.#activeChunks();
      this.#head = 0;
      this.#headOffset = 0;
    }
    this.#sharedChunks = true;
    return {
      chunks: this.#chunks,
      bytes: this.#bytes,
      observedBytes,
    };
  }

  snapshot(observedBytes: number): ProviderProcessSnapshot["stdout"] {
    return materializeCapturedOutput(
      this.#activeChunks(),
      this.#bytes,
      observedBytes,
    );
  }

  snapshotRange(
    start: number,
    end: number,
  ): { stream: ProviderProcessSnapshot["stdout"]; complete: boolean } {
    // Positions are observed bytes; the retained ones start at #start.
    const retainedEnd = this.#start + this.#bytes;
    const availableEnd = Math.max(this.#start, Math.min(end, retainedEnd));
    const availableStart = Math.min(Math.max(start, this.#start), availableEnd);
    const chunks: Buffer[] = [];
    let offset = this.#start;
    for (let index = this.#head; index < this.#chunks.length; index += 1) {
      const raw = this.#chunks[index]!;
      const chunk =
        index === this.#head && this.#headOffset > 0
          ? raw.subarray(this.#headOffset)
          : raw;
      const chunkEnd = offset + chunk.byteLength;
      const from = Math.max(availableStart, offset);
      const to = Math.min(availableEnd, chunkEnd);
      if (to > from) chunks.push(chunk.subarray(from - offset, to - offset));
      offset = chunkEnd;
      if (offset >= availableEnd) break;
    }
    const buffer = Buffer.concat(chunks, availableEnd - availableStart);
    return {
      stream: snapshotOutputBuffer(buffer, Math.max(0, end - start)),
      complete:
        start === end ||
        (start >= this.#start && start <= retainedEnd && end <= retainedEnd),
    };
  }
}

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
}

const deferred = <Value>(): Deferred<Value> => {
  let resolver: ((value: Value) => void) | undefined;
  const promise = new Promise<Value>((resolve) => {
    resolver = resolve;
  });
  return {
    promise,
    resolve: (value) => {
      resolver?.(value);
    },
  };
};

const waitForSpawn = (child: ChildProcess): Promise<void> =>
  new Promise((resolve, reject) => {
    const onSpawn = (): void => {
      child.off("error", onError);
      resolve();
    };
    const onError = (cause: Error): void => {
      child.off("spawn", onSpawn);
      reject(cause);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });

const waitForProcessEvent = async (
  observed: boolean,
  event: Promise<unknown>,
  timeoutMs: number | undefined,
  signal?: AbortSignal,
): Promise<boolean> => {
  if (observed) return true;
  if (signal?.aborted === true) return false;
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      event.then(() => true),
      new Promise<boolean>((resolve) => {
        if (timeoutMs !== undefined)
          timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
        if (signal !== undefined) {
          onAbort = () => resolve(false);
          signal.addEventListener("abort", onAbort, { once: true });
        }
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
  }
};
