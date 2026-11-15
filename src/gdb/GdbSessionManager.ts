import {
  gdbMiConstText,
  gdbMiResultHeader,
  gdbMiResultsNamed,
  parseGdbMiDoneRecord,
  parseGdbMiResultRecord,
  type GdbMiValue,
} from "./GdbMiRecord.js";
import {
  GDB_PROVIDER_IDENTITY,
  gdbReportedVersion,
  type GdbProviderIdentity,
} from "./GdbProviderIdentity.js";
import { persistentDebuggerHostSupported } from "../process/PersistentDebuggerHost.js";
import { AbortedWait, waitForAbortable } from "../process/AbortablePromise.js";
import { classifyLaunchFailure } from "../process/launchFailure.js";
import { snapshotGdbCommandRecords } from "./GdbCommandRecords.js";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { isUtf8 } from "node:buffer";
import { readlink, realpath, stat } from "node:fs/promises";

import {
  AnalysisCapabilityUnavailableError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisTimeoutError,
  cancelledBy,
  OwnerCancellation,
  carriedReason,
} from "../domain/analysisErrorCore.js";
import {
  GDB_SESSION_TOOLS,
  type DebuggerSessionStop,
  type DebuggerSessionStopCode,
  stoppedDebuggerSessionError,
  unknownDebuggerSessionError,
} from "../domain/debuggerSessionErrors.js";
import {
  AnalysisError,
  type AnalysisErrorOptions,
} from "../domain/analysisErrorBase.js";
import { createEvidence, type Evidence } from "../domain/evidence.js";
import type {
  GdbCommandResult,
  GdbOutputLimit,
} from "../domain/commandObservation.js";
import { currentAnalysisOperationSnapshot } from "../domain/analysisOperationSnapshot.js";
import { err, ok, type Result } from "../domain/result.js";
import { readRuntimeSetting } from "../config/runtimeAnalysisSettings.js";
import {
  ProviderProcessSupervisor,
  spawnOwnedProviderProcess,
  type OwnedProviderProcessSpawnOptions,
  type SpawnedOwnedProviderProcess,
} from "../process/ProviderProcess.js";
import {
  debuggerConstructionLimits,
  debuggerControlReplyOutput,
  parseDebuggerCommandDeadline,
  parseDebuggerCommandOutput,
  type DebuggerAdmissionLimit,
} from "../config/debuggerSessionLimits.js";
import {
  configurableDeadlineGuidance,
  debuggerAdmissionDiagnostics,
  debuggerAdmissionRecovery,
  debuggerResourceConstraintError,
  fixedDeadlineGuidance,
  readLinuxProcessStartTime,
  stopOwnedDebuggerProcess,
  type OwnedDebuggerDetachResult,
  type OwnedInferiorIdentity,
  type ProcessStartTimeReader,
  verifyOwnedInferiorsEnded,
} from "../process/ownedDebuggerSession.js";
import {
  OwnedDebuggerSessionRegistry,
  cancelledWithCallerReason,
} from "../process/OwnedDebuggerSessionRegistry.js";
import { utf8HeadExcerpt } from "../domain/utf8HeadExcerpt.js";

const STARTUP_TIMEOUT_MS = 10_000;

const copiedTimeoutGuidance = (
  cause: AnalysisTimeoutError,
): {
  readonly userMessage?: string;
  readonly remediationAction?: string;
  readonly diagnostics?: AnalysisTimeoutError["diagnostics"];
} => ({
  ...(cause.userMessage === undefined
    ? {}
    : { userMessage: cause.userMessage }),
  ...(cause.remediationAction === undefined
    ? {}
    : { remediationAction: cause.remediationAction }),
  ...(cause.diagnostics === undefined
    ? {}
    : { diagnostics: cause.diagnostics }),
  ...(cause.limit === undefined ? {} : { limit: cause.limit }),
});
/** A host executable refusal cannot be repaired by changing MI dialect. */
class GdbExecutableRefusal extends AnalysisCapabilityUnavailableError {
  constructor(command: string, systemCode: string, cause: Error) {
    super("gdb", "start_gdb_session", cause.message, {
      cause,
      userMessage: `Could not launch the selected GDB executable ${JSON.stringify(command)} (${systemCode}).`,
      remediationAction:
        "Set REA_GDB_COMMAND to an installed executable GDB command, or make that command available on PATH. Check execute permission on the command and search permission on its parent directories before retrying.",
      diagnostics: {
        boundary: "provider-launch",
        command,
        system_code: systemCode,
      },
    });
  }
}

const MAX_COMMAND_OUTPUT_RECORDS = 16_384;
const MAX_MI_LINE_BYTES = 16 * 1024 * 1024;
const MAX_RECENT_MI_LINE_BYTES = 64 * 1024;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const RECENT_RECORD_TRUNCATION_MARKER = "[recent record truncated]";

const gdbRetainedOutputLimitations = (
  result: GdbCommandResult,
  output: DebuggerAdmissionLimit,
): string[] =>
  (result.output_limits ?? []).map((limit) => {
    switch (limit.kind) {
      case "command_bytes":
        return `Retained MI records reached the ${String(limit.maximum)} byte command-output cap. ${debuggerAdmissionRecovery(output)} Retained output is partial.`;
      case "command_records":
        return `Retained MI records reached the ${String(limit.maximum)} record cap. This release has no runtime override for that count; REA_DEBUGGER_MAX_COMMAND_OUTPUT_BYTES does not raise it. Narrow the command's output on the next call. Retained output is partial.`;
      case "mi_line_bytes":
        return `GDB emitted a stream record exceeding the ${String(limit.maximum)} byte MI line limit; that record was dropped. This release has no runtime override for that protocol limit; REA_DEBUGGER_MAX_COMMAND_OUTPUT_BYTES does not raise it. Select a command that emits smaller records on the next call. Retained output is partial.`;
    }
  });

interface PendingCommand {
  readonly token: number;
  readonly command: string;
  readonly evidenceCommand: string;
  readonly lines: string[];
  outputBytes: number;
  /** Caller output uses the setting. Startup and detach replies use the control budget. */
  readonly outputBudgetBytes: number;
  readonly outputLimits: Set<GdbOutputLimit["kind"]>;
  outputInvalidUtf8: boolean;
  terminalRecord: string | undefined;
  completionToken: number | undefined;
  readonly resolve: (result: GdbCommandResult) => void;
  readonly reject: (error: Error) => void;
  readonly cleanup: () => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Preserve the producer's exact exhaustion facts through every completion path. */
const gdbOutputCapture = (
  pending: PendingCommand,
): Pick<GdbCommandResult, "output_truncated" | "output_limits"> => ({
  output_truncated: pending.outputLimits.size > 0,
  ...(pending.outputLimits.size === 0
    ? {}
    : {
        output_limits: [...pending.outputLimits].map((kind) => ({
          kind,
          maximum:
            kind === "command_bytes"
              ? pending.outputBudgetBytes
              : kind === "command_records"
                ? MAX_COMMAND_OUTPUT_RECORDS
                : MAX_MI_LINE_BYTES,
        })),
      }),
});

class GdbCommandTimeoutError extends AnalysisTimeoutError {
  constructor(
    readonly partial: GdbCommandResult,
    readonly evidence: Evidence,
    deadline: DebuggerAdmissionLimit,
  ) {
    super("gdb_console", deadline.value, {
      ...configurableDeadlineGuidance("The GDB MI command", deadline),
    });
  }
}

const truncateUtf8RecordPrefix = (line: string): string => {
  const budget =
    MAX_RECENT_MI_LINE_BYTES -
    Buffer.byteLength(RECENT_RECORD_TRUNCATION_MARKER, "utf8");
  return `${utf8HeadExcerpt(line, budget).text}${RECENT_RECORD_TRUNCATION_MARKER}`;
};

const containsResultNamed = (value: GdbMiValue, name: string): boolean => {
  switch (value.kind) {
    case "const":
      return false;
    case "list":
      return value.values.some((item) => containsResultNamed(item, name));
    case "tuple":
    case "result-list":
      return value.results.some(
        (result) =>
          result.name === name || containsResultNamed(result.value, name),
      );
  }
};

/**
 * Read the live PIDs of a complete `-list-thread-groups` reply without
 * guessing. The record must hold exactly one top-level `groups` list of
 * tuples, each with one `id` constant, no nested `groups`, and at most one
 * decimal `pid`; a group without `pid` has no live process.
 */
export const gdbThreadGroupPids = (
  mi: string,
): readonly string[] | undefined => {
  const parsed = parseGdbMiResultRecord(mi);
  if (!parsed.ok || parsed.value.resultClass !== "done") return undefined;
  const groupsValues = gdbMiResultsNamed(parsed.value.results, "groups");
  const groups = groupsValues[0];
  if (groupsValues.length !== 1 || groups?.kind !== "list") return undefined;
  const pids: string[] = [];
  for (const group of groups.values) {
    if (group.kind !== "tuple") return undefined;
    const ids = gdbMiResultsNamed(group.results, "id");
    if (ids.length !== 1 || ids[0]?.kind !== "const") return undefined;
    if (containsResultNamed(group, "groups")) return undefined;
    const pidValues = gdbMiResultsNamed(group.results, "pid");
    if (pidValues.length === 0) continue;
    const pid =
      pidValues.length === 1 && pidValues[0] !== undefined
        ? gdbMiConstText(pidValues[0])
        : undefined;
    if (pid === undefined || !/^[1-9]\d*$/u.test(pid)) return undefined;
    pids.push(pid);
  }
  return pids;
};

const verifyGdbInferiorOutputSink = async (
  pid: string,
  selectedTty: string,
  rememberIdentity: (identity: OwnedInferiorIdentity) => void,
): Promise<void> => {
  if (process.platform !== "linux")
    throw new Error(
      "GDB cannot confirm live inferior output descriptors outside Linux /proc.",
    );
  const before = await readLinuxProcessStartTime(pid);
  if (before === null)
    throw new Error("GDB could not establish the live inferior identity.");
  const ttyPath = await realpath(selectedTty);
  const tty = await stat(ttyPath);
  if ((tty.mode & fsConstants.S_IFMT) !== fsConstants.S_IFCHR)
    throw new Error("The selected GDB output sink is not a character device.");
  for (const descriptor of ["1", "2"]) {
    const descriptorPath = `/proc/${pid}/fd/${descriptor}`;
    const destination = await readlink(descriptorPath);
    const observed = await stat(descriptorPath);
    if (
      observed.dev !== tty.dev ||
      observed.ino !== tty.ino ||
      (observed.mode & fsConstants.S_IFMT) !== fsConstants.S_IFCHR ||
      (await realpath(destination)) !== ttyPath
    )
      throw new Error(
        `GDB inferior descriptor ${descriptor} no longer points to the selected TTY.`,
      );
  }
  const after = await readLinuxProcessStartTime(pid);
  if (after !== before)
    throw new Error(
      "The GDB inferior identity changed during descriptor readback.",
    );
  rememberIdentity({ pid, startTime: before });
};

class GdbCommandProcessExitError extends Error {
  constructor(readonly partial: GdbCommandResult) {
    super(
      `GDB exited before returning the active MI command result (exit code ${String(partial.process_exit_code)}, signal ${String(partial.process_exit_signal)}).`,
    );
  }
}

class GdbProtocolFailureError extends Error {
  constructor(
    message: string,
    readonly partial: GdbCommandResult,
  ) {
    super(message);
  }
}

/** Convert an unknown boundary failure without dropping non-Error values. */
const gdbErrorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

interface GdbSession {
  readonly id: string;
  readonly miVersion: "mi3" | "mi2";
  /** Identity for this session's Evidence; version is set from -gdb-version. */
  provider: GdbProviderIdentity;
  readonly launched: SpawnedOwnedProviderProcess;
  readonly supervisor: ProviderProcessSupervisor;
  /** Confirms target disposition and any durable sink before process cleanup. */
  readonly detachInferior: () => Promise<OwnedDebuggerDetachResult>;
  readonly inferiorStateUnknown: () => boolean;
  readonly verifyInferiorsEndedAfterExit: () => Promise<boolean>;
  readonly knownInferiorIdentities: Map<string, OwnedInferiorIdentity>;
  readonly inferiorTty: string | undefined;
  readonly stdoutSettled: Promise<void>;
  readonly settleStdout: () => void;
  inferiorTtyVerified: boolean;
  noInferiorVerified: boolean;
  /** Sticky admission seal once destructive cleanup starts, including failed stops. */
  cleanupStarted: boolean;
  /** close_gdb_session started cleanup, so a successful retry releases the ID. */
  closeRequested: boolean;
  readonly pending: Map<number, PendingCommand>;
  readonly lines: string[];
  readonly bufferChunks: Buffer[];
  bufferTail: Buffer | undefined;
  bufferTailBytes: number;
  bufferBytes: number;
  discardingOversizedStreamRecord: boolean;
  invalidUtf8Observed: boolean;
  promptTail: string;
  ready: boolean;
  exited: boolean;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  nextToken: number;
  startupResolve: (() => void) | undefined;
  startupReject: ((error: Error) => void) | undefined;
  commandTail: Promise<void>;
  pendingCommandCount: number;
  protocolError: DebuggerSessionStop | undefined;
  recentRecordsTruncated: boolean;
}

const gdbCloseUnavailable = (): AnalysisInputError =>
  unknownDebuggerSessionError(GDB_SESSION_TOOLS, "close_gdb_session");

/** Owns persistent GDB/MI sessions independently from the active binary target. */
export class GdbSessionManager {
  readonly #sessions: OwnedDebuggerSessionRegistry<GdbSession>;
  readonly #command: string;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #launchCommandDeadline: DebuggerAdmissionLimit;
  readonly #startupTimeoutMs: number;
  readonly #platform: NodeJS.Platform;
  readonly #spawnProcess: typeof spawnOwnedProviderProcess;
  readonly #verifyInferiorOutputSink: (
    pid: string,
    selectedTty: string,
    rememberIdentity: (identity: OwnedInferiorIdentity) => void,
  ) => Promise<void>;
  readonly #readInferiorProcessStartTime: ProcessStartTimeReader | undefined;
  readonly #maxSessions: DebuggerAdmissionLimit;
  readonly #maxPendingCommands: DebuggerAdmissionLimit;
  readonly #launchCommandOutput: DebuggerAdmissionLimit;
  get #commandDeadline(): DebuggerAdmissionLimit {
    const override =
      currentAnalysisOperationSnapshot()?.overrides[
        "debugger.command_deadline_ms"
      ];
    if (override !== undefined)
      return {
        ...this.#launchCommandDeadline,
        value: override,
        source: "runtime",
      };
    const parsed = parseDebuggerCommandDeadline(this.#environment);
    if (!parsed.ok) throw parsed.error;
    return parsed.value;
  }
  get #commandOutput(): DebuggerAdmissionLimit {
    const override =
      currentAnalysisOperationSnapshot()?.overrides[
        "debugger.max_command_output_bytes"
      ];
    if (override !== undefined)
      return {
        ...this.#launchCommandOutput,
        value: override,
        source: "runtime",
      };
    const parsed = parseDebuggerCommandOutput(this.#environment);
    if (!parsed.ok) throw parsed.error;
    return parsed.value;
  }
  #closing = false;
  #closePromise: Promise<void> | undefined;

  constructor(
    options: {
      readonly environment?: Readonly<NodeJS.ProcessEnv>;
      readonly startupTimeoutMs?: number;
      readonly platform?: NodeJS.Platform;
      readonly stopProcess?: typeof stopOwnedDebuggerProcess;
      readonly spawnProcess?: typeof spawnOwnedProviderProcess;
      /** @internal Tests may replace only the /proc and TTY readback boundary. */
      readonly verifyInferiorOutputSink?: (
        pid: string,
        selectedTty: string,
        rememberIdentity: (identity: OwnedInferiorIdentity) => void,
      ) => Promise<void>;
      /** @internal Read-only process identity observer for lifecycle tests. */
      readonly readInferiorProcessStartTime?: ProcessStartTimeReader;
    } = {},
  ) {
    this.#environment = { ...(options.environment ?? process.env) };
    this.#command = this.#environment.REA_GDB_COMMAND ?? "gdb";
    const limits = debuggerConstructionLimits(this.#environment);
    this.#launchCommandDeadline = limits.commandDeadline;
    this.#startupTimeoutMs = options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
    this.#platform = options.platform ?? process.platform;
    const stopProcess = options.stopProcess ?? stopOwnedDebuggerProcess;
    this.#sessions = new OwnedDebuggerSessionRegistry({
      provider: "gdb",
      displayName: "GDB",
      sealSession: (session) => {
        session.cleanupStarted = true;
      },
      stopProcess: (session) => stopProcess(session, "GDB"),
      stopFailurePrefix: "Owned GDB shutdown failed",
    });
    this.#spawnProcess = options.spawnProcess ?? spawnOwnedProviderProcess;
    this.#verifyInferiorOutputSink =
      options.verifyInferiorOutputSink ?? verifyGdbInferiorOutputSink;
    this.#readInferiorProcessStartTime = options.readInferiorProcessStartTime;
    this.#maxSessions = limits.maxSessions;
    this.#maxPendingCommands = limits.maxPendingCommands;
    this.#launchCommandOutput = limits.maxCommandOutputBytes;
  }

  async start(
    signal?: AbortSignal,
    options: { readonly inferiorTty?: string } = {},
  ): Promise<
    Result<
      { readonly session_id: string; readonly mi_version: "mi3" | "mi2" },
      AnalysisError
    >
  > {
    if (
      options.inferiorTty !== undefined &&
      (options.inferiorTty.length === 0 || options.inferiorTty.includes("\0"))
    )
      return err(
        new AnalysisInputError("start_gdb_session", undefined, [
          {
            path: ["inferior_tty"],
            reason: "invalid_value",
            message:
              "The inferior TTY path must be non-empty and must not contain NUL.",
          },
        ]),
      );
    return this.#sessions.start("start_gdb_session", signal, (started) =>
      this.#startWithReservation(started, options),
    );
  }

  async #startWithReservation(
    signal: AbortSignal,
    options: { readonly inferiorTty?: string } = {},
  ): Promise<
    Result<
      { readonly session_id: string; readonly mi_version: "mi3" | "mi2" },
      AnalysisError
    >
  > {
    if (signal?.aborted) return err(cancelledBy("start_gdb_session", signal));
    if (!persistentDebuggerHostSupported(this.#platform))
      return err(
        new AnalysisCapabilityUnavailableError(
          "gdb",
          "start_gdb_session",
          this.#platform === "win32"
            ? "Persistent Windows GDB sessions are unavailable because owned Job Object cleanup can terminate debugger inferiors."
            : "Persistent GDB sessions are available only on Linux because REA verifies live inferior output descriptors through /proc.",
        ),
      );
    const occupied = this.#sessions.occupied();
    if (occupied >= this.#maxSessions.value)
      return err(
        debuggerResourceConstraintError(
          "start_gdb_session",
          "memory",
          `GDB session capacity reached (${String(this.#maxSessions.value)} sessions).`,
          "Close a GDB session before starting another; a stopped session that gdb_session_status reports closed still holds its slot until close_gdb_session releases it.",
          this.#maxSessions,
          {
            max_sessions: this.#maxSessions.value,
            active_or_reserved_sessions: occupied,
          },
        ),
      );
    const releaseReservation = this.#sessions.reserve();
    try {
      return await this.#startReserved(releaseReservation, signal, options);
    } finally {
      releaseReservation();
    }
  }

  async #startReserved(
    releaseReservation: () => void,
    signal: AbortSignal,
    options: { readonly inferiorTty?: string } = {},
  ): Promise<
    Result<
      { readonly session_id: string; readonly mi_version: "mi3" | "mi2" },
      AnalysisError
    >
  > {
    const id = randomUUID();
    const mi3 = await this.#startProtocol(
      id,
      "mi3",
      releaseReservation,
      signal,
      options.inferiorTty,
    );
    return mi3.ok ||
      signal.aborted ||
      this.#sessions.has(id) ||
      mi3.error instanceof GdbExecutableRefusal
      ? mi3
      : this.#startProtocol(
          id,
          "mi2",
          releaseReservation,
          signal,
          options.inferiorTty,
        );
  }

  async #startProtocol(
    id: string,
    miVersion: "mi3" | "mi2",
    releaseReservation: () => void,
    signal: AbortSignal,
    inferiorTty?: string,
  ): Promise<
    Result<
      { readonly session_id: string; readonly mi_version: "mi3" | "mi2" },
      AnalysisError
    >
  > {
    let launched: SpawnedOwnedProviderProcess;
    try {
      const spawnOptions: OwnedProviderProcessSpawnOptions = {
        command: this.#command,
        arguments: ["--nx", "--quiet", `--interpreter=${miVersion}`],
        runId: randomUUID(),
        stdin: "pipe",
        hostEnvironment: this.#environment,
        signal,
      };
      launched = await this.#spawnProcess(spawnOptions);
    } catch (cause) {
      if (
        (signal?.aborted && cause === signal.reason) ||
        cause instanceof AnalysisCancelledError
      )
        return err(cancelledBy("start_gdb_session", carriedReason(cause)));
      const refusal = classifyLaunchFailure(cause);
      if (refusal !== undefined && cause instanceof Error)
        return err(
          new GdbExecutableRefusal(this.#command, refusal.code, cause),
        );
      return err(
        new AnalysisCapabilityUnavailableError(
          "gdb",
          "start_gdb_session",
          cause instanceof Error ? cause.message : "Unable to start GDB",
          { cause },
        ),
      );
    }
    const supervisor = new ProviderProcessSupervisor(
      { process: launched.process, ownsProcessLifetime: false },
      { captureStdout: false, maxDiagnosticBytes: MAX_DIAGNOSTIC_BYTES },
    );
    let settleStdout!: () => void;
    const stdoutSettled = new Promise<void>((resolve) => {
      settleStdout = resolve;
    });
    const session: GdbSession = {
      id,
      miVersion,
      provider: GDB_PROVIDER_IDENTITY,
      launched,
      supervisor,
      detachInferior: () => this.#detachInferior(session),
      inferiorStateUnknown: () => !session.noInferiorVerified,
      verifyInferiorsEndedAfterExit: async () => {
        const ended = await verifyOwnedInferiorsEnded(
          session.knownInferiorIdentities.values(),
          this.#readInferiorProcessStartTime,
        );
        if (ended) session.knownInferiorIdentities.clear();
        return ended;
      },
      knownInferiorIdentities: new Map(),
      inferiorTty,
      stdoutSettled,
      settleStdout,
      inferiorTtyVerified: false,
      // GDB is launched with --nx and receives no target-execution commands
      // during startup, so no inferior can exist until execute() is called.
      noInferiorVerified: true,
      cleanupStarted: false,
      closeRequested: false,
      pending: new Map(),
      lines: [],
      bufferChunks: [],
      bufferTail: undefined,
      bufferTailBytes: 0,
      bufferBytes: 0,
      discardingOversizedStreamRecord: false,
      invalidUtf8Observed: false,
      promptTail: "",
      ready: false,
      exited: false,
      exitCode: null,
      exitSignal: null,
      nextToken: 1,
      startupResolve: undefined,
      startupReject: undefined,
      commandTail: Promise.resolve(),
      pendingCommandCount: 0,
      protocolError: undefined,
      recentRecordsTruncated: false,
    };
    launched.process.stdout?.on("data", (chunk: string | Buffer) =>
      this.#receive(
        session,
        typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk,
      ),
    );
    if (launched.process.stdout === null) settleStdout();
    else launched.process.stdout.once("end", settleStdout);
    launched.process.stdin?.on("error", (cause: Error) =>
      this.#failProtocol(
        session,
        "input-stream-failure",
        `GDB stdin stream failed: ${cause.message}`,
      ),
    );
    launched.process.stdin?.once("close", () =>
      this.#failProtocol(
        session,
        "input-stream-failure",
        "GDB stdin stream closed unexpectedly.",
      ),
    );
    launched.process.once("exit", (code, signalCode) => {
      session.exited = true;
      session.exitCode = code;
      session.exitSignal = signalCode;
      void this.#waitForStdoutSettlement(session).then(() =>
        session.startupReject?.(
          new Error(
            `GDB exited during startup (exit code ${String(code)}, signal ${String(signalCode)}).`,
          ),
        ),
      );
      void this.#settleExitedCommands(session, code, signalCode);
    });
    let startupTimer!: ReturnType<typeof setTimeout>;
    let startupAbortListener!: () => void;
    try {
      await new Promise<void>((resolve, reject) => {
        session.startupResolve = resolve;
        session.startupReject = reject;
        startupAbortListener = () =>
          reject(cancelledBy("start_gdb_session", signal));
        signal?.addEventListener("abort", startupAbortListener, {
          once: true,
        });
        if (signal?.aborted) startupAbortListener();
        startupTimer = setTimeout(
          () =>
            reject(
              new AnalysisTimeoutError(
                "start_gdb_session",
                this.#startupTimeoutMs,
                {
                  cause: new Error(
                    "GDB did not emit the MI prompt before the startup deadline",
                  ),
                  ...fixedDeadlineGuidance(
                    "GDB startup",
                    this.#startupTimeoutMs,
                  ),
                },
              ),
            ),
          this.#startupTimeoutMs,
        );
        startupTimer.unref();
      });
      if (signal?.aborted) throw cancelledBy("start_gdb_session", signal);
      // -gdb-version loads nothing, so it may precede the auto-load setting.
      const reported = await this.#request(
        session,
        "-gdb-version",
        signal,
        "start_gdb_session",
      );
      // The version is text: a lossy decode would report replacement text.
      if (
        reported.completion_status === "complete" &&
        !reported.output_truncated &&
        reported.output_invalid_utf8 !== true &&
        parseGdbMiDoneRecord(reported.mi).ok
      )
        session.provider = {
          ...GDB_PROVIDER_IDENTITY,
          version: gdbReportedVersion(reported.records),
        };
      const autoLoad = await this.#request(
        session,
        "-gdb-set auto-load off",
        signal,
        "start_gdb_session",
      );
      if (!parseGdbMiDoneRecord(autoLoad.mi).ok) {
        throw new AnalysisCapabilityUnavailableError(
          "gdb",
          "start_gdb_session",
          `GDB rejected the required automatic-loading disable command (${autoLoad.mi}); the session was not started.`,
        );
      }
      if (inferiorTty !== undefined) {
        const configured = await this.#request(
          session,
          `-inferior-tty-set ${miQuote(inferiorTty)}`,
          signal,
          "start_gdb_session",
        );
        if (
          configured.completion_status !== "complete" ||
          configured.output_truncated ||
          !parseGdbMiDoneRecord(configured.mi).ok
        )
          throw new AnalysisCapabilityUnavailableError(
            "gdb",
            "start_gdb_session",
            "GDB did not confirm the inferior TTY configuration.",
          );
        const observed = await this.#request(
          session,
          "-inferior-tty-show",
          signal,
          "start_gdb_session",
        );
        const reportedTty =
          observed.completion_status === "complete" &&
          !observed.output_truncated
            ? miStringField(observed.mi, "inferior_tty_terminal")
            : undefined;
        if (
          !parseGdbMiDoneRecord(observed.mi).ok ||
          reportedTty !== inferiorTty
        )
          throw new AnalysisCapabilityUnavailableError(
            "gdb",
            "start_gdb_session",
            "GDB did not report the exact caller-selected inferior TTY after configuration.",
          );
        session.inferiorTtyVerified = true;
      }
      if (signal?.aborted) throw cancelledBy("start_gdb_session", signal);
      // Give queued exit notifications a turn before publishing startup.
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (signal?.aborted) throw cancelledBy("start_gdb_session", signal);
      if (session.exited || session.protocolError !== undefined)
        throw new Error(
          session.protocolError?.reason ??
            "GDB exited during startup readiness.",
        );
      // Publish readiness only after every mandatory startup check completes.
      // Retained failed-start owners remain addressable for cleanup, not work.
      session.ready = true;
      // Before publication no target command can run. Once usable, the
      // inferior state is no longer inferred from startup phase.
      session.noInferiorVerified = false;
      this.#sessions.add(session);
      releaseReservation();
      return ok({ session_id: id, mi_version: miVersion });
    } catch (cause) {
      const startupExited =
        cause instanceof GdbCommandProcessExitError || session.exited;
      const processExit =
        cause instanceof GdbCommandProcessExitError
          ? cause.partial
          : startupExited
            ? {
                command: "GDB startup",
                mi: "",
                ...snapshotGdbCommandRecords(session.lines),
                process_exit_observed: true,
                process_exit_code: session.exitCode,
                process_exit_signal: session.exitSignal,
                output_truncated: session.recentRecordsTruncated,
                completion_status: "unknown" as const,
              }
            : undefined;
      const startupEvidenceResult =
        processExit ??
        (session.lines.length > 0
          ? {
              command: "GDB startup",
              mi: "",
              ...snapshotGdbCommandRecords(session.lines),
              output_truncated: session.recentRecordsTruncated,
              completion_status: "unknown" as const,
            }
          : undefined);
      const startupEvidencePayload =
        startupEvidenceResult === undefined
          ? undefined
          : {
              ...startupEvidenceResult,
              ...(session.invalidUtf8Observed
                ? { output_invalid_utf8: true as const }
                : {}),
            };
      const startupEvidence =
        startupEvidencePayload === undefined
          ? undefined
          : createEvidence(undefined, session.provider, {
              predicateType: "rea.debugger.startup-observation",
              operation: "start_gdb_session",
              parameters: {
                mi_version: miVersion,
                command: startupEvidencePayload.command,
              },
              result: {
                ...startupEvidencePayload,
                records: [...startupEvidencePayload.records],
              },
              rawResult: {
                ...startupEvidencePayload,
                records: [...startupEvidencePayload.records],
              },
              subjectUnavailableReason:
                "No usable debugger session became ready during GDB startup.",
              limitations: [
                "GDB startup failed before a usable session could be established; captured startup records are incomplete.",
                ...(session.invalidUtf8Observed
                  ? [
                      "GDB startup output contained invalid UTF-8 bytes; decoded records contain replacement characters.",
                    ]
                  : []),
              ],
            });
      const processOutput = session.supervisor.snapshot();
      const capturedOutput = {
        stdout: processOutput.stdout.text,
        stderr: processOutput.stderr.text,
        truncated:
          processOutput.diagnosticTruncated === true ||
          processOutput.stdout.observedBytes > processOutput.stdout.bytes ||
          processOutput.stderr.observedBytes > processOutput.stderr.bytes,
        stdout_bytes: processOutput.stdout.observedBytes,
        stderr_bytes: processOutput.stderr.observedBytes,
        exit_code: processOutput.exitCode ?? null,
        signal: processOutput.signal ?? null,
      };
      const stopped = await this.#stopDebuggerOnly(session);
      if (stopped.status === "incomplete") {
        this.#sessions.add(session);
        releaseReservation();
        const cleanupFailure = this.#sessions.retainCleanupFailure(
          session,
          "start_gdb_session",
          stopped.reason,
          { cause },
        );
        const retainCleanup = <T extends AnalysisError>(failure: T): T =>
          failure.bindCleanupDependencies([cleanupFailure], {
            cleanupResources: [session.id],
          });
        const cleanup = { reason: stopped.reason, resources: [session.id] };
        const detailsWithoutCause = {
          capturedOutput,
          cleanup,
          ...(startupEvidence === undefined
            ? {}
            : { partialObservation: startupEvidence }),
        };
        const details = { cause, ...detailsWithoutCause };
        if (cause instanceof AnalysisTimeoutError)
          return err(
            retainCleanup(
              new AnalysisTimeoutError(cause.operation, cause.timeoutMs, {
                ...details,
                ...copiedTimeoutGuidance(cause),
              }),
            ),
          );
        if (cause instanceof AnalysisCancelledError)
          return err(
            retainCleanup(
              cancelledBy(
                cause.operation,
                carriedReason(cause),
                detailsWithoutCause,
              ),
            ),
          );
        const startupFailureMessage = gdbErrorMessage(cause);
        return err(
          retainCleanup(
            new AnalysisCapabilityUnavailableError(
              "gdb",
              "start_gdb_session",
              `GDB startup failed (${startupFailureMessage}) and its owned process could not be confirmed stopped: ${stopped.reason}`,
              session.protocolError === undefined
                ? details
                : {
                    ...details,
                    diagnostics: { session_stop: session.protocolError.code },
                  },
            ),
          ),
        );
      }
      const errorDetailsWithoutCause = {
        capturedOutput,
        ...(startupEvidence === undefined
          ? {}
          : { partialObservation: startupEvidence }),
      };
      const errorDetails = { cause, ...errorDetailsWithoutCause };
      const error =
        cause instanceof AnalysisCancelledError
          ? cancelledBy(
              "start_gdb_session",
              carriedReason(cause),
              errorDetailsWithoutCause,
            )
          : cause instanceof AnalysisTimeoutError
            ? new AnalysisTimeoutError(
                cause instanceof GdbCommandTimeoutError
                  ? "start_gdb_session"
                  : cause.operation,
                cause.timeoutMs,
                {
                  ...errorDetails,
                  ...copiedTimeoutGuidance(cause),
                },
              )
            : cause instanceof AnalysisCapabilityUnavailableError
              ? new AnalysisCapabilityUnavailableError(
                  "gdb",
                  "start_gdb_session",
                  cause.message,
                  errorDetails,
                )
              : session.protocolError !== undefined
                ? new AnalysisCapabilityUnavailableError(
                    "gdb",
                    "start_gdb_session",
                    session.protocolError.reason,
                    {
                      ...errorDetails,
                      diagnostics: { session_stop: session.protocolError.code },
                    },
                  )
                : new AnalysisCapabilityUnavailableError(
                    "gdb",
                    "start_gdb_session",
                    `GDB startup failed (${gdbErrorMessage(cause)}).`,
                    errorDetails,
                  );
      return err(error);
    } finally {
      clearTimeout(startupTimer);
      signal?.removeEventListener("abort", startupAbortListener);
    }
  }

  async execute(
    sessionId: string,
    command: string,
    signal?: AbortSignal,
  ): Promise<
    Result<
      { readonly result: GdbCommandResult; readonly evidence: Evidence },
      AnalysisError
    >
  > {
    const session = this.#sessions.get(sessionId);
    if (session === undefined)
      return err(unknownDebuggerSessionError(GDB_SESSION_TOOLS, "gdb_console"));
    const stopped = this.#stopReason(session);
    if (stopped !== undefined)
      return err(
        stoppedDebuggerSessionError(GDB_SESSION_TOOLS, "gdb_console", stopped),
      );
    if (signal?.aborted)
      return err(cancelledWithCallerReason("gdb_console", signal));
    try {
      const completed = await this.#serialize(
        session,
        async () => {
          // Retained cleanup ownership and a delayed exit event do not imply
          // command readiness. Recheck admission when this queued turn starts.
          // Every path that releases a session first records why it stopped.
          const stoppedWhileQueued = this.#stopReason(session);
          if (stoppedWhileQueued !== undefined)
            return err(
              stoppedDebuggerSessionError(
                GDB_SESSION_TOOLS,
                "gdb_console",
                stoppedWhileQueued,
              ),
            );
          session.noInferiorVerified = false;
          session.knownInferiorIdentities.clear();
          if (commandMayChangeInferiorOutput(command))
            session.inferiorTtyVerified = false;
          const accepted = readRuntimeSetting(() => ({
            deadline: this.#commandDeadline,
            output: this.#commandOutput,
          }));
          if (!accepted.ok) return accepted;
          const { deadline: acceptedDeadline, output: acceptedOutput } =
            accepted.value;
          try {
            const result = await this.#request(
              session,
              `-interpreter-exec console ${miQuote(command)}`,
              signal,
              "gdb_console",
              command,
              accepted.value,
            );
            const evidence = createEvidence(undefined, session.provider, {
              predicateType: "rea.debugger.console-observation",
              operation: "gdb_console",
              parameters: { session_id: sessionId, command },
              result: {
                command,
                mi: result.mi,
                records: [...result.records],
                console: result.console,
                target: result.target,
                log: result.log,
                output_truncated: result.output_truncated,
                ...(result.output_limits === undefined
                  ? {}
                  : { output_limits: result.output_limits }),
                ...(result.output_invalid_utf8
                  ? { output_invalid_utf8: true as const }
                  : {}),
                completion_status: result.completion_status,
              },
              rawResult: {
                command,
                mi: result.mi,
                records: [...result.records],
                console: result.console,
                target: result.target,
                log: result.log,
                output_truncated: result.output_truncated,
                ...(result.output_limits === undefined
                  ? {}
                  : { output_limits: result.output_limits }),
                ...(result.output_invalid_utf8
                  ? { output_invalid_utf8: true as const }
                  : {}),
                completion_status: result.completion_status,
              },
              subjectUnavailableReason:
                "The active GDB inferior identity is not established by the debugger session identifier.",
              limitations: [
                ...(result.mi.length === 0
                  ? [
                      "A separately tokenized read-only query confirmed return to GDB's command loop. The original result record could not be framed independently from raw stdout; its bytes remain in records and its result class is unknown.",
                    ]
                  : []),
                "MI records are returned as decoded text; their semantics depend on GDB version and target.",
                ...gdbRetainedOutputLimitations(result, acceptedOutput),
                ...(result.output_invalid_utf8
                  ? [
                      "MI stream bytes were not valid UTF-8; returned text contains replacement characters.",
                    ]
                  : []),
                "The unrestricted GDB console can access local shell, filesystem, network, and target controls.",
              ],
            });
            return ok({ result, evidence });
          } catch (cause) {
            if (cause instanceof AnalysisCancelledError) return err(cause);
            if (cause instanceof AnalysisCapabilityUnavailableError)
              return err(cause as AnalysisError);
            if (cause instanceof GdbCommandTimeoutError) {
              const result = cause.partial;
              return ok({ result, evidence: cause.evidence });
            }
            if (session.protocolError !== undefined)
              return err(await this.#stopAfterProtocolFailure(session, cause));
            if (cause instanceof GdbCommandProcessExitError) {
              const processExit = cause as GdbCommandProcessExitError;
              const result: GdbCommandResult = {
                ...processExit.partial,
                command,
              };
              const evidence = createEvidence(undefined, session.provider, {
                predicateType: "rea.debugger.console-observation",
                operation: "gdb_console",
                parameters: { session_id: sessionId, command },
                result: { ...result, records: [...result.records] },
                rawResult: { ...result, records: [...result.records] },
                subjectUnavailableReason:
                  "The active GDB inferior identity is not established by the debugger session identifier.",
                limitations: [
                  "GDB exited before returning a correlated MI result record; only records retained for the active command are returned raw.",
                  ...gdbRetainedOutputLimitations(result, acceptedOutput),
                ],
              });
              const stopped = await this.#stopDebuggerOnly(session);
              if (stopped.status === "incomplete")
                return err(
                  this.#sessions.retainCleanupFailure(
                    session,
                    "gdb_console",
                    stopped.reason,
                    {
                      cause,
                      partialObservation: evidence,
                      ...(result.output_limits?.some(
                        (limit) => limit.kind === "command_bytes",
                      )
                        ? {
                            diagnostics:
                              debuggerAdmissionDiagnostics(acceptedOutput),
                          }
                        : {}),
                    },
                  ),
                );
              return ok({ result, evidence });
            }
            return err(
              new AnalysisTimeoutError("gdb_console", acceptedDeadline.value, {
                cause,
                ...configurableDeadlineGuidance(
                  "The GDB MI command",
                  acceptedDeadline,
                ),
              }),
            );
          }
        },
        signal,
        "gdb_console",
      );
      if (!completed.ok && completed.error.cleanupIncomplete)
        this.#sessions.retain(session, completed.error);
      return completed;
    } catch (cause) {
      const error =
        cause instanceof AnalysisError
          ? cause
          : cancelledBy("gdb_console", carriedReason(cause));
      if (error.cleanupIncomplete) this.#sessions.retain(session, error);
      return err(error);
    }
  }

  status(sessionId: string):
    | {
        readonly session_id: string;
        readonly mi_version: "mi3" | "mi2";
        readonly state: "ready" | "closed";
        readonly recent_mi_records: readonly string[];
        readonly recent_mi_records_truncated: boolean;
        readonly mi_invalid_utf8: boolean;
        readonly stderr: string;
        readonly stderr_observed_bytes: number;
        readonly stderr_truncated: boolean;
        readonly stderr_invalid_utf8: boolean;
        readonly diagnostics_truncated: boolean;
        readonly inferior_tty: string | null;
        readonly inferior_tty_verified: boolean;
        readonly closed_reason?: string;
        readonly closed_reason_code?: DebuggerSessionStopCode;
      }
    | undefined {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return undefined;
    const diagnostics = session.supervisor.snapshot();
    const stopped = this.#stopReason(session);
    return {
      session_id: session.id,
      mi_version: session.miVersion,
      state: stopped === undefined ? "ready" : "closed",
      recent_mi_records: [...session.lines],
      recent_mi_records_truncated: session.recentRecordsTruncated,
      mi_invalid_utf8: session.invalidUtf8Observed,
      stderr: diagnostics.stderr.text,
      stderr_observed_bytes: diagnostics.stderr.observedBytes,
      stderr_truncated:
        diagnostics.stderr.observedBytes > diagnostics.stderr.bytes,
      stderr_invalid_utf8: diagnostics.stderr.invalidUtf8 === true,
      diagnostics_truncated: diagnostics.diagnosticTruncated === true,
      inferior_tty: session.inferiorTty ?? null,
      inferior_tty_verified: session.inferiorTtyVerified,
      ...(stopped === undefined
        ? {}
        : { closed_reason: stopped.reason, closed_reason_code: stopped.code }),
    };
  }

  /** Why a retained session accepts no commands, or undefined while it is ready. */
  #stopReason(session: GdbSession): DebuggerSessionStop | undefined {
    if (session.protocolError !== undefined) return session.protocolError;
    if (this.#closing)
      return {
        code: "server-shutdown",
        reason: "REA is shutting down and closing every GDB session.",
      };
    if (session.closeRequested)
      return {
        code: "close-requested",
        reason:
          "close_gdb_session started releasing this session, and its owned cleanup has not completed.",
      };
    if (session.exited)
      return {
        code: "process-exited",
        reason: `The GDB process exited (exit code ${String(session.exitCode)}, signal ${String(session.exitSignal)}); a command such as quit, or a crash, can end it.`,
      };
    if (session.cleanupStarted || !session.ready)
      return { code: "stopped", reason: "REA stopped this GDB session." };
    return undefined;
  }

  async close(
    sessionId: string,
  ): Promise<
    Result<
      { readonly target_state: "none_observed" | "unknown" },
      AnalysisError
    >
  > {
    if (this.#closing)
      return err(
        cancelledBy("close_gdb_session", OwnerCancellation.ownerClosed),
      );
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return err(gdbCloseUnavailable());
    if (session.exited) return this.#finishSessionCleanup(session);
    try {
      return await this.#serialize(
        session,
        async () => {
          // An earlier close can remove this session while this close waits.
          if (this.#sessions.get(sessionId) !== session)
            return err(gdbCloseUnavailable());
          if (session.exited || session.cleanupStarted)
            return this.#finishSessionCleanup(session);
          let targetState: "none_observed" | "unknown" = "unknown";
          try {
            const groups = await this.#request(
              session,
              "-list-thread-groups --recurse 1",
            );
            if (
              groups.completion_status !== "complete" ||
              groups.output_truncated ||
              !parseGdbMiDoneRecord(groups.mi).ok
            )
              throw new Error(
                "GDB could not confirm its complete, untruncated inferior list before shutdown.",
              );
            const pids = gdbThreadGroupPids(groups.mi);
            if (pids === undefined)
              throw new Error(
                "GDB returned an unknown inferior list before shutdown.",
              );
            const groupCount = pids.length;
            if (
              groupCount > 1 ||
              (groupCount > 0 && !session.inferiorTtyVerified)
            )
              return err(
                new AnalysisCapabilityUnavailableError(
                  GDB_PROVIDER_IDENTITY.id,
                  "close_gdb_session",
                  groupCount > 1
                    ? "Multiple live GDB inferiors require an explicit disposition because automatic detach supports only one inferior."
                    : "Live GDB inferiors require an explicit disposition because no durable inferior TTY is verified.",
                  {
                    retryable: true,
                    userMessage:
                      "Close requires an explicit inferior disposition.",
                    remediationAction:
                      "Use gdb_console with this session_id to explicitly detach or terminate each remaining inferior, then retry close_gdb_session.",
                  },
                ),
              );
            // Refusing inferior disposition above leaves console remediation
            // available; from here onward only owned cleanup may be retried.
            session.cleanupStarted = true;
            session.closeRequested = true;
            if (groupCount === 0) {
              session.noInferiorVerified = true;
              targetState = "none_observed";
              await this.#request(session, "-gdb-exit");
            } else {
              session.noInferiorVerified = false;
              const disposition = await this.#detachInferior(session);
              targetState =
                disposition.status === "no-inferior"
                  ? "none_observed"
                  : "unknown";
            }
          } catch {
            // If MI synchronization is lost, stop only the owned debugger process.
          }
          const stopped = await this.#stopDebuggerOnly(session);
          if (stopped.status === "incomplete")
            return err(
              this.#sessions.retainCleanupFailure(
                session,
                "close_gdb_session",
                stopped.reason,
              ),
            );
          this.#sessions.remove(session);
          return ok({ target_state: targetState });
        },
        undefined,
        "close_gdb_session",
      );
    } catch (cause) {
      if (cause instanceof AnalysisError) return err(cause);
      throw cause;
    }
  }

  async #finishSessionCleanup(
    session: GdbSession,
  ): Promise<Result<{ readonly target_state: "unknown" }, AnalysisError>> {
    session.closeRequested = true;
    const stopped = await this.#stopDebuggerOnly(session);
    if (stopped.status === "incomplete")
      return err(
        this.#sessions.retainCleanupFailure(
          session,
          "close_gdb_session",
          stopped.reason,
        ),
      );
    this.#sessions.remove(session);
    return ok({ target_state: "unknown" });
  }

  async retryCleanupFailures(): Promise<Result<null, AnalysisError>> {
    return this.#sessions.retryCleanupFailures(
      (session) => session.ready && !session.closeRequested,
    );
  }

  async closeAll(): Promise<void> {
    this.#closing = true;
    this.#closePromise ??= this.#drainStartsAndCloseSessions().catch(
      (cause: unknown) => {
        this.#closePromise = undefined;
        throw cause;
      },
    );
    return this.#closePromise;
  }

  async #drainStartsAndCloseSessions(): Promise<void> {
    await this.#sessions.closeStarts();
    await Promise.all(
      [...this.#sessions.values()].map((session) => session.commandTail),
    );
    await this.#sessions.closeAll();
  }

  async #serialize<Value>(
    session: GdbSession,
    operation: () => Promise<Value>,
    signal?: AbortSignal,
    operationName: "gdb_console" | "close_gdb_session" = "gdb_console",
  ): Promise<Value> {
    if (session.pendingCommandCount >= this.#maxPendingCommands.value)
      throw debuggerResourceConstraintError(
        operationName,
        "transport",
        `GDB command queue capacity reached (${String(this.#maxPendingCommands.value)} pending commands).`,
        "Wait for a GDB command on this session to finish, then retry.",
        this.#maxPendingCommands,
        {
          max_pending_commands: this.#maxPendingCommands.value,
          active_or_queued_commands: session.pendingCommandCount,
        },
      );
    session.pendingCommandCount += 1;
    const previous = session.commandTail;
    let release: (() => void) | undefined;
    let acquired = false;
    session.commandTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await waitForGdbCommandTurn(previous, signal);
      acquired = true;
      return await operation();
    } finally {
      if (acquired) {
        session.pendingCommandCount -= 1;
        release?.();
      } else {
        // The cancelled placeholder still occupies commandTail until its turn.
        // Keep its reservation until then so repeated cancellations cannot
        // bypass the per-session queue bound while an earlier command stalls.
        void previous.then(() => {
          session.pendingCommandCount -= 1;
          release?.();
        });
      }
    }
  }

  #receive(session: GdbSession, data: Buffer): void {
    if (session.startupResolve !== undefined) {
      const prompt = session.promptTail + data.toString("utf8");
      if (prompt.includes("(gdb)")) {
        const resolve = session.startupResolve;
        session.startupResolve = undefined;
        resolve();
      }
      session.promptTail = prompt.slice(-4);
    }
    const lines: { readonly value: string; readonly invalidUtf8: boolean }[] =
      [];
    let offset = 0;
    let framingFailure: string | undefined;
    while (offset < data.byteLength) {
      if (session.discardingOversizedStreamRecord) {
        const newline = data.indexOf(0x0a, offset);
        if (newline < 0) break;
        session.discardingOversizedStreamRecord = false;
        offset = newline + 1;
        continue;
      }
      const newline = data.indexOf(0x0a, offset);
      const piece = data.subarray(
        offset,
        newline < 0 ? data.byteLength : newline,
      );
      session.bufferBytes += piece.byteLength;
      const lineBytes =
        session.bufferBytes - (newline >= 0 && piece.at(-1) === 0x0d ? 1 : 0);
      if (lineBytes > MAX_MI_LINE_BYTES) {
        const firstByte =
          session.bufferChunks[0]?.at(0) ??
          session.bufferTail?.at(0) ??
          piece.at(0);
        if (firstByte === 0x7e || firstByte === 0x40 || firstByte === 0x26) {
          session.bufferChunks.length = 0;
          session.bufferTail = undefined;
          session.bufferTailBytes = 0;
          session.bufferBytes = 0;
          for (const pending of session.pending.values())
            pending.outputLimits.add("mi_line_bytes");
          session.recentRecordsTruncated = true;
          if (newline < 0) {
            session.discardingOversizedStreamRecord = true;
            break;
          }
          offset = newline + 1;
          continue;
        }
        framingFailure = `GDB emitted an MI line exceeding the ${String(MAX_MI_LINE_BYTES)} byte (16 MiB) protocol limit. This release has no runtime override.`;
        break;
      }
      this.#appendLineBytes(session, piece);
      if (newline < 0) break;
      const record = Buffer.concat(
        [
          ...session.bufferChunks,
          ...(session.bufferTail === undefined
            ? []
            : [session.bufferTail.subarray(0, session.bufferTailBytes)]),
        ],
        session.bufferBytes,
      );
      const withoutCarriageReturn =
        record.at(-1) === 0x0d ? record.subarray(0, -1) : record;
      const invalidUtf8 = !isUtf8(withoutCarriageReturn);
      const line = withoutCarriageReturn.toString("utf8");
      session.bufferChunks.length = 0;
      session.bufferTail = undefined;
      session.bufferTailBytes = 0;
      session.bufferBytes = 0;
      if (invalidUtf8) session.invalidUtf8Observed = true;
      if (line.length > 0) lines.push({ value: line, invalidUtf8 });
      offset = newline + 1;
    }
    for (const { value: line } of lines) {
      if (Buffer.byteLength(line, "utf8") > MAX_RECENT_MI_LINE_BYTES) {
        session.lines.push(truncateUtf8RecordPrefix(line));
        session.recentRecordsTruncated = true;
      } else session.lines.push(line);
    }
    if (session.lines.length > 256) {
      session.lines.splice(0, session.lines.length - 256);
      session.recentRecordsTruncated = true;
    }
    for (const { value: line, invalidUtf8 } of lines) {
      for (const pending of session.pending.values()) {
        const lineBytes = Buffer.byteLength(line, "utf8") + 1;
        if (
          pending.outputBytes + lineBytes <= pending.outputBudgetBytes &&
          pending.lines.length < MAX_COMMAND_OUTPUT_RECORDS
        ) {
          pending.lines.push(line);
          pending.outputBytes += lineBytes;
          pending.outputInvalidUtf8 ||= invalidUtf8;
        } else {
          if (pending.outputBytes + lineBytes > pending.outputBudgetBytes)
            pending.outputLimits.add("command_bytes");
          if (pending.lines.length >= MAX_COMMAND_OUTPUT_RECORDS)
            pending.outputLimits.add("command_records");
        }
      }
      if (line === "(gdb)" || line === "(gdb) ") {
        // Shell stdout can precede its result token without an LF. Never scan
        // caller output for a token-looking suffix. Once GDB returns its prompt,
        // correlate a fresh read-only query before completing that console turn.
        for (const pending of session.pending.values()) {
          if (
            session.ready &&
            pending.command.startsWith("-interpreter-exec console ") &&
            pending.terminalRecord === undefined &&
            pending.completionToken === undefined
          ) {
            pending.completionToken = session.nextToken++;
            this.#writeMiRequest(
              session,
              pending.completionToken,
              "-gdb-show mi-async",
            );
          }
        }
      }
      const header = gdbMiResultHeader(line);
      if (header === undefined) continue;
      if (invalidUtf8) {
        this.#failProtocol(
          session,
          "output-correlation-failure",
          "GDB emitted an MI result record containing invalid UTF-8.",
        );
        return;
      }
      const { token } = header;
      const pending =
        session.pending.get(token) ??
        [...session.pending.values()].find(
          (command) => command.completionToken === token,
        );
      if (pending === undefined) continue;
      if (token === pending.completionToken) {
        if (header.resultClass !== "done") {
          this.#failProtocol(
            session,
            "output-correlation-failure",
            "GDB command completion query failed.",
          );
          continue;
        }
      } else {
        pending.terminalRecord = line;
        if (
          header.resultClass === "running" &&
          pending.completionToken === undefined
        ) {
          // ^running and *stopped describe inferior execution, not completion
          // of an outer CLI command such as a multi-run command file. GDB
          // processes this read-only query after returning to its command loop.
          pending.completionToken = session.nextToken++;
          this.#writeMiRequest(
            session,
            pending.completionToken,
            "-gdb-show mi-async",
          );
        }
        if (pending.completionToken !== undefined) continue;
      }
      clearTimeout(pending.timer);
      session.pending.delete(pending.token);
      pending.cleanup();

      pending.resolve({
        command: "",
        // A query proves return to the command loop, not the class of a
        // result record that raw stdout prevented us from framing separately.
        mi:
          pending.terminalRecord ??
          (token === pending.completionToken ? "" : line),
        ...snapshotGdbCommandRecords(pending.lines),
        ...gdbOutputCapture(pending),
        ...(pending.outputInvalidUtf8
          ? { output_invalid_utf8: true as const }
          : {}),
        completion_status: "complete",
      });
    }
    if (framingFailure !== undefined)
      this.#failProtocol(session, "output-correlation-failure", framingFailure);
  }

  #appendLineBytes(session: GdbSession, piece: Buffer): void {
    const slabBytes = 64 * 1024;
    let offset = 0;
    while (offset < piece.length) {
      session.bufferTail ??= Buffer.allocUnsafe(slabBytes);
      const remaining = slabBytes - session.bufferTailBytes;
      const copied = Math.min(remaining, piece.length - offset);
      piece.copy(
        session.bufferTail,
        session.bufferTailBytes,
        offset,
        offset + copied,
      );
      session.bufferTailBytes += copied;
      offset += copied;
      if (session.bufferTailBytes === slabBytes) {
        session.bufferChunks.push(session.bufferTail);
        session.bufferTail = undefined;
        session.bufferTailBytes = 0;
      }
    }
  }

  #failProtocol(
    session: GdbSession,
    code: DebuggerSessionStopCode,
    message: string,
  ): void {
    if (session.exited || session.protocolError !== undefined) return;
    session.protocolError = { code, reason: message };
    for (const pending of session.pending.values()) {
      clearTimeout(pending.timer);
      pending.cleanup();

      pending.reject(
        new GdbProtocolFailureError(message, {
          command: pending.evidenceCommand,
          mi: "",
          ...snapshotGdbCommandRecords(pending.lines),
          ...gdbOutputCapture(pending),
          ...(pending.outputInvalidUtf8
            ? { output_invalid_utf8: true as const }
            : {}),
          completion_status: "unknown",
        }),
      );
    }
    session.pending.clear();
    session.startupReject?.(new Error(message));
  }

  async #stopAfterProtocolFailure(
    session: GdbSession,
    cause: unknown,
  ): Promise<AnalysisCapabilityUnavailableError> {
    const stopped = await this.#stopDebuggerOnly(session);
    const partial =
      cause instanceof GdbProtocolFailureError ? cause.partial : undefined;
    const partialObservation =
      partial === undefined
        ? undefined
        : createEvidence(undefined, session.provider, {
            predicateType: "rea.debugger.console-observation",
            operation: "gdb_console",
            parameters: {
              session_id: session.id,
              command: partial.command,
            },
            result: { ...partial, records: [...partial.records] },
            rawResult: { ...partial, records: [...partial.records] },
            subjectUnavailableReason:
              "The active GDB inferior identity is not established by the debugger session identifier.",
            limitations: [
              "The GDB MI protocol failed; retained records are partial and command completion is unknown.",
              "The unrestricted GDB console can access local shell, filesystem, network, and target controls.",
            ],
          });
    const stop = session.protocolError!;
    return new AnalysisCapabilityUnavailableError(
      "gdb",
      "gdb_console",
      stopped.status === "incomplete"
        ? `${stop.reason} The owned process could not be confirmed stopped: ${stopped.reason}`
        : stop.reason,
      {
        cause,
        diagnostics: { session_stop: stop.code },
        ...(stopped.status === "incomplete"
          ? {
              cleanup: {
                reason: stopped.reason,
                resources: [session.id],
              },
            }
          : {}),
        ...(partialObservation === undefined ? {} : { partialObservation }),
      },
    );
  }

  #stopDebuggerOnly(
    session: GdbSession,
  ): ReturnType<typeof stopOwnedDebuggerProcess> {
    return this.#sessions.stop(session);
  }

  async #detachInferior(
    session: GdbSession,
  ): Promise<OwnedDebuggerDetachResult> {
    if (session.noInferiorVerified) return { status: "no-inferior" };
    if (session.exited)
      throw new Error("GDB exited before inferior state could be verified.");
    // A new MI inspection replaces the old snapshot. If this read is
    // incomplete, malformed, or reports multiple inferiors, no earlier PID
    // can stand in for the current unknown inventory.
    session.knownInferiorIdentities.clear();
    // Queue reservations have not sent MI requests and do not affect synchronization.
    if (session.protocolError !== undefined || session.pending.size > 0)
      throw new Error(
        "GDB MI state is not synchronized; inferior state is unknown.",
      );
    const groups = await this.#request(
      session,
      "-list-thread-groups --recurse 1",
    );
    if (
      groups.completion_status !== "complete" ||
      groups.output_truncated ||
      !parseGdbMiDoneRecord(groups.mi).ok
    )
      throw new Error("GDB could not confirm its inferior state.");
    const inferiorPids = gdbThreadGroupPids(groups.mi);
    if (inferiorPids?.length === 0) {
      session.knownInferiorIdentities.clear();
      session.noInferiorVerified = true;
      return { status: "no-inferior" };
    }
    session.noInferiorVerified = false;
    if (inferiorPids?.length !== 1)
      throw new Error(
        inferiorPids === undefined
          ? "GDB returned an unknown recursive inferior list."
          : "GDB reports multiple inferiors; automatic detach cannot be confirmed safely.",
      );
    if (!session.inferiorTtyVerified)
      throw new Error(
        "GDB cannot detach the live inferior because no durable output sink was verified at session startup.",
      );
    const observedTty = await this.#request(session, "-inferior-tty-show");
    if (
      observedTty.completion_status !== "complete" ||
      observedTty.output_truncated ||
      !parseGdbMiDoneRecord(observedTty.mi).ok ||
      miStringField(observedTty.mi, "inferior_tty_terminal") !==
        session.inferiorTty
    )
      throw new Error(
        "GDB no longer reports the caller-selected inferior TTY; detachment cannot be confirmed safely.",
      );
    await this.#verifyInferiorOutputSink(
      inferiorPids[0]!,
      session.inferiorTty!,
      (identity) =>
        session.knownInferiorIdentities.set(
          `${identity.pid}:${identity.startTime}`,
          identity,
        ),
    );
    const detached = await this.#request(session, "-target-detach");
    if (
      detached.completion_status !== "complete" ||
      detached.output_truncated ||
      !parseGdbMiDoneRecord(detached.mi).ok
    )
      throw new Error("GDB did not confirm inferior detachment.");
    session.knownInferiorIdentities.clear();
    // The sole recursively inventoried inferior is now detached. Retain this
    // fact for owned shutdown even if the MI transport becomes unavailable.
    session.noInferiorVerified = true;
    return { status: "detached", outputSink: "durable" };
  }

  async #settleExitedCommands(
    session: GdbSession,
    code: number | null,
    signalCode: NodeJS.Signals | null,
  ): Promise<void> {
    await this.#waitForStdoutSettlement(session);
    for (const pending of session.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        new GdbCommandProcessExitError({
          command: pending.evidenceCommand,
          mi: "",
          ...snapshotGdbCommandRecords(pending.lines),
          process_exit_observed: true,
          process_exit_code: code,
          process_exit_signal: signalCode,
          ...gdbOutputCapture(pending),
          ...(pending.outputInvalidUtf8
            ? { output_invalid_utf8: true as const }
            : {}),
          completion_status: "unknown",
        }),
      );
    }
    session.pending.clear();
  }

  async #waitForStdoutSettlement(session: GdbSession): Promise<void> {
    let timer!: ReturnType<typeof setTimeout>;
    try {
      await Promise.race([
        session.stdoutSettled,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 1_000);
          timer.unref?.();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  #request(
    session: GdbSession,
    command: string,
    signal?: AbortSignal,
    operation: "gdb_console" | "start_gdb_session" = "gdb_console",
    evidenceCommand: string = command,
    accepted?: {
      readonly deadline: DebuggerAdmissionLimit;
      readonly output: DebuggerAdmissionLimit;
    },
  ): Promise<GdbCommandResult> {
    const stdin = session.launched.process.stdin;
    if (session.exited)
      return Promise.reject(
        new Error(
          `GDB MI process has exited (exit code ${String(session.exitCode)}, signal ${String(session.exitSignal)}).`,
        ),
      );
    if (
      stdin === null ||
      stdin === undefined ||
      stdin.destroyed ||
      !stdin.writable
    ) {
      const message = "GDB MI input stream is closed";
      this.#failProtocol(session, "input-stream-failure", message);
      return Promise.reject(new Error(message));
    }
    const token = session.nextToken++;
    const acceptedDeadline = accepted?.deadline ?? this.#commandDeadline;
    const acceptedOutput = command.startsWith("-interpreter-exec console ")
      ? (accepted?.output ?? this.#commandOutput)
      : debuggerControlReplyOutput;
    return new Promise<GdbCommandResult>((resolve, reject) => {
      let abortListener!: () => void;
      const cleanup = (): void => {
        signal?.removeEventListener("abort", abortListener);
      };
      let pending!: PendingCommand;
      const timer = setTimeout(() => {
        session.pending.delete(token);
        const stop: DebuggerSessionStop = {
          code: "command-deadline",
          reason:
            "A GDB MI command timed out; untagged stream output can no longer be safely correlated with later commands.",
        };
        session.protocolError = stop;
        pending.cleanup();
        const partial: GdbCommandResult = {
          command: pending.evidenceCommand,
          mi: "",
          ...snapshotGdbCommandRecords(pending.lines),
          ...gdbOutputCapture(pending),
          ...(pending.outputInvalidUtf8
            ? { output_invalid_utf8: true as const }
            : {}),
          completion_status: "unknown",
        };
        const timeout = new AnalysisTimeoutError(
          operation,
          acceptedDeadline.value,
          {
            cause: new Error(`GDB MI command timed out: ${command}`),
            ...configurableDeadlineGuidance(
              "The GDB MI command",
              acceptedDeadline,
            ),
          },
        );
        const evidence = createEvidence(undefined, session.provider, {
          predicateType:
            operation === "start_gdb_session"
              ? "rea.debugger.startup-observation"
              : "rea.debugger.console-observation",
          operation,
          parameters: {
            session_id: session.id,
            command: pending.evidenceCommand,
          },
          result: { ...partial, records: [...partial.records] },
          rawResult: { ...partial, records: [...partial.records] },
          subjectUnavailableReason:
            "The active GDB inferior identity is not established by the debugger session identifier.",
          limitations: [
            `The GDB command exceeded its ${String(acceptedDeadline.value)} ms deadline (deadlineExpired). ${debuggerAdmissionRecovery(acceptedDeadline)} Retained MI and stream records are partial and command completion is unknown.`,
            ...gdbRetainedOutputLimitations(partial, acceptedOutput),
            "Cleanup of the owned GDB process was requested because output correlation could no longer be guaranteed.",
            "The unrestricted GDB console can access local shell, filesystem, network, and target controls.",
          ],
        });
        void this.#stopDebuggerOnly(session).then((stopped) => {
          if (
            stopped.status === "incomplete" &&
            operation === "start_gdb_session"
          ) {
            pending.reject(
              new AnalysisTimeoutError(operation, acceptedDeadline.value, {
                cause: timeout,
                cleanup: { reason: stopped.reason, resources: [session.id] },
                partialObservation: evidence,
                ...copiedTimeoutGuidance(timeout),
              }),
            );
            return;
          }
          pending.reject(
            stopped.status === "incomplete"
              ? new AnalysisCapabilityUnavailableError(
                  "gdb",
                  "gdb_console",
                  `GDB command output could not be correlated and its owned process could not be confirmed stopped: ${stopped.reason}`,
                  {
                    cause: timeout,
                    diagnostics: { session_stop: stop.code },
                    cleanup: {
                      reason: stopped.reason,
                      resources: [session.id],
                    },
                    partialObservation: evidence,
                  },
                )
              : new GdbCommandTimeoutError(partial, evidence, acceptedDeadline),
          );
        });
      }, acceptedDeadline.value);
      // Cleanup bounds its own wait, so a late reply must not hold the host open.
      if (session.cleanupStarted) timer.unref();
      pending = {
        token,
        command,
        evidenceCommand,
        lines: [],
        resolve: (result) => {
          cleanup();
          resolve(result);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
        cleanup,
        timer,
        outputBytes: 0,
        outputBudgetBytes: acceptedOutput.value,
        outputLimits: new Set(),
        outputInvalidUtf8: false,
        terminalRecord: undefined,
        completionToken: undefined,
      };
      session.pending.set(token, pending);
      abortListener = (): void => {
        clearTimeout(pending.timer);
        const partial: GdbCommandResult = {
          command: pending.evidenceCommand,
          mi: "",
          ...snapshotGdbCommandRecords(pending.lines),
          ...gdbOutputCapture(pending),
          ...(pending.outputInvalidUtf8
            ? { output_invalid_utf8: true as const }
            : {}),
          completion_status: "unknown",
        };
        const evidence = createEvidence(undefined, session.provider, {
          predicateType: "rea.debugger.console-observation",
          operation: "gdb_console",
          parameters: {
            session_id: session.id,
            command: pending.evidenceCommand,
          },
          result: { ...partial, records: [...partial.records] },
          rawResult: { ...partial, records: [...partial.records] },
          subjectUnavailableReason:
            "The active GDB inferior identity is not established by the debugger session identifier.",
          limitations: [
            "The GDB command was cancelled; retained MI records are partial and command completion is unknown.",
            ...gdbRetainedOutputLimitations(partial, acceptedOutput),
            "Shutdown of the owned GDB process was requested because output correlation could no longer be guaranteed.",
            "The unrestricted GDB console can access local shell, filesystem, network, and target controls.",
          ],
        });
        session.pending.delete(token);
        session.protocolError = {
          code: "command-cancelled",
          reason:
            "A GDB MI command was cancelled; owned-session shutdown was requested because output correlation can no longer be guaranteed.",
        };
        void this.#stopDebuggerOnly(session).then((stopped) => {
          if (stopped.status !== "incomplete") {
            pending.reject(
              cancelledBy("gdb_console", carriedReason(signal?.reason), {
                partialObservation: evidence,
              }),
            );
            return;
          }
          const cancellation = new AnalysisCancelledError("gdb_console", {
            cause: signal?.reason,
            partialObservation: evidence,
          });
          const cleanupFailure = this.#sessions.retainCleanupFailure(
            session,
            "gdb_console",
            stopped.reason,
            { cause: cancellation },
          );
          pending.reject(
            cancelledBy("gdb_console", carriedReason(signal?.reason), {
              cleanup: {
                reason: stopped.reason,
                resources: [session.id],
              },
              partialObservation: evidence,
            }).bindCleanupDependencies([cleanupFailure], {
              cleanupResources: [session.id],
            }),
          );
        });
      };
      signal?.addEventListener("abort", abortListener, { once: true });
      if (signal?.aborted) {
        abortListener();
        return;
      }
      this.#writeMiRequest(session, token, command);
    }).then((result) => ({ ...result, command }));
  }
  #writeMiRequest(session: GdbSession, token: number, command: string): void {
    try {
      session.launched.process.stdin?.write(
        `${token}${command}\n`,
        "utf8",
        (cause?: Error | null) => {
          if (cause)
            this.#failProtocol(
              session,
              "input-stream-failure",
              `GDB stdin write failed: ${cause.message}`,
            );
        },
      );
    } catch (cause) {
      this.#failProtocol(
        session,
        "input-stream-failure",
        `GDB stdin write failed: ${cause instanceof Error ? cause.message : "unknown error"}`,
      );
    }
  }
}

const miQuote = (value: string): string =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\r", "\\r").replaceAll("\n", "\\n").replaceAll("\t", "\\t")}"`;

/** @internal Decode the only result of a `^done` record, a C-string field. */
export const miStringField = (
  record: string,
  field: string,
): string | undefined => {
  const parsed = parseGdbMiDoneRecord(record);
  if (!parsed.ok) return undefined;
  const [only, ...rest] = parsed.value.results;
  return only?.name === field && rest.length === 0
    ? gdbMiConstText(only.value)
    : undefined;
};

// GDB resolves its built-in aliases before abbreviations, so `p` is print, never
// python. Of the prefixes of the commands classified below, only these four
// name another command (checked against GDB 18.1).
const GDB_BUILTIN_ALIASES: ReadonlyMap<string, string> = new Map([
  ["d", "delete"],
  ["p", "print"],
  ["s", "step"],
  ["t", "thread"],
]);

/** The first console word, lowercased, with GDB's built-in aliases resolved. */
const gdbCommandWord = (command: string): string | undefined => {
  const word = /^\s*([^\s;]+)/u.exec(command)?.[1]?.toLowerCase();
  return word === undefined
    ? undefined
    : (GDB_BUILTIN_ALIASES.get(word) ?? word);
};

/** @internal Classify commands that can invalidate the configured output sink. */
export const gdbOneShotCommandMayInvalidateDetachProof = (
  command: string,
): boolean => {
  if (commandMayChangeInferiorOutput(command)) return true;
  const firstToken = gdbCommandWord(command);
  if (
    firstToken !== undefined &&
    (["source", "define", "alias"].some((name) =>
      name.startsWith(firstToken),
    ) ||
      firstToken === "py" ||
      "python".startsWith(firstToken))
  )
    return true;
  // One-shot execution cannot establish which shell/GDB context interprets
  // redirections, nor safely track multiline command definitions.
  return /[<>]{1,2}|&>|[\r\n;]/u.test(command);
};

/** @internal Classify commands that can invalidate the configured output sink. */
export const commandMayChangeInferiorOutput = (command: string): boolean => {
  // These exact read-only TTY inspections ("show inferior-tty", "help
  // inferior-tty", MI "-inferior-tty-show") cannot reconfigure the output
  // sink, so they must not revoke the startup verification. Keep compound
  // commands and abbreviations under the conservative rules below
  // (fail-closed).
  if (
    /^[ \t]*(?:show|help)[ \t]+inferior-tty[ \t]*$/iu.test(command) ||
    /^[ \t]*-inferior-tty-show[ \t]*$/iu.test(command)
  )
    return false;
  const setting = /^\s*(?:set|with)\s+(\S+)/iu.exec(command)?.[1];
  const maySetInferiorTty =
    setting !== undefined && "inferior-tty".startsWith(setting.toLowerCase());
  const firstToken = gdbCommandWord(command);
  const mayBeTtyCommand =
    firstToken !== undefined && "tty".startsWith(firstToken);
  const mayDefineAlias =
    firstToken !== undefined && "alias".startsWith(firstToken);
  const mayRunWithOutputRedirection =
    firstToken !== undefined &&
    ["run", "start", "starti"].some((name) => name.startsWith(firstToken)) &&
    /[<>]{1,2}|&>/u.test(command.slice(firstToken.length));
  return (
    maySetInferiorTty ||
    mayBeTtyCommand ||
    mayDefineAlias ||
    /\binferior-tty\b/iu.test(command) ||
    /^\s*(?:wit(?:h)?(?:\s|$)|tty(?:\s|$)|source\b|py\w*|define\b)/iu.test(
      command,
    ) ||
    mayRunWithOutputRedirection
  );
};

/** Await a serialized command turn, preserving the caller's cancellation reason. */
const waitForGdbCommandTurn = (
  previous: Promise<void>,
  signal?: AbortSignal,
): Promise<void> => {
  if (signal === undefined) return previous;
  return waitForAbortable(previous, signal).then((outcome) => {
    if (outcome instanceof AbortedWait)
      throw cancelledBy("gdb_console", outcome);
  });
};
