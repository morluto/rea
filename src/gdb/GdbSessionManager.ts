import {
  GDB_PROVIDER_IDENTITY,
  isGdbInterruptCommand,
  isGdbTargetDispositionCommand,
} from "./GdbProviderIdentity.js";
export {
  isGdbInterruptCommand,
  isGdbTargetDispositionCommand,
} from "./GdbProviderIdentity.js";
import { persistentDebuggerHostSupported } from "../process/PersistentDebuggerHost.js";
import { ABORTED, waitForAbortable } from "../process/AbortablePromise.js";
import { snapshotGdbCommandRecords } from "./GdbCommandRecords.js";import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { isUtf8 } from "node:buffer";
import { readlink, realpath, stat } from "node:fs/promises";

import {
  AnalysisCapabilityUnavailableError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
} from "../domain/analysisErrorCore.js";
import {
  AnalysisError,
  type AnalysisErrorOptions,
} from "../domain/analysisErrorBase.js";
import { createEvidence, type Evidence } from "../domain/evidence.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { GdbCommandResult } from "../domain/commandObservation.js";
import { DEBUGGER_CONTROL_REPLY_BYTES } from "../domain/analysisResourceLimits.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  ProviderProcessSupervisor,
  spawnOwnedProviderProcess,
  type OwnedProviderProcessSpawnOptions,
  type SpawnedOwnedProviderProcess,
} from "../process/ProviderProcess.js";
import {
  applyDebuggerAdmissionOverride,
  resolveDebuggerSessionLimits,
  type DebuggerAdmissionLimit,
} from "../config/debuggerSessionLimits.js";
import {
  closeOwnedDebuggerSessions,
  configurableDeadlineGuidance,
  debuggerAdmissionDiagnostics,
  debuggerAdmissionRecovery,
  debuggerResourceConstraintError,
  fixedDeadlineGuidance,  readLinuxProcessStartTime,
  stopOwnedDebuggerProcess,
  type OwnedDebuggerDetachResult,
  type OwnedDebuggerStopResult,
  type OwnedInferiorIdentity,
  type ProcessStartTimeReader,
  verifyOwnedInferiorsEnded,
} from "../process/ownedDebuggerSession.js";
import {
  verifyInferiorInputSink,
  type InferiorInputSink,
} from "../process/inferiorInputSink.js";
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
}const MAX_COMMAND_OUTPUT_RECORDS = 16_384;
const MAX_MI_LINE_BYTES = 16 * 1024 * 1024;
const MAX_RECENT_MI_LINE_BYTES = 64 * 1024;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const RECENT_RECORD_TRUNCATION_MARKER = "[recent record truncated]";

const gdbRetainedOutputLimitation = (output: DebuggerAdmissionLimit): string =>
  `Retained MI records reached the ${String(output.value)} byte command-output cap or the ${String(MAX_COMMAND_OUTPUT_RECORDS)} record cap. ${debuggerAdmissionRecovery(output)} The record cap has no separate setting. Output completeness is unknown.`;

const cancelledWithCallerReason = (
  operation: string,
  signal: AbortSignal,
  previous?: AnalysisCancelledError,
): AnalysisCancelledError => {
  const cancellation = new AnalysisCancelledError(operation, {
    cause: signal.reason,
    cleanupPrimary: previous,
    ...(previous?.diagnostics === undefined
      ? {}
      : { diagnostics: previous.diagnostics }),
    ...(previous?.capturedOutput === undefined
      ? {}
      : { capturedOutput: previous.capturedOutput }),
    ...(previous?.cleanup === undefined ? {} : { cleanup: previous.cleanup }),
    ...(previous?.partialObservation === undefined
      ? {}
      : { partialObservation: previous.partialObservation }),
  });
  if (previous?.cleanupIncomplete)
    cancellation.bindCleanupDependencies([previous]);
  return cancellation;
};

interface PendingCommand {
  readonly token: number;
  readonly command: string;
  readonly evidenceCommand: string;
  readonly interrupt: boolean;
  readonly lines: string[];
  outputBytes: number;
  /** Caller output uses the setting. Startup and detach replies use the control budget. */
  readonly outputBudgetBytes: number;
  outputTruncated: boolean;
  outputInvalidUtf8: boolean;
  terminalRecord: string | undefined;
  completionToken: number | undefined;
  awaitingInferiorStop: boolean;
  interruptReplyObserved: boolean;
  interruptStopObserved: boolean;  readonly resolve: (result: GdbCommandResult) => void;
  readonly reject: (error: Error) => void;
  readonly cleanup: () => void;
  timer: ReturnType<typeof setTimeout>;
}

class GdbCommandTimeoutError extends AnalysisTimeoutError {
  constructor(
    readonly partial: GdbCommandResult,
    readonly evidence: Evidence,
    deadline: DebuggerAdmissionLimit,
  ) {
    super("gdb_console", deadline.value, {
      ...configurableDeadlineGuidance("The GDB MI command", deadline),
    });  }
}

const truncateUtf8RecordPrefix = (line: string): string => {
  const budget =
    MAX_RECENT_MI_LINE_BYTES -
    Buffer.byteLength(RECENT_RECORD_TRUNCATION_MARKER, "utf8");
  let prefix = "";
  let retainedBytes = 0;
  for (const codePoint of line) {
    const codePointBytes = Buffer.byteLength(codePoint, "utf8");
    if (retainedBytes + codePointBytes > budget) break;
    prefix += codePoint;
    retainedBytes += codePointBytes;
  }
  return `${prefix}${RECENT_RECORD_TRUNCATION_MARKER}`;
};

/** Bound parser memory when a capped MI record contains extreme nesting. */
const MAX_GDB_MI_NESTED_VALUE_FRAMES = 256;

/** Parse a complete MI result record and retain the unique top-level groups list span. */
const gdbMiGroupsListSpan = (
  mi: string,
): { readonly start: number; readonly end: number } | undefined => {
  const prefix = /^(?:\d+)?\^done/u.exec(mi)?.[0];
  if (prefix === undefined) return undefined;
  const isNameCharacter = (character: string | undefined): boolean =>
    character !== undefined &&
    !/[=,{}[\]"\s]/u.test(character) &&
    character.charCodeAt(0) >= 0x20;
  const readName = (start: number): number => {
    if (!isNameCharacter(mi[start])) return start;
    let cursor = start;
    while (isNameCharacter(mi[cursor])) cursor += 1;
    return cursor;
  };
  const readString = (start: number): number | undefined => {
    for (let cursor = start + 1; cursor < mi.length; cursor += 1) {
      const character = mi[cursor];
      if (character === '"') return cursor + 1;
      if (character === "\\") {
        cursor += 1;
        const escaped = mi[cursor];
        if (escaped === undefined) return undefined;
        if (escaped === "x") {
          const startHex = cursor + 1;
          cursor = startHex;
          while (/[0-9a-f]/iu.test(mi[cursor] ?? "")) cursor += 1;
          if (cursor === startHex) return undefined;
          cursor -= 1;
        } else if (/[0-7]/u.test(escaped)) {
          let digits = 1;
          while (digits < 3 && /[0-7]/u.test(mi[cursor + 1] ?? "")) {
            cursor += 1;
            digits += 1;
          }
        } else if (!/^[abfnrtv\\'"?]$/u.test(escaped)) return undefined;
      } else if (mi.charCodeAt(cursor) < 0x20) return undefined;
    }
    return undefined;
  };
  const stack: {
    readonly kind: "list" | "tuple";
    readonly close: "]" | "}";
    readonly groupInventory: boolean;
    readonly groupStart: number | undefined;
    readonly groupTuple: boolean;
    phase: "first" | "afterComma" | "afterItem";
    listItems: "result" | "value" | undefined;
    groupIdSeen: boolean;
  }[] = [];
  let groupSpan: { start: number; end: number } | undefined;
  let groupSeen = false;
  let cursor = prefix.length;
  let valueStart = -1;
  let pendingGroupList = false;

  const completeValue = (): void => {
    const parent = stack.at(-1);
    if (parent !== undefined) parent.phase = "afterItem";
  };

  const beginValue = (): boolean => {
    const character = mi[cursor];
    if (pendingGroupList && character !== "[") return false;
    if (character === '"') {
      const end = readString(cursor);
      if (end === undefined) return false;
      cursor = end;
      completeValue();
      return true;
    }
    if (character === "[" || character === "{") {
      const kind = character === "[" ? "list" : "tuple";
      const groupInventory = pendingGroupList;
      if (groupInventory && kind !== "list") return false;
      if (stack.length >= MAX_GDB_MI_NESTED_VALUE_FRAMES) return false;
      const parent = stack.at(-1);
      const groupTuple = kind === "tuple" && parent?.groupInventory === true;
      pendingGroupList = false;
      cursor += 1;
      stack.push({
        kind,
        close: kind === "list" ? "]" : "}",
        groupInventory,
        groupStart: groupInventory ? valueStart : undefined,
        groupTuple,
        phase: "first",
        listItems: undefined,
        groupIdSeen: false,
      });
      return true;
    }
    return false;
  };

  while (true) {
    const frame = stack.at(-1);
    if (frame === undefined) {
      if (cursor === mi.length) break;
      if (mi[cursor] !== ",") return undefined;
      cursor += 1;
      const nameEnd = readName(cursor);
      if (nameEnd === cursor || mi[nameEnd] !== "=") return undefined;
      const name = mi.slice(cursor, nameEnd);
      if (name === "groups") {
        if (groupSeen) return undefined;
        groupSeen = true;
        valueStart = nameEnd + 1;
        pendingGroupList = true;
      }
      cursor = nameEnd + 1;
      if (!beginValue()) return undefined;
      continue;
    }

    if (frame.phase === "afterItem") {
      if (mi[cursor] === ",") {
        cursor += 1;
        frame.phase = "afterComma";
        continue;
      }
      if (mi[cursor] !== frame.close) return undefined;
      if (frame.groupTuple && !frame.groupIdSeen) return undefined;
      cursor += 1;
      stack.pop();
      if (frame.groupInventory) {
        if (frame.groupStart === undefined) return undefined;
        groupSpan = { start: frame.groupStart, end: cursor };
      }
      completeValue();
      continue;
    }

    if (frame.phase === "first" && mi[cursor] === frame.close) {
      if (frame.groupTuple && !frame.groupIdSeen) return undefined;
      cursor += 1;
      stack.pop();
      if (frame.groupInventory) {
        if (frame.groupStart === undefined) return undefined;
        groupSpan = { start: frame.groupStart, end: cursor };
      }
      completeValue();
      continue;
    }
    if (frame.phase === "first" || frame.phase === "afterComma") {
      if (frame.kind === "tuple") {
        const nameEnd = readName(cursor);
        if (nameEnd === cursor || mi[nameEnd] !== "=") return undefined;
        if (frame.groupTuple && mi.slice(cursor, nameEnd) === "id") {
          if (frame.groupIdSeen || mi[nameEnd + 1] !== '"') return undefined;
          frame.groupIdSeen = true;
        }
        cursor = nameEnd + 1;
        if (!beginValue()) return undefined;
        continue;
      }

      const nameEnd = readName(cursor);
      const itemIsResult = nameEnd > cursor && mi[nameEnd] === "=";
      const itemKind = itemIsResult ? "result" : "value";
      if (frame.listItems !== undefined && frame.listItems !== itemKind)
        return undefined;
      frame.listItems = itemKind;
      if (frame.groupInventory && (itemIsResult || mi[cursor] !== "{"))
        return undefined;
      if (itemIsResult) cursor = nameEnd + 1;
      if (!beginValue()) return undefined;
      continue;
    }

    return undefined;
  }

  return groupSpan;
};

/** @internal Pure parser for live PIDs in recursive GDB MI thread groups. */
export const gdbThreadGroupPids = (
  mi: string,
): readonly string[] | undefined => {
  const groupsSpan = gdbMiGroupsListSpan(mi);
  if (groupsSpan === undefined) return undefined;
  const start = groupsSpan.start + 1;
  let squareDepth = 1;
  let objectDepth = 0;
  let quoted = false;
  let escaped = false;
  const pids: string[] = [];
  let fieldStart = start;
  let pidStart: number | undefined;
  let hasLivePid = false;
  let currentPid: string | undefined;
  for (let index = start; index < mi.length; index += 1) {
    const character = mi[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') {
        quoted = false;
        if (pidStart !== undefined) {
          const pid = mi.slice(pidStart, index);
          if (!/^[1-9]\d*$/u.test(pid)) return undefined;
          hasLivePid = true;
          currentPid = pid;
          pidStart = undefined;
        }
      }
      continue;
    }
    if (
      (mi[index - 1] === "{" || mi[index - 1] === ",") &&
      mi.startsWith("groups=", index)
    )
      return undefined;
    if (character === '"') {
      if (
        squareDepth === 1 &&
        objectDepth === 1 &&
        mi.slice(fieldStart, index) === "pid="
      ) {
        if (hasLivePid) return undefined;
        pidStart = index + 1;
      }
      quoted = true;
      continue;
    }
    if (character === "[") squareDepth += 1;
    else if (character === "]") {
      squareDepth -= 1;
      if (squareDepth === 0) {
        if (objectDepth !== 0 || index + 1 !== groupsSpan.end) return undefined;
        return pids;
      }
    } else if (character === "{") {
      if (squareDepth === 1 && objectDepth === 0) {
        hasLivePid = false;
        currentPid = undefined;
        fieldStart = index + 1;
      }
      objectDepth += 1;
    } else if (character === "}") {
      if (squareDepth === 1 && objectDepth === 1) {
        const field = mi.slice(fieldStart, index);
        if (field.startsWith("pid=") && !/^pid="[1-9]\d*"$/u.test(field))
          return undefined;
      }
      objectDepth -= 1;
      if (objectDepth < 0) return undefined;
      if (squareDepth === 1 && objectDepth === 0 && hasLivePid) {
        if (currentPid === undefined) return undefined;
        pids.push(currentPid);
      }
    } else if (character === "," && squareDepth === 1 && objectDepth === 1) {
      const field = mi.slice(fieldStart, index);
      if (field.startsWith("pid=") && !/^pid="[1-9]\d*"$/u.test(field))
        return undefined;
      fieldStart = index + 1;
    }
  }
  return undefined;
};

/** @internal Pure count of recursive GDB MI groups with live PIDs. */
export const gdbThreadGroupCount = (mi: string): number | undefined => {
  const pids = gdbThreadGroupPids(mi);
  return pids?.length;
};

const verifyGdbInferiorOutputSink = async (
  pid: string,
  selectedTty: string,
  rememberIdentity: (identity: OwnedInferiorIdentity) => void,
): Promise<InferiorInputSink> => {
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
  // Preserve the proven identity even if fd 0 cannot be classified. A later
  // retry can then confirm that the inferior ended after GDB exits.
  rememberIdentity({ pid, startTime: before });
  const inputSink = await verifyInferiorInputSink(
    pid,
    {
      path: ttyPath,
      dev: tty.dev,
      ino: tty.ino,
    },
    async () => {
      const current = await readLinuxProcessStartTime(pid);
      if (current !== before)
        throw new Error(
          "The GDB inferior identity changed while verifying its closed stdin descriptor.",
        );
    },
  );  return inputSink;
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

/** @internal Convert an unknown boundary failure without dropping non-Error values. */
export const gdbErrorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

interface GdbSession {
  readonly id: string;
  readonly miVersion: "mi3" | "mi2";
  readonly launched: SpawnedOwnedProviderProcess;
  readonly supervisor: ProviderProcessSupervisor;
  /** Confirms target disposition and any durable sink before process cleanup. */
  readonly detachInferior: () => Promise<OwnedDebuggerDetachResult>;
  readonly inferiorStateUnknown: () => boolean;
  readonly verifyInferiorsEndedAfterExit: () => Promise<boolean>;
  readonly knownInferiorGroupIds: Set<string>;
  readonly knownInferiorIdentities: Map<string, OwnedInferiorIdentity>;
  readonly inferiorIdentityCaptureGenerations: Map<string, number>;
  readonly inferiorIdentityCaptures: Set<Promise<void>>;
  nextInferiorIdentityCaptureGeneration: number;
  inferiorIdentityCaptureFailed: boolean;
  inferiorIdentityCaptureUntrusted: boolean;
  readonly inferiorTty: string | undefined;
  readonly maxCommandOutputBytes: number;
  /** Startup and detach MI. Separate from the caller command-output cap. */
  readonly controlReplyBytes: number;
  readonly stdoutSettled: Promise<void>;
  readonly settleStdout: () => void;
  inferiorTtyVerified: boolean;
  noInferiorVerified: boolean;
  /** Sticky admission seal once destructive cleanup starts, including failed stops. */
  cleanupStarted: boolean;
  stopAttempt: ReturnType<typeof stopOwnedDebuggerProcess> | undefined;
  readonly pending: Map<number, PendingCommand>;
  readonly cleanupFailures: Set<AnalysisError>;
  readonly lines: string[];
  readonly bufferChunks: Buffer[];
  bufferTail: Buffer | undefined;
  bufferTailBytes: number;
  bufferBytes: number;
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
  protocolError: string | undefined;
  /**
   * Set when the caller abandoned the active command (cancel or timeout). New
   * commands stay refused, but the MI framing is intact, so the verified detach
   * proof may still run: abandoning a command must never make the owned session
   * impossible to stop.
   */
  commandAbandoned: string | undefined;
  abandonedToken: number | undefined;
  inferiorRunning: boolean;
  inferiorDispositionConfirmed: boolean;
  inferiorStopWaiters: Set<() => void>;
  executionGeneration: number;
  threadInfoVerificationPending: boolean;
  threadInfoVerificationAgain: boolean;
  interruptPending: boolean;
  recentRecordsTruncated: boolean;
}

const gdbConsoleUnavailable = (): AnalysisInputError =>
  new AnalysisInputError("gdb_console", undefined, [
    {
      path: ["session_id"],
      reason: "invalid_value",
      message: "GDB session is unavailable or closed.",
    },
  ]);

const gdbCloseUnavailable = (): AnalysisInputError =>
  new AnalysisInputError("close_gdb_session");

/** Owns persistent GDB/MI sessions independently from the active binary target. */
export class GdbSessionManager {
  readonly #sessions = new Map<string, GdbSession>();
  readonly #activeStarts = new Map<
    AbortController,
    Promise<
      Result<
        { readonly session_id: string; readonly mi_version: "mi3" | "mi2" },
        AnalysisError
      >
    >
  >();
  readonly #command: string;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #commandDeadline: DebuggerAdmissionLimit;
  readonly #commandTimeoutMs: number;
  readonly #startupTimeoutMs: number;
  readonly #platform: NodeJS.Platform;
  readonly #stopProcess: typeof stopOwnedDebuggerProcess;
  readonly #spawnProcess: typeof spawnOwnedProviderProcess;
  readonly #verifyInferiorOutputSink: (
    pid: string,
    selectedTty: string,
    rememberIdentity: (identity: OwnedInferiorIdentity) => void,
  ) => Promise<InferiorInputSink>;
  readonly #readInferiorProcessStartTime: ProcessStartTimeReader | undefined;
  readonly #maxSessions: DebuggerAdmissionLimit;
  readonly #maxPendingCommands: DebuggerAdmissionLimit;
  readonly #commandOutput: DebuggerAdmissionLimit;
  readonly #maxCommandOutputBytes: number;
  readonly #controlReplyBytes: number;
  #sessionReservations = 0;
  #closing = false;
  #closePromise: Promise<void> | undefined;

  constructor(
    options: {
      readonly environment?: Readonly<NodeJS.ProcessEnv>;
      /** @internal Test seam. Production uses REA_DEBUGGER_COMMAND_DEADLINE_MS. */
      readonly commandTimeoutMs?: number;
      readonly startupTimeoutMs?: number;
      readonly platform?: NodeJS.Platform;
      readonly stopProcess?: typeof stopOwnedDebuggerProcess;
      readonly spawnProcess?: typeof spawnOwnedProviderProcess;
      /** @internal Tests may replace only the /proc and TTY readback boundary. */
      readonly verifyInferiorOutputSink?: (
        pid: string,
        selectedTty: string,
        rememberIdentity: (identity: OwnedInferiorIdentity) => void,
      ) => Promise<InferiorInputSink>;
      /** @internal Read-only process identity observer for lifecycle tests. */
      readonly readInferiorProcessStartTime?: ProcessStartTimeReader;
      /** @internal Test seam. Production uses REA_DEBUGGER_MAX_SESSIONS. */
      readonly maxSessions?: number;
      /** @internal Test seam. Production uses REA_DEBUGGER_MAX_PENDING_COMMANDS. */
      readonly maxPendingCommands?: number;
      /** @internal Test seam. Production uses REA_DEBUGGER_MAX_COMMAND_OUTPUT_BYTES. */
      readonly maxCommandOutputBytes?: number;
      /**
       * @internal Test seam for startup and detach MI truncation.
       * Production uses the fixed control-reply budget.
       */
      readonly controlReplyBytes?: number;
    } = {},
  ) {
    this.#environment = { ...(options.environment ?? process.env) };
    this.#command = this.#environment.REA_GDB_COMMAND ?? "gdb";
    const limits = resolveDebuggerSessionLimits(this.#environment);
    this.#commandDeadline = applyDebuggerAdmissionOverride(
      limits.commandDeadline,
      options.commandTimeoutMs,
    );
    this.#commandTimeoutMs = this.#commandDeadline.value;
    this.#startupTimeoutMs = options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
    this.#platform = options.platform ?? process.platform;
    this.#stopProcess = options.stopProcess ?? stopOwnedDebuggerProcess;
    this.#spawnProcess = options.spawnProcess ?? spawnOwnedProviderProcess;
    this.#verifyInferiorOutputSink =
      options.verifyInferiorOutputSink ?? verifyGdbInferiorOutputSink;
    this.#readInferiorProcessStartTime = options.readInferiorProcessStartTime;
    this.#maxSessions = applyDebuggerAdmissionOverride(
      limits.maxSessions,
      options.maxSessions,
    );
    this.#maxPendingCommands = applyDebuggerAdmissionOverride(
      limits.maxPendingCommands,
      options.maxPendingCommands,
    );
    this.#commandOutput = applyDebuggerAdmissionOverride(
      limits.maxCommandOutputBytes,
      options.maxCommandOutputBytes,
    );
    this.#maxCommandOutputBytes = this.#commandOutput.value;
    this.#controlReplyBytes =
      options.controlReplyBytes ?? DEBUGGER_CONTROL_REPLY_BYTES;
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
    if (this.#closing || signal?.aborted)
      return err(
        signal?.aborted
          ? cancelledWithCallerReason("start_gdb_session", signal)
          : new AnalysisCancelledError("start_gdb_session"),
      );
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
    const controller = new AbortController();
    let callerAbortWon = false;
    const relayAbort = (): void => {
      if (controller.signal.aborted) return;
      callerAbortWon = true;
      controller.abort(signal?.reason);
    };
    signal?.addEventListener("abort", relayAbort, { once: true });
    if (signal?.aborted) relayAbort();
    const tracked = Promise.resolve()
      .then(() => this.#startWithReservation(controller.signal, options))
      .finally(() => {
        signal?.removeEventListener("abort", relayAbort);
        this.#activeStarts.delete(controller);
      });
    this.#activeStarts.set(controller, tracked);
    return tracked.then((result) =>
      !result.ok &&
      result.error instanceof AnalysisCancelledError &&
      callerAbortWon &&
      signal !== undefined
        ? err(
            cancelledWithCallerReason(
              "start_gdb_session",
              signal,
              result.error,
            ),
          )
        : result,
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
    if (signal?.aborted)
      return err(
        new AnalysisCancelledError("start_gdb_session", {
          cause: signal.reason,
        }),
      );
    const occupied = this.#sessions.size + this.#sessionReservations;
    if (occupied >= this.#maxSessions.value)
      return err(
        debuggerResourceConstraintError(
          "start_gdb_session",
          "memory",
          `GDB session capacity reached (${String(this.#maxSessions.value)} sessions).`,
          "Close a GDB session before starting another.",
          this.#maxSessions,          {
            max_sessions: this.#maxSessions.value,
            active_or_reserved_sessions: occupied,
          },
        ),
      );
    this.#sessionReservations += 1;
    let reservationHeld = true;
    const releaseReservation = (): void => {
      if (!reservationHeld) return;
      reservationHeld = false;
      this.#sessionReservations -= 1;
    };
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
    if (
      mi3.ok ||
      signal.aborted ||
      this.#sessions.has(id) ||
      mi3.error instanceof GdbExecutableRefusal ||
      mi3.error instanceof AnalysisTimeoutError
    )
      return mi3;
    const mi2 = await this.#startProtocol(
      id,
      "mi2",
      releaseReservation,
      signal,
      options.inferiorTty,
    );
    if (mi2.ok || mi2.error.cleanupIncomplete) return mi2;
    // Both attempts were observed: keep the preferred protocol's failure and
    // partial startup Evidence as context instead of discarding them.
    if (mi3.error.partialObservation !== undefined)
      mi2.error.retainPartialObservation(mi3.error.partialObservation);
    return err(
      mi2.error.retainSecondaryFailure(mi3.error, {
        mi3_startup_error: projectAnalysisError(mi3.error),
      }),
    );  }

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
    const callerRunId = Object.hasOwn(this.#environment, "REA_PROCESS_RUN_ID")
      ? this.#environment.REA_PROCESS_RUN_ID
      : undefined;
    if (
      callerRunId !== undefined &&
      (/[\r\n]/u.test(callerRunId) || /^\s|\s$/u.test(callerRunId))
    ) {      releaseReservation();
      return err(
        new AnalysisCapabilityUnavailableError(
          "gdb",
          "start_gdb_session",
          "The caller's REA_PROCESS_RUN_ID contains a line break or boundary whitespace and cannot be preserved for the inferior.",        ),
      );
    }
    try {
      const spawnOptions: OwnedProviderProcessSpawnOptions = {
        command: this.#command,
        arguments: [
          "--nx",
          "--quiet",
          `--interpreter=${miVersion}`,
          // GDB inherits REA's ownership token; the inferior must see the
          // caller's value (or none) so a later sweep cannot mistake it for an
          // owned process. Applied before any inferior exists, so no MI request.
          "-iex",
          callerRunId === undefined
            ? "unset environment REA_PROCESS_RUN_ID"
            : `set environment REA_PROCESS_RUN_ID =${callerRunId}`,        ],
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
        return err(new AnalysisCancelledError("start_gdb_session", { cause }));
      const code: unknown =
        cause instanceof Error && "code" in cause ? cause.code : undefined;
      if (
        cause instanceof Error &&
        typeof code === "string" &&
        ["ENOENT", "EACCES", "EPERM", "ENOEXEC", "ENOTDIR", "EISDIR"].includes(
          code,
        )
      )
        return err(new GdbExecutableRefusal(this.#command, code, cause));
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
      launched,
      supervisor,
      detachInferior: () => this.#detachInferior(session),
      inferiorStateUnknown: () => !session.noInferiorVerified,
      verifyInferiorsEndedAfterExit: async () => {
        if (!(await this.#waitForStdoutSettlement(session))) return false;
        await Promise.all(session.inferiorIdentityCaptures);
        if (
          session.inferiorIdentityCaptureFailed ||
          session.inferiorIdentityCaptureUntrusted
        )
          return false;
        const ended = await verifyOwnedInferiorsEnded(
          session.knownInferiorIdentities.values(),
          this.#readInferiorProcessStartTime,
        );
        if (ended) {
          this.#clearInferiorIdentities(session);
          session.noInferiorVerified = true;
          this.#confirmInferiorStopped(session);
        }
        return ended;
      },
      knownInferiorIdentities: new Map(),
      knownInferiorGroupIds: new Set(),
      inferiorIdentityCaptureGenerations: new Map(),
      inferiorIdentityCaptures: new Set(),
      nextInferiorIdentityCaptureGeneration: 0,
      inferiorIdentityCaptureFailed: false,
      inferiorIdentityCaptureUntrusted: false,
      inferiorTty,
      maxCommandOutputBytes: this.#maxCommandOutputBytes,
      controlReplyBytes: this.#controlReplyBytes,
      stdoutSettled,
      settleStdout,
      inferiorTtyVerified: false,
      // GDB is launched with --nx and receives no target-execution commands
      // during startup, so no inferior can exist until execute() is called.
      noInferiorVerified: true,
      cleanupStarted: false,
      stopAttempt: undefined,
      pending: new Map(),
      cleanupFailures: new Set(),
      lines: [],
      bufferChunks: [],
      bufferTail: undefined,
      bufferTailBytes: 0,
      bufferBytes: 0,
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
      commandAbandoned: undefined,
      abandonedToken: undefined,
      inferiorRunning: false,
      inferiorDispositionConfirmed: false,
      inferiorStopWaiters: new Set(),
      executionGeneration: 0,
      threadInfoVerificationPending: false,
      threadInfoVerificationAgain: false,
      interruptPending: false,
      recentRecordsTruncated: false,
    };
    launched.process.stdout?.on("data", (chunk: string | Buffer) =>
      this.#receive(
        session,
        typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk,
      ),
    );
    launched.process.stdout?.on("error", (cause: Error) =>
      this.#failProtocol(session, `GDB stdout stream failed: ${cause.message}`),
    );
    if (launched.process.stdout === null) settleStdout();
    else launched.process.stdout.once("end", settleStdout);
    launched.process.stdin?.on("error", (cause: Error) =>
      this.#failProtocol(session, `GDB stdin stream failed: ${cause.message}`),
    );
    launched.process.stdin?.once("close", () =>
      this.#failProtocol(session, "GDB stdin stream closed unexpectedly."),
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
          reject(
            new AnalysisCancelledError("start_gdb_session", {
              cause: signal?.reason,
            }),
          );
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
                },
              ),
            ),
          this.#startupTimeoutMs,
        );
        startupTimer.unref();
      });
      if (signal?.aborted)
        throw new AnalysisCancelledError("start_gdb_session", {
          cause: signal.reason,
        });
      const autoLoad = await this.#request(
        session,
        "-gdb-set auto-load off",
        signal,
        "start_gdb_session",
      );
      if (!/^\d+\^done(?:,|$)/u.test(autoLoad.mi)) {
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
          !/^\d+\^done(?:,|$)/u.test(configured.mi)
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
          !/^\d+\^done(?:,|$)/u.test(observed.mi) ||
          reportedTty !== inferiorTty
        )
          throw new AnalysisCapabilityUnavailableError(
            "gdb",
            "start_gdb_session",
            "GDB did not report the exact caller-selected inferior TTY after configuration.",
          );
        session.inferiorTtyVerified = true;
      }
      if (signal?.aborted)
        throw new AnalysisCancelledError("start_gdb_session", {
          cause: signal.reason,
        });
      // Give queued exit notifications a turn before publishing startup.
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (signal?.aborted)
        throw new AnalysisCancelledError("start_gdb_session", {
          cause: signal.reason,
        });
      if (session.exited || session.protocolError !== undefined)
        throw new Error(
          session.protocolError ?? "GDB exited during startup readiness.",
        );
      // Publish readiness only after every mandatory startup check completes.
      // Retained failed-start owners remain addressable for cleanup, not work.
      session.ready = true;
      // Before publication no target command can run. Once usable, the
      // inferior state is no longer inferred from startup phase.
      session.noInferiorVerified = false;
      this.#sessions.set(id, session);
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
                records: [...session.lines],
                console: session.lines
                  .filter((line) => line.startsWith("~"))
                  .join("\n"),
                target: session.lines
                  .filter((line) => line.startsWith("@"))
                  .join("\n"),
                log: session.lines
                  .filter((line) => line.startsWith("&"))
                  .join("\n"),
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
              records: [...session.lines],
              console: session.lines
                .filter((line) => line.startsWith("~"))
                .join("\n"),
              target: session.lines
                .filter((line) => line.startsWith("@"))
                .join("\n"),
              log: session.lines
                .filter((line) => line.startsWith("&"))
                .join("\n"),
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
          : createEvidence(undefined, GDB_PROVIDER_IDENTITY, {
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
      // stdout may settle before stderr; give both pipes a bounded chance to
      // deliver buffered startup diagnostics before they are snapshotted.
      if (session.exited)
        await session.supervisor.waitForOutputClose(250).catch(() => undefined);
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
        this.#sessions.set(id, session);
        releaseReservation();
        const cleanupFailure = this.#retainCleanupFailure(
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
        const details = {
          cause,
          capturedOutput,
          cleanup,
          ...(cause instanceof AnalysisTimeoutError &&
          cause.diagnostics !== undefined
            ? { diagnostics: cause.diagnostics }
            : {}),
          ...(startupEvidence === undefined
            ? {}
            : { partialObservation: startupEvidence }),
        };
        if (cause instanceof AnalysisTimeoutError)
          return err(
            retainCleanup(
              new AnalysisTimeoutError(
                cause.operation,
                cause.timeoutMs,
                details,
              ),
            ),
          );
        if (cause instanceof AnalysisCancelledError)
          return err(
            retainCleanup(new AnalysisCancelledError(cause.operation, details)),
          );
        const startupFailureMessage = gdbErrorMessage(cause);
        return err(
          retainCleanup(
            new AnalysisCapabilityUnavailableError(
              "gdb",
              "start_gdb_session",
              `GDB startup failed (${startupFailureMessage}) and its owned process could not be confirmed stopped: ${stopped.reason}`,
              details,
            ),
          ),
        );
      }
      const errorDetails = {
        cause,
        capturedOutput,
        ...(cause instanceof AnalysisTimeoutError &&
        cause.diagnostics !== undefined
          ? { diagnostics: cause.diagnostics }
          : {}),
        ...(startupEvidence === undefined
          ? {}
          : { partialObservation: startupEvidence }),
      };
      const error =
        cause instanceof AnalysisCancelledError
          ? new AnalysisCancelledError("start_gdb_session", errorDetails)
          : cause instanceof AnalysisTimeoutError
            ? new AnalysisTimeoutError(
                cause instanceof GdbCommandTimeoutError
                  ? "start_gdb_session"
                  : cause.operation,
                cause.timeoutMs,
                errorDetails,
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
                    session.protocolError,
                    errorDetails,
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
    const interrupt = isGdbInterruptCommand(command);
    if (
      this.#closing ||
      session === undefined ||
      !session.ready ||
      session.cleanupStarted ||
      session.exited ||
      session.protocolError !== undefined ||
      (session.commandAbandoned !== undefined && !interrupt)
    )
      return err(gdbConsoleUnavailable());
    if (signal?.aborted)
      return err(cancelledWithCallerReason("gdb_console", signal));
    try {
      const operation = async () => {
        if (
          this.#closing ||
          this.#sessions.get(sessionId) !== session ||
          session.cleanupStarted ||
          session.exited ||
          session.protocolError !== undefined ||
          (session.commandAbandoned !== undefined && !interrupt)
        )
          return err(gdbConsoleUnavailable());
        if (!interrupt) {
          session.noInferiorVerified = false;
          // Execution commands keep the inventory and any incomplete-capture
          // marker; MI does not replay group-start events for a resumed target.
          if (isGdbTargetIdentityBoundaryCommand(command)) {
            session.inferiorIdentityCaptureUntrusted = true;
            this.#clearInferiorIdentities(session);
          } else if (isGdbTargetDispositionCommand(command)) {
            // Keep the current inventory until the correlated disposition
            // result decides whether every known inferior was covered.
          } else if (isGdbTargetInspectionCommand(command)) {
            // Inspection and executable selection do not replace a live
            // inferior identity. Preserve ownership proof and any uncertainty
            // already recorded by an earlier target boundary.
          } else if (!isGdbExecutionCommand(command)) {
            // An unrecognized command can change targets without a structured
            // event that safely rebuilds the process identity inventory.
            this.#clearInferiorIdentities(session);
            session.inferiorIdentityCaptureFailed = true;
          }
        }
        if (commandMayChangeInferiorOutput(command))
          session.inferiorTtyVerified = false;
        try {
          const request = this.#request(
            session,
            interrupt
              ? "-exec-interrupt --all"
              : `-interpreter-exec console ${miQuote(command)}`,
            signal,
            "gdb_console",
            command,
          );
          // Console execution can block GDB's MI input loop even with mi-async.
          // Signal only the retained owned debugger handle, then await MI proof.
          if (interrupt && session.inferiorRunning && !session.exited) {
            try {
              session.launched.process.kill("SIGINT");
            } catch (cause) {
              this.#failProtocol(
                session,
                `GDB interrupt delivery failed: ${gdbErrorMessage(cause)}`,
              );
            }
          }
          const result = await request;
          if (
            isGdbTargetDispositionCommand(command) &&
            /^\d+\^done(?:,|$)/u.test(result.mi)
          ) {
            // A successful explicit kill/detach is the disposition proof that
            // a GDB process-exit notification cannot provide for a remote
            // target. Release the owner only after the correlated MI result.
            if (
              session.inferiorIdentityCaptures.size === 0 &&
              !session.inferiorIdentityCaptureFailed &&
              !session.inferiorIdentityCaptureUntrusted &&
              session.knownInferiorGroupIds.size <= 1 &&
              session.knownInferiorIdentities.size <= 1
            ) {
              session.inferiorDispositionConfirmed = true;
              this.#clearInferiorIdentities(session);
              this.#confirmInferiorStopped(session);
            }
          }
          const evidence = createEvidence(
            undefined,
            { id: "gnu.gdb", name: "GNU GDB", version: null },
            {
              predicateType: "rea.debugger.console-observation",
              operation: "gdb_console",
              parameters: {
                session_id: sessionId,
                command,
                ...(interrupt
                  ? { interrupt_delivery: "owned-debugger-sigint-and-mi" }
                  : {}),
              },
              result: {
                command,
                mi: result.mi,
                records: [...result.records],
                console: result.console,
                target: result.target,
                log: result.log,
                output_truncated: result.output_truncated,
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
                ...(result.output_truncated
                  ? [gdbRetainedOutputLimitation(this.#commandOutput)]
                  : []),
                ...(result.output_invalid_utf8
                  ? [
                      "MI stream bytes were not valid UTF-8; returned text contains replacement characters.",
                    ]
                  : []),
                "The unrestricted GDB console can access local shell, filesystem, network, and target controls.",
              ],
            },
          );
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
            const evidence = createEvidence(
              undefined,
              { id: "gnu.gdb", name: "GNU GDB", version: null },
              {
                predicateType: "rea.debugger.console-observation",
                operation: "gdb_console",
                parameters: { session_id: sessionId, command },
                result: { ...result, records: [...result.records] },
                rawResult: { ...result, records: [...result.records] },
                subjectUnavailableReason:
                  "The active GDB inferior identity is not established by the debugger session identifier.",
                limitations: [
                  "GDB exited before returning a correlated MI result record; only records retained for the active command are returned raw.",
                  ...(result.output_truncated
                    ? [gdbRetainedOutputLimitation(this.#commandOutput)]
                    : []),
                ],
              },
            );
            const stopped = await this.#stopDebuggerOnly(session);
            if (stopped.status === "incomplete")
              return err(
                this.#retainCleanupFailure(
                  session,
                  "gdb_console",
                  stopped.reason,
                  {
                    cause,
                    partialObservation: evidence,
                    ...(result.output_truncated
                      ? {
                          diagnostics: debuggerAdmissionDiagnostics(
                            this.#commandOutput,
                          ),
                        }
                      : {}),
                  },
                ),
              );
            return ok({ result, evidence });
          }
          return err(
            new AnalysisTimeoutError(
              "gdb_console",
              this.#commandDeadline.value,
              {
                cause,
                ...configurableDeadlineGuidance(
                  "The GDB MI command",
                  this.#commandDeadline,
                ),
              },
            ),
          );
        }
      };
      const completed = await (interrupt
        ? this.#interrupt(session, operation, signal)
        : this.#serialize(session, operation, signal, "gdb_console"));
      if (!completed.ok && completed.error.cleanupIncomplete)
        session.cleanupFailures.add(completed.error);
      return completed;
    } catch (cause) {
      const error =
        cause instanceof AnalysisError
          ? cause
          : new AnalysisCancelledError("gdb_console", { cause });
      if (error.cleanupIncomplete) session.cleanupFailures.add(error);
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
      }
    | undefined {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return undefined;
    const diagnostics = session.supervisor.snapshot();
    return {
      session_id: session.id,
      mi_version: session.miVersion,
      state:
        session.cleanupStarted ||
        session.exited ||
        session.protocolError !== undefined ||
        session.commandAbandoned !== undefined ||
        !session.ready
          ? "closed"
          : "ready",
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
    };
  }

  /** Resolve only after MI confirms a stop or disposition releases the target. */
  waitForInferiorStop(sessionId: string): Promise<void> {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return Promise.resolve();
    if (
      !(session.exited && !session.inferiorDispositionConfirmed) &&
      !session.inferiorRunning &&
      !session.interruptPending &&
      ![...session.pending.values()].some((pending) => pending.interrupt)
    )
      return Promise.resolve();
    return new Promise<void>((resolve) => {
      session.inferiorStopWaiters.add(resolve);
    });
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
      return err(new AnalysisCancelledError("close_gdb_session"));
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return err(gdbCloseUnavailable());
    if (session.exited) return this.#finishSessionCleanup(session);
    try {
      return await this.#serialize(
        session,
        async () => {
          // An earlier close can remove the session while close waits.
          if (this.#sessions.get(sessionId) !== session)
            return err(gdbCloseUnavailable());
          if (session.exited || session.cleanupStarted)
            return this.#finishSessionCleanup(session);
          if (
            session.abandonedToken !== undefined ||
            (session.commandAbandoned !== undefined && session.inferiorRunning)
          )
            return err(
              this.#retainCleanupFailure(
                session,
                "close_gdb_session",
                "The interrupted command has not reached a synchronized, stopped state.",
              ),
            );
          let targetState: "none_observed" | "unknown" = "unknown";
          try {
            const groups = await this.#request(
              session,
              "-list-thread-groups --recurse 1",
            );
            if (
              groups.completion_status !== "complete" ||
              groups.output_truncated ||
              !/^\d+\^done(?:,|$)/u.test(groups.mi)
            )
              throw new Error(
                "GDB could not confirm its complete, untruncated inferior list before shutdown.",
              );
            const groupCount = gdbThreadGroupCount(groups.mi);
            if (groupCount === undefined)
              throw new Error(
                "GDB returned an unknown inferior list before shutdown.",
              );
            if (
              groupCount > 1 ||
              (groupCount > 0 && !session.inferiorTtyVerified)
            )
              return err(
                new AnalysisCapabilityUnavailableError(
                  GDB_PROVIDER_IDENTITY.id,
                  "close_gdb_session",
                  "Live GDB inferiors require an explicit disposition because no durable inferior TTY is verified.",
                  {
                    retryable: true,
                    userMessage:
                      "Close requires an explicit inferior disposition.",
                    remediationAction:
                      "Use gdb_console with this session_id to explicitly detach or terminate each remaining inferior, then retry close_gdb_session.",
                  },
                ),
              );
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
              this.#retainCleanupFailure(
                session,
                "close_gdb_session",
                stopped.reason,
              ),
            );
          this.#sessions.delete(sessionId);
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
  ): Promise<
    Result<
      { readonly target_state: "none_observed" | "unknown" },
      AnalysisError
    >
  > {
    const stopped = await this.#stopDebuggerOnly(session);
    if (stopped.status === "incomplete")
      return err(
        this.#retainCleanupFailure(
          session,
          "close_gdb_session",
          stopped.reason,
        ),
      );
    if (!session.inferiorDispositionConfirmed && !session.noInferiorVerified)
      return err(
        this.#retainUnknownTargetStateFailure(session, "close_gdb_session"),
      );
    this.#sessions.delete(session.id);
    return ok({
      target_state: session.noInferiorVerified ? "none_observed" : "unknown",
    });
  }

  async retryCleanupFailures(): Promise<Result<null, AnalysisError>> {
    for (const session of this.#sessions.values()) {
      if (session.cleanupFailures.size === 0) continue;
      const stopped = await this.#stopDebuggerOnly(session);
      if (stopped.status === "incomplete")
        return err(
          [...session.cleanupFailures].at(-1) ??
            this.#retainCleanupFailure(
              session,
              "close_gdb_session",
              stopped.reason,
            ),
        );
      this.#sessions.delete(session.id);
    }
    return ok(null);
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
    const active = [...this.#activeStarts.entries()];
    for (const [controller] of active) controller.abort();
    await Promise.allSettled(active.map(([, start]) => start));
    await Promise.all(
      [...this.#sessions.values()].map((session) => session.commandTail),
    );
    await closeOwnedDebuggerSessions(
      this.#sessions,
      (session) => this.#stopDebuggerOnly(session),
      "GDB",
    );
  }

  async #interrupt<Value>(
    session: GdbSession,
    operation: () => Promise<Value>,
    signal?: AbortSignal,
  ): Promise<Value> {
    if (signal?.aborted)
      throw new AnalysisCancelledError("gdb_console", {
        cause: signal.reason,
      });
    if (!session.inferiorRunning || session.abandonedToken !== undefined)
      throw new AnalysisInputError("gdb_console", undefined, [
        {
          path: ["command"],
          reason: "invalid_value",
          message:
            "interrupt requires an observed running command with synchronized MI control.",
        },
      ]);
    if (session.interruptPending)
      throw new AnalysisResourceConstraintError(
        "gdb_console",
        "transport",
        "A GDB interrupt is already pending.",
        { max_pending_interrupts: 1 },
      );
    session.interruptPending = true;
    try {
      return await operation();
    } finally {
      session.interruptPending = false;
      this.#releaseInferiorStopWaitersIfSettled(session);
    }
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
        this.#maxPendingCommands,        {
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
    while (offset < data.byteLength) {
      const newline = data.indexOf(0x0a, offset);
      const piece = data.subarray(
        offset,
        newline < 0 ? data.byteLength : newline,
      );
      session.bufferBytes += piece.byteLength;
      const lineBytes =
        session.bufferBytes - (newline >= 0 && piece.at(-1) === 0x0d ? 1 : 0);
      if (lineBytes > MAX_MI_LINE_BYTES) {
        session.recentRecordsTruncated = true;
        for (const pending of session.pending.values())
          pending.outputTruncated = true;
        this.#failProtocol(
          session,
          `GDB emitted an MI line exceeding the ${String(MAX_MI_LINE_BYTES)} byte protocol limit.`,
        );
        return;
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
        } else pending.outputTruncated = true;
      }
      if (line === "(gdb)" || line === "(gdb) ") {
        // Shell stdout can precede its result token without a LF. Never scan
        // caller output for a token-looking suffix. Once GDB returns its prompt,
        // correlate a read-only query before completing that console turn.
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
      if (line.startsWith("*running")) {
        session.executionGeneration += 1;
        session.inferiorRunning = true;
        session.inferiorDispositionConfirmed = false;
        for (const pending of session.pending.values()) {
          if (pending.completionToken !== undefined)
            pending.awaitingInferiorStop = true;
        }
      }
      const startedInferior =
        /^=thread-group-started,id="([^"]+)"(?:,pid="(\d+)")?(?:,|$)/u.exec(
          line,
        );
      if (startedInferior !== null) {
        session.knownInferiorGroupIds.add(startedInferior[1] ?? "");
        if (startedInferior[2] !== undefined)
          this.#captureInferiorIdentity(session, startedInferior[2]);
        else session.inferiorIdentityCaptureFailed = true;
      }
      const exitedInferior = /^=thread-group-exited,id="([^"]+)"(?:,|$)/u.exec(
        line,
      );
      if (exitedInferior !== null)
        session.knownInferiorGroupIds.delete(exitedInferior[1] ?? "");
      if (line.startsWith("*stopped")) {
        const stoppedThreads =
          /(?:^|,)stopped-threads=("all"|\[[^\]]*\])(?:,|$)/u.exec(line)?.[1];
        const stoppedThreadId = /(?:^|,)thread-id="([^"]+)"(?:,|$)/u.exec(
          line,
        )?.[1];
        const inferiorExited = /(?:^|,)reason="exited(?:-[^"]+)?"(?:,|$)/u.test(
          line,
        );
        const confirmsAllThreadsStopped =
          stoppedThreads === '"all"' ||
          (stoppedThreads === undefined &&
            stoppedThreadId === undefined &&
            !inferiorExited);
        if (confirmsAllThreadsStopped) this.#confirmInferiorStopped(session);
        // A partial stop completes run/step commands in non-stop mode. Query
        // thread state because the last running thread also reports a per-thread
        // stop rather than stopped-threads="all".
        if (session.inferiorRunning) {
          this.#completeStoppedCommands(session, false);
          if (!session.threadInfoVerificationPending)
            this.#verifyNonStopThreadState(session);
          else session.threadInfoVerificationAgain = true;
          continue;
        }
        this.#completeStoppedCommands(session, true);
        continue;
      }
      const match = /^(\d+)\^(done|running|connected|error|exit)(?:,|$)/u.exec(
        line,
      );
      if (match === null) continue;
      const token = Number(match[1]);
      if (session.abandonedToken === token) {
        session.abandonedToken = undefined;
        if (match[2] === "running") {
          session.inferiorRunning = true;
          session.inferiorDispositionConfirmed = false;
        }
      }
      const pending =
        session.pending.get(token) ??
        [...session.pending.values()].find(
          (command) => command.completionToken === token,
        );
      if (pending === undefined) continue;
      if (token === pending.completionToken) {
        if (match[2] !== "done") {
          this.#failProtocol(session, "GDB command completion query failed.");
          continue;
        }
        if (pending.awaitingInferiorStop) {
          pending.completionToken = undefined;
          continue;
        }
      } else {
        pending.terminalRecord = line;
        if (match[2] === "running") {
          session.executionGeneration += 1;
          session.inferiorRunning = true;
          session.inferiorDispositionConfirmed = false;
          pending.awaitingInferiorStop = true;
          if (pending.completionToken === undefined) {
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
          if (pending.interrupt) {
            pending.interruptReplyObserved = true;
            if (pending.interruptStopObserved)
              this.#confirmInferiorStopped(session);
            if (pending.interruptStopObserved) {
              clearTimeout(pending.timer);
              session.pending.delete(token);
              pending.cleanup();
              pending.resolve({
                command: "",
                mi: line,
                ...snapshotGdbCommandRecords(pending.lines),
                output_truncated: pending.outputTruncated,
                ...(pending.outputInvalidUtf8
                  ? { output_invalid_utf8: true as const }
                  : {}),
                completion_status: "complete",
              });
            }
          }
          continue;
        }
      }
      if (pending.interrupt && match[2] === "done") {
        pending.terminalRecord = line;
        pending.interruptReplyObserved = true;
        if (!pending.interruptStopObserved) continue;
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
        output_truncated: pending.outputTruncated,
        ...(pending.outputInvalidUtf8
          ? { output_invalid_utf8: true as const }
          : {}),
        completion_status: "complete",
      });
    }
  }

  #verifyNonStopThreadState(session: GdbSession): void {
    session.threadInfoVerificationPending = true;
    const generation = session.executionGeneration;
    void this.#request(session, "-thread-info")
      .then((result) => {
        if (
          generation !== session.executionGeneration ||
          !gdbThreadInfoConfirmsAllStopped(result)
        )
          return;
        this.#confirmInferiorStopped(session);
        this.#completeStoppedCommands(session, true);
      })
      .catch(() => undefined)
      .finally(() => {
        session.threadInfoVerificationPending = false;
        const verifyAgain = session.threadInfoVerificationAgain;
        session.threadInfoVerificationAgain = false;
        if (verifyAgain && session.inferiorRunning)
          this.#verifyNonStopThreadState(session);
      });
  }

  #confirmInferiorStopped(session: GdbSession): void {
    session.inferiorRunning = false;
    session.inferiorDispositionConfirmed = true;
    this.#releaseInferiorStopWaitersIfSettled(session);
  }

  #captureInferiorIdentity(session: GdbSession, pid: string): void {
    if (session.inferiorIdentityCaptureUntrusted || pid.length === 0) {
      session.inferiorIdentityCaptureFailed = true;
      return;
    }
    const generation = ++session.nextInferiorIdentityCaptureGeneration;
    session.inferiorIdentityCaptureGenerations.set(pid, generation);
    session.knownInferiorIdentities.delete(pid);
    let capture!: Promise<void>;
    capture = (async () => {
      try {
        const startTime = await (
          this.#readInferiorProcessStartTime ?? readLinuxProcessStartTime
        )(pid);
        if (session.inferiorIdentityCaptureGenerations.get(pid) !== generation)
          return;
        if (startTime === null) session.inferiorIdentityCaptureFailed = true;
        else session.knownInferiorIdentities.set(pid, { pid, startTime });
      } catch {
        if (session.inferiorIdentityCaptureGenerations.get(pid) === generation)
          session.inferiorIdentityCaptureFailed = true;
      } finally {
        session.inferiorIdentityCaptures.delete(capture);
      }
    })();
    session.inferiorIdentityCaptures.add(capture);
  }

  #clearInferiorIdentities(session: GdbSession): void {
    session.knownInferiorIdentities.clear();
    session.knownInferiorGroupIds.clear();
    session.inferiorIdentityCaptureGenerations.clear();
  }

  #releaseInferiorStopWaitersIfSettled(session: GdbSession): void {
    if (
      session.inferiorRunning ||
      session.interruptPending ||
      [...session.pending.values()].some((pending) => pending.interrupt)
    )
      return;
    for (const resolve of session.inferiorStopWaiters) resolve();
    session.inferiorStopWaiters.clear();
  }

  #completeStoppedCommands(
    session: GdbSession,
    allThreadsStopped: boolean,
  ): void {
    for (const [token, pending] of session.pending) {
      if (pending.interrupt) {
        if (!allThreadsStopped) continue;
        pending.interruptStopObserved = true;
        if (!pending.interruptReplyObserved) continue;
      } else if (!pending.awaitingInferiorStop) {
        continue;
      } else if (pending.completionToken !== undefined) {
        pending.awaitingInferiorStop = false;
        continue;
      }
      clearTimeout(pending.timer);
      session.pending.delete(token);
      pending.cleanup();
      pending.resolve({
        command: "",
        mi: pending.terminalRecord ?? "",
        ...snapshotGdbCommandRecords(pending.lines),
        output_truncated: pending.outputTruncated,
        ...(pending.outputInvalidUtf8
          ? { output_invalid_utf8: true as const }
          : {}),
        completion_status: "complete",
      });
    }
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

  #failProtocol(session: GdbSession, message: string): void {
    if (session.exited || session.protocolError !== undefined) return;
    session.protocolError = message;
    for (const pending of session.pending.values()) {
      clearTimeout(pending.timer);
      pending.cleanup();
      const records = [...pending.lines];
      pending.reject(
        new GdbProtocolFailureError(message, {
          command: pending.evidenceCommand,
          mi: "",
          records,
          console: records.filter((line) => line.startsWith("~")).join("\n"),
          target: records.filter((line) => line.startsWith("@")).join("\n"),
          log: records.filter((line) => line.startsWith("&")).join("\n"),
          output_truncated: pending.outputTruncated,
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
        : createEvidence(undefined, GDB_PROVIDER_IDENTITY, {
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
    return new AnalysisCapabilityUnavailableError(
      "gdb",
      "gdb_console",
      stopped.status === "incomplete"
        ? `${session.protocolError} The owned process could not be confirmed stopped: ${stopped.reason}`
        : session.protocolError!,
      {
        cause,
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
    session.cleanupStarted = true;
    if (session.stopAttempt !== undefined) return session.stopAttempt;
    const attempt = Promise.resolve()
      .then(() => this.#stopProcess(session, "GDB"))
      .catch((cause: unknown) => ({
        status: "incomplete" as const,
        reason: `Owned GDB shutdown failed: ${gdbErrorMessage(cause)}`,      }))
      .then((stopped) => {
        if (stopped.status !== "incomplete") {
          // Stopping the debugger process does not prove that a remote target
          // stopped or was detached. Only preserve/release its owner when MI
          // already confirmed a stop or a disposition established no target.
          if (
            session.inferiorDispositionConfirmed ||
            session.noInferiorVerified
          )
            this.#confirmInferiorStopped(session);
          for (const failure of session.cleanupFailures)
            failure.resolveCleanup();
          session.cleanupFailures.clear();
        }
        return stopped;
      })
      .finally(() => {
        if (session.stopAttempt === attempt) session.stopAttempt = undefined;
      });
    session.stopAttempt = attempt;
    return attempt;
  }

  #retainCleanupFailure(
    session: GdbSession,
    operation: string,
    reason: string,
    options: AnalysisErrorOptions = {},
  ): AnalysisError {
    const failure = new AnalysisCapabilityUnavailableError(
      "gdb",
      operation,
      `The owned GDB process could not be confirmed stopped: ${reason}`,
      { ...options, cleanup: { reason, resources: [session.id] } },
    );
    session.cleanupFailures.add(failure);
    return failure;
  }

  #retainUnknownTargetStateFailure(
    session: GdbSession,
    operation: string,
    cause?: unknown,
  ): AnalysisError {
    const reason =
      "GDB exited without confirming that the remote target stopped or was disposed; its state remains unknown and the binary mutation owner is retained.";
    const failure = new AnalysisCapabilityUnavailableError(
      "gdb",
      operation,
      reason,
      {
        cause,
        retryable: true,
        userMessage:
          "The GDB process exited while its target state was unconfirmed. Analysis remains blocked to protect the target.",
        remediationAction:
          "Confirm target exit or disposition through a live debugger before retrying analysis. This exited session cannot verify that state automatically.",
        cleanup: { reason, resources: [session.id] },
      },
    );
    session.cleanupFailures.add(failure);
    return failure;
  }

  async #detachInferior(
    session: GdbSession,
  ): Promise<OwnedDebuggerDetachResult> {
    if (session.noInferiorVerified) return { status: "no-inferior" };
    if (session.exited)
      throw new Error("GDB exited before inferior state could be verified.");
    // A refused or incomplete read leaves the last verified identities in place:
    // otherwise a retained session could never be settled once the debugger
    // exits on its own.
    // Queue reservations have not sent MI requests and do not affect synchronization.
    if (
      session.protocolError !== undefined ||
      session.abandonedToken !== undefined ||
      (session.commandAbandoned !== undefined && session.inferiorRunning) ||
      session.pending.size > 0
    )      throw new Error(
        "GDB MI state is not synchronized; inferior state is unknown.",
      );
    const groups = await this.#request(
      session,
      "-list-thread-groups --recurse 1",
    );
    if (
      groups.completion_status !== "complete" ||
      groups.output_truncated ||
      !/^\d+\^done(?:,|$)/u.test(groups.mi)
    )
      throw new Error("GDB could not confirm its inferior state.");
    // A new MI inspection replaces the old snapshot. If it reports multiple
    // inferiors, no earlier PID can stand in for the current unknown inventory.
    this.#clearInferiorIdentities(session);
    const inferiorPids = gdbThreadGroupPids(groups.mi);
    if (inferiorPids?.length === 0) {
      this.#clearInferiorIdentities(session);
      session.noInferiorVerified = true;
      this.#confirmInferiorStopped(session);
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
      !/^\d+\^done(?:,|$)/u.test(observedTty.mi) ||
      miStringField(observedTty.mi, "inferior_tty_terminal") !==
        session.inferiorTty
    )
      throw new Error(
        "GDB no longer reports the caller-selected inferior TTY; detachment cannot be confirmed safely.",
      );
    const inputSink = await this.#verifyInferiorOutputSink(
      inferiorPids[0]!,
      session.inferiorTty!,
      (identity) =>
        session.knownInferiorIdentities.set(
          `${identity.pid}:${identity.startTime}`,
          identity,
        ),
    );
    if (inputSink !== "durable" && inputSink !== "not-inherited")
      throw new Error(
        "GDB inferior descriptor readback did not confirm an independent input sink.",
      );
    const detached = await this.#request(session, "-target-detach");
    if (
      detached.completion_status !== "complete" ||
      detached.output_truncated ||
      !/^\d+\^done(?:,|$)/u.test(detached.mi)
    )
      throw new Error("GDB did not confirm inferior detachment.");
    this.#clearInferiorIdentities(session);
    session.noInferiorVerified = true;
    session.inferiorDispositionConfirmed = true;
    this.#confirmInferiorStopped(session);
    return {
      status: "detached",
      outputSink: "durable",
      inputSink,
    };
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
          records: [...pending.lines],
          console: pending.lines
            .filter((line) => line.startsWith("~"))
            .join("\n"),
          target: pending.lines
            .filter((line) => line.startsWith("@"))
            .join("\n"),
          log: pending.lines.filter((line) => line.startsWith("&")).join("\n"),
          process_exit_observed: true,
          process_exit_code: code,
          process_exit_signal: signalCode,
          output_truncated: pending.outputTruncated,
          ...(pending.outputInvalidUtf8
            ? { output_invalid_utf8: true as const }
            : {}),
          completion_status: "unknown",
        }),
      );
    }
    session.pending.clear();
  }

  async #waitForStdoutSettlement(session: GdbSession): Promise<boolean> {
    let timer!: ReturnType<typeof setTimeout>;
    try {
      return await Promise.race([
        session.stdoutSettled.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), 1_000);
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
      this.#failProtocol(session, message);
      return Promise.reject(new Error(message));
    }
    const token = session.nextToken++;
    return new Promise<GdbCommandResult>((resolve, reject) => {
      let abortListener!: () => void;
      const cleanup = (): void => {
        signal?.removeEventListener("abort", abortListener);
      };
      let pending!: PendingCommand;
      const timer = setTimeout(() => {
        session.pending.delete(token);
        session.abandonedToken =
          pending.terminalRecord === undefined ? token : undefined;
        session.commandAbandoned =
          "A GDB MI command timed out; untagged stream output can no longer be safely correlated with later commands.";
        pending.cleanup();
        const partial: GdbCommandResult = {
          command: pending.evidenceCommand,
          mi: "",
          records: [...pending.lines],
          console: pending.lines
            .filter((line) => line.startsWith("~"))
            .join("\n"),
          target: pending.lines
            .filter((line) => line.startsWith("@"))
            .join("\n"),
          log: pending.lines.filter((line) => line.startsWith("&")).join("\n"),
          output_truncated: pending.outputTruncated,
          ...(pending.outputInvalidUtf8
            ? { output_invalid_utf8: true as const }
            : {}),
          completion_status: "unknown",
        };
        const timeout = new AnalysisTimeoutError(
          operation,
          this.#commandTimeoutMs,
          {
            cause: new Error(`GDB MI command timed out: ${command}`),
            ...configurableDeadlineGuidance(
              "The GDB MI command",
              this.#commandDeadline,
            ),
          },        );
        const evidence = createEvidence(undefined, GDB_PROVIDER_IDENTITY, {
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
            `The GDB command exceeded its ${String(this.#commandDeadline.value)} ms deadline (deadlineExpired). ${debuggerAdmissionRecovery(this.#commandDeadline)} Retained MI and stream records are partial and command completion is unknown.`,            "Cleanup of the owned GDB process was requested because output correlation could no longer be guaranteed.",
            "The unrestricted GDB console can access local shell, filesystem, network, and target controls.",
          ],
        });
        void this.#stopDebuggerOnly(session).then((stopped) => {
          if (
            stopped.status === "incomplete" &&
            operation === "start_gdb_session"
          ) {
            pending.reject(
              new AnalysisTimeoutError(operation, this.#commandTimeoutMs, {
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
                    cleanup: {
                      reason: stopped.reason,
                      resources: [session.id],
                    },
                    partialObservation: evidence,
                  },
                )
              : new GdbCommandTimeoutError(
                  partial,
                  evidence,
                  this.#commandDeadline,
                ),
          );
        });
      }, this.#commandTimeoutMs);
      pending = {
        token,
        command,
        evidenceCommand,
        interrupt: command === "-exec-interrupt --all",
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
        outputBudgetBytes: command.startsWith("-interpreter-exec console ")
          ? session.maxCommandOutputBytes
          : session.controlReplyBytes,
        outputTruncated: false,
        outputInvalidUtf8: false,
        terminalRecord: undefined,
        completionToken: undefined,
        awaitingInferiorStop: false,
        interruptReplyObserved: false,
        interruptStopObserved: false,
      };
      session.pending.set(token, pending);
      abortListener = (): void => {
        clearTimeout(pending.timer);
        const partial: GdbCommandResult = {
          command: pending.evidenceCommand,
          mi: "",
          records: [...pending.lines],
          console: pending.lines
            .filter((line) => line.startsWith("~"))
            .join("\n"),
          target: pending.lines
            .filter((line) => line.startsWith("@"))
            .join("\n"),
          log: pending.lines.filter((line) => line.startsWith("&")).join("\n"),
          output_truncated: pending.outputTruncated,
          ...(pending.outputInvalidUtf8
            ? { output_invalid_utf8: true as const }
            : {}),
          completion_status: "unknown",
        };
        const evidence = createEvidence(undefined, GDB_PROVIDER_IDENTITY, {
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
            "Shutdown of the owned GDB process was requested because output correlation could no longer be guaranteed.",
            "The unrestricted GDB console can access local shell, filesystem, network, and target controls.",
          ],
        });
        session.pending.delete(token);
        session.abandonedToken =
          pending.terminalRecord === undefined ? token : undefined;
        session.commandAbandoned =
          "A GDB MI command was cancelled; owned-session shutdown was requested because output correlation can no longer be guaranteed.";
        void this.#stopDebuggerOnly(session).then((stopped) => {
          if (stopped.status !== "incomplete") {
            pending.reject(
              new AnalysisCancelledError("gdb_console", {
                cause: signal?.reason,
                partialObservation: evidence,
              }),
            );
            return;
          }
          const cleanupFailure = this.#retainCleanupFailure(
            session,
            "gdb_console",
            stopped.reason,
          );
          pending.reject(
            new AnalysisCancelledError("gdb_console", {
              cause: signal?.reason,
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
              `GDB stdin write failed: ${cause.message}`,
            );
        },
      );
    } catch (cause) {
      this.#failProtocol(
        session,
        `GDB stdin write failed: ${cause instanceof Error ? cause.message : "unknown error"}`,
      );
    }
  }
}

const miQuote = (value: string): string =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\r", "\\r").replaceAll("\n", "\\n").replaceAll("\t", "\\t")}"`;

/** @internal Decode one unambiguous GDB MI C-string field. */
export const miStringField = (
  record: string,
  field: string,
): string | undefined => {
  const escapedField = field.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const valuePattern = `((?:\\\\.|[^"\\\\])*)`;
  const fieldPattern = new RegExp(
    `(?:^|,)${escapedField}="${valuePattern}"`,
    "gu",
  );
  const matches = [...record.matchAll(fieldPattern)];
  if (matches.length !== 1) return undefined;
  const match = new RegExp(
    `^\\d+\\^done,${escapedField}="${valuePattern}"$`,
    "u",
  ).exec(record);
  const raw = match?.[1];
  if (raw === undefined) return undefined;
  const bytes: number[] = [];
  for (let index = 0; index < raw.length;) {
    const character = raw[index]!;
    if (character !== "\\") {
      const codePoint = raw.codePointAt(index);
      if (
        codePoint === undefined ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff)
      )
        return undefined;
      const value = String.fromCodePoint(codePoint);
      bytes.push(...Buffer.from(value, "utf8"));
      index += value.length;
      continue;
    }
    const escaped = raw[++index]!;
    const simple: Readonly<Record<string, number>> = {
      a: 7,
      b: 8,
      f: 12,
      n: 10,
      r: 13,
      t: 9,
      v: 11,
      "\\": 92,
      '"': 34,
      "'": 39,
      "?": 63,
    };
    const simpleByte = simple[escaped];
    if (simpleByte !== undefined) {
      bytes.push(simpleByte);
      index += 1;
      continue;
    }
    if (escaped === "x") {
      const hex = /^[0-9a-f]+/iu.exec(raw.slice(index + 1))?.[0];
      if (hex === undefined) return undefined;
      bytes.push(Number.parseInt(hex, 16) & 0xff);
      index += hex.length;
      index += 1;
      continue;
    }
    if (/[0-7]/u.test(escaped)) {
      const octal = `${escaped}${/^[0-7]{0,2}/u.exec(raw.slice(index + 1))![0]}`;
      bytes.push(Number.parseInt(octal, 8) & 0xff);
      index += octal.length;
      continue;
    }
    return undefined;
  }
  const decoded = Buffer.from(bytes).toString("utf8");
  return Buffer.from(decoded, "utf8").equals(Buffer.from(bytes))
    ? decoded
    : undefined;
};

/**
 * @internal Console commands that cannot be audited before one-shot execution.
 * Each one either runs arbitrary text (`eval`, `pipe`), hands the command to an
 * interpreter whose language this classifier cannot read (`interpreter`,
 * `interpreter-exec`, `source`), or defines behaviour used by later commands
 * (`define`, `alias`). Wrapping a blocked command in one of them would otherwise
 * bypass the check, so the whole form is refused.
 */
const UNAUDITABLE_ONE_SHOT_COMMANDS = [
  "alias",
  "define",
  "eval",
  "interpreter",
  "interpreter-exec",
  "pipe",
  "python",
  "python-interactive",
  "shell",
  "source",
];

/** @internal Accept only complete MI thread tuples with explicit terminal states. */
export const gdbMiThreadInfoConfirmsStopped = (record: string): boolean => {
  const terminal = /^\d+\^done(?:,(.*))?$/su.exec(record);
  if (terminal?.[1] === undefined) return false;
  const fields = splitGdbMiTopLevel(terminal[1]);
  if (fields === undefined) return false;
  let threadList: string | undefined;
  let currentThreadId: string | undefined;
  for (const field of fields) {
    const separator = field.indexOf("=");
    if (separator <= 0) return false;
    const name = field.slice(0, separator);
    const value = field.slice(separator + 1);
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/u.test(name) || !isGdbMiValue(value, 0))
      return false;
    if (name === "threads") {
      if (threadList !== undefined) return false;
      threadList = value;
    } else if (name === "current-thread-id") {
      if (currentThreadId !== undefined || !/^"\d+"$/u.test(value))
        return false;
      currentThreadId = value.slice(1, -1);
    }
  }
  if (
    threadList === undefined ||
    !threadList.startsWith("[") ||
    !threadList.endsWith("]")
  )
    return false;
  const entries = splitGdbMiTopLevel(threadList.slice(1, -1));
  if (entries === undefined) return false;
  const threadIds = new Set<string>();
  const allStopped = entries.every((entry) => {
    const tuple = entry.trim();
    if (!tuple.startsWith("{") || !tuple.endsWith("}")) return false;
    const attributes = splitGdbMiTopLevel(tuple.slice(1, -1));
    if (attributes === undefined || attributes.length === 0) return false;
    let state: string | undefined;
    let id: string | undefined;
    let targetId: string | undefined;
    const names = new Set<string>();
    for (const attribute of attributes) {
      const separator = attribute.indexOf("=");
      if (separator <= 0) return false;
      const name = attribute.slice(0, separator);
      const value = attribute.slice(separator + 1);
      if (!/^[A-Za-z][A-Za-z0-9_-]*$/u.test(name) || !isGdbMiValue(value, 0))
        return false;
      if (names.has(name)) return false;
      names.add(name);
      if (name === "id") {
        if (!/^"\d+"$/u.test(value)) return false;
        id = value.slice(1, -1);
      } else if (name === "target-id") {
        if (!isGdbMiCString(value) || value === '""') return false;
        targetId = value;
      } else if (name === "state") {
        if (state !== undefined || !/^"[^"\\]*"$/u.test(value)) return false;
        state = value.slice(1, -1);
      }
    }
    if (
      id === undefined ||
      targetId === undefined ||
      state !== "stopped" ||
      threadIds.has(id)
    )
      return false;
    threadIds.add(id);
    return true;
  });
  return (
    allStopped &&
    (currentThreadId === undefined || threadIds.has(currentThreadId))
  );
};

const splitGdbMiTopLevel = (source: string): string[] | undefined => {
  if (source.length === 0) return [];
  const fields: string[] = [];
  let start = 0;
  let braces = 0;
  let brackets = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") braces += 1;
    else if (character === "}") braces -= 1;
    else if (character === "[") brackets += 1;
    else if (character === "]") brackets -= 1;
    else if (character === "," && braces === 0 && brackets === 0) {
      const field = source.slice(start, index).trim();
      if (field.length === 0) return undefined;
      fields.push(field);
      start = index + 1;
    }
    if (braces < 0 || brackets < 0) return undefined;
  }
  if (quoted || escaped || braces !== 0 || brackets !== 0) return undefined;
  const finalField = source.slice(start).trim();
  if (finalField.length === 0) return undefined;
  fields.push(finalField);
  return fields;
};

const isGdbMiValue = (value: string, depth: number): boolean => {
  if (depth > 64) return false;
  if (isGdbMiCString(value)) return true;
  if (
    (value.startsWith("{") && value.endsWith("}")) ||
    (value.startsWith("[") && value.endsWith("]"))
  ) {
    const isTuple = value.startsWith("{");
    const elements = splitGdbMiTopLevel(value.slice(1, -1));
    if (elements === undefined) return false;
    return elements.every((element) => {
      if (isTuple) {
        const separator = element.indexOf("=");
        return (
          separator > 0 &&
          /^[A-Za-z][A-Za-z0-9_-]*$/u.test(element.slice(0, separator)) &&
          isGdbMiValue(element.slice(separator + 1), depth + 1)
        );
      }
      const separator = element.indexOf("=");
      if (
        separator > 0 &&
        /^[A-Za-z][A-Za-z0-9_-]*$/u.test(element.slice(0, separator))
      )
        return isGdbMiValue(element.slice(separator + 1), depth + 1);
      return isGdbMiValue(element, depth + 1);
    });
  }
  return false;
};

const isGdbMiCString = (value: string): boolean => {
  if (value.length < 2 || value[0] !== '"' || value.at(-1) !== '"')
    return false;
  for (let index = 1; index < value.length - 1; index += 1) {
    const character = value[index];
    const codePoint = value.codePointAt(index) ?? 0;
    if (
      character === undefined ||
      character === '"' ||
      codePoint < 0x20 ||
      (codePoint >= 0x7f && codePoint <= 0x9f)
    )
      return false;
    if (codePoint > 0xffff) index += 1;
    if (character !== "\\") continue;
    const escaped = value[++index];
    if (escaped === undefined || index >= value.length - 1) return false;
    if (/^[\\"'?abfnrtv]$/u.test(escaped)) continue;
    if (/[0-7]/u.test(escaped)) {
      for (
        let count = 1;
        count < 3 && /[0-7]/u.test(value[index + 1] ?? "");
        count += 1
      )
        index += 1;
      continue;
    }
    if (escaped === "x" && /[\da-f]/iu.test(value[index + 1] ?? "")) {
      index += 1;
      while (/[\da-f]/iu.test(value[index + 1] ?? "")) index += 1;
      continue;
    }
    return false;
  }
  return true;
};

/** @internal Validate complete transport result before trusting thread state. */
export const gdbThreadInfoConfirmsAllStopped = (
  result: GdbCommandResult,
): boolean =>
  result.completion_status === "complete" &&
  !result.output_truncated &&
  !result.output_invalid_utf8 &&
  /^\d+\^done(?:,|$)/u.test(result.mi) &&
  gdbMiThreadInfoConfirmsStopped(result.mi);

// GDB resolves built-in aliases and abbreviations, so `p` is print, never
// python. Of prefixes for commands classified below, only these four
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
};/** @internal Classify commands that can invalidate the configured output sink. */
export const gdbOneShotCommandMayInvalidateDetachProof = (
  command: string,
): boolean => {
  if (commandMayChangeInferiorOutput(command)) return true;
  const firstToken = gdbCommandWord(command);
  if (
    firstToken !== undefined &&
    ((firstToken !== "s" &&
      UNAUDITABLE_ONE_SHOT_COMMANDS.some((name) =>
        name === "source"
          ? firstToken.length >= 2 &&
            firstToken !== "s" &&
            name.startsWith(firstToken)
          : name.startsWith(firstToken),
      )) ||
      // `!command` is shell's alias.
      firstToken.startsWith("!"))
  )
    return true;
  // One-shot execution cannot establish which shell/GDB context interprets
  // redirections or pipes, nor safely track multiline command definitions, nor
  // audit a command a console interpreter would re-parse. A trailing `&` can
  // leave a background child that outlives the debugger.
  return /[<>]{1,2}|&>|\||[\r\n;]|&\s*$/u.test(command);
};

/** @internal Classify commands that can invalidate the configured output sink. */
export const commandMayChangeInferiorOutput = (command: string): boolean => {
  // These complete built-in inspections cannot change output routing. Keep
  // compound commands and abbreviations under the conservative rules below.
  if (/^[ \t]*(?:show|help)[ \t]+inferior-tty[ \t]*$/iu.test(command))
    return false;
  const setting = /^\s*(?:set|with)\s+(\S+)/iu.exec(command)?.[1];
  const maySetInferiorTty =
    setting !== undefined && "inferior-tty".startsWith(setting.toLowerCase());
  const firstToken = gdbCommandWord(command);
  const mayBeTtyCommand =
    firstToken !== undefined && "tty".startsWith(firstToken);
  // `s` is GDB's built-in alias for `step`, not a `source` abbreviation.
  // Require the unambiguous `sour` prefix before treating it as source.
  const mayBeSourceCommand =
    firstToken !== undefined &&
    firstToken.length >= 2 &&
    firstToken !== "s" &&
    "source".startsWith(firstToken);
  const mayDefineAlias =
    firstToken !== undefined && "alias".startsWith(firstToken);
  const runCommand =
    firstToken !== undefined &&
    ["run", "start", "starti"].some((name) => name.startsWith(firstToken));
  const runTail = runCommand ? command.slice(firstToken.length) : "";
  // GDB passes run arguments through a shell. Scan shell syntax once so quoted
  // or escaped metacharacters in arguments and paths remain ordinary text.
  const runRedirection = runCommand
    ? classifyRunRedirection(runTail)
    : { mayChangeOutput: false };  return (
    maySetInferiorTty ||
    mayBeTtyCommand ||
    mayBeSourceCommand ||
    mayDefineAlias ||
    /\binferior-tty\b/iu.test(command) ||
    /^\s*(?:wit(?:h)?(?:\s|$)|tty(?:\s|$)|py\w*|define\b)/iu.test(command) ||
    runRedirection.mayChangeOutput  );
};

const classifyRunRedirection = (tail: string): { mayChangeOutput: boolean } => {
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let token = "";
  let tokenStart = -1;
  let tokenPlain = true;
  let previousToken: { value: string; end: number; plain: boolean } | undefined;
  const inputs: Array<{
    descriptor: string | undefined;
    target: "missing" | "path" | "close";
  }> = [];
  let awaitingInputTarget = false;
  let outputOrControl = false;
  let malformed = false;
  const finishToken = (end: number): void => {
    if (tokenStart < 0) return;
    previousToken = {
      value: token,
      end,
      plain: tokenPlain,
    };
    token = "";
    tokenStart = -1;
    tokenPlain = true;
  };

  for (let index = 0; index < tail.length; index += 1) {
    const char = tail[index]!;
    if (escaped) {
      token += char;
      escaped = false;
      continue;
    }
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      else if (char === "\\" && quote === '"') escaped = true;
      else token += char;
      continue;
    }
    if (char === "\\") {
      if (tokenStart < 0) tokenStart = index;
      tokenPlain = false;
      if (awaitingInputTarget) {
        inputs.at(-1)!.target = "path";
        awaitingInputTarget = false;
      }
      escaped = true;
      continue;
    }
    if (char === "'" || char === '"') {
      if (tokenStart < 0) tokenStart = index;
      tokenPlain = false;
      if (awaitingInputTarget) {
        inputs.at(-1)!.target = "path";
        awaitingInputTarget = false;
      }
      quote = char;
      continue;
    }
    if (/\s/u.test(char)) {
      if (char === "\r" || char === "\n") outputOrControl = true;
      finishToken(index);
      continue;
    }
    if (char === "<" || char === ">") {
      finishToken(index);
      if (char === ">") {
        outputOrControl = true;
        previousToken = undefined;
        continue;
      }
      const descriptor =
        previousToken?.end === index &&
        previousToken.plain &&
        /^\d+$/u.test(previousToken.value)
          ? /^0+$/u.test(previousToken.value)
            ? "0"
            : previousToken.value
          : undefined;
      if (tail[index + 1] === "&" && tail[index + 2] === "-") {
        inputs.push({ descriptor, target: "close" });
        index += 2;
      } else {
        const next = tail[index + 1];
        if (next === ">") {
          // POSIX `<>` opens stdin for reading and writing when no descriptor
          // is supplied. It does not redirect stdout or stderr.
          if (descriptor !== undefined && descriptor !== "0")
            outputOrControl = true;
          inputs.push({ descriptor, target: "missing" });
          index += 1;
          awaitingInputTarget = true;
          previousToken = undefined;
          continue;
        }
        if (next === "<") outputOrControl = true;
        inputs.push({ descriptor, target: "missing" });
        awaitingInputTarget = true;
      }
      previousToken = undefined;
      continue;
    }
    if (char === ";" || char === "|" || char === "&") {
      outputOrControl = true;
      previousToken = undefined;
      continue;
    }
    if (tokenStart < 0) tokenStart = index;
    if (awaitingInputTarget) {
      inputs.at(-1)!.target = "path";
      awaitingInputTarget = false;
    }
    token += char;
  }
  finishToken(tail.length);
  malformed ||= quote !== undefined || escaped;
  const inputOnly =
    !malformed &&
    !outputOrControl &&
    inputs.length > 0 &&
    inputs.every(
      ({ descriptor, target }) =>
        (descriptor === undefined || descriptor === "0") &&
        (target === "close" || target === "path"),
    );
  return {
    mayChangeOutput:
      malformed || outputOrControl || (inputs.length > 0 && !inputOnly),
  };
};

/** Await a serialized command turn, preserving the caller's cancellation reason. */
export const waitForGdbCommandTurn = (
  previous: Promise<void>,
  signal?: AbortSignal,
): Promise<void> => {
  if (signal === undefined) return previous;
  return waitForAbortable(previous, signal).then((outcome) => {
    if (outcome === ABORTED)
      throw new AnalysisCancelledError("gdb_console", { cause: signal.reason });
  });
};

const isGdbTargetInspectionCommand = (command: string): boolean =>
  /^(?:file|exec-file|symbol-file|info|show)(?:\s|$)/u.test(
    command.trimStart(),
  );

const isGdbExecutionCommand = (command: string): boolean =>
  /^(?:run|start|continue|step|next|stepi|nexti|finish|advance|until)(?:\s|$)/u.test(
    command.trimStart(),
  );

const isGdbTargetIdentityBoundaryCommand = (command: string): boolean => {
  const normalized = command.trimStart().toLowerCase();
  const commandName = /^[^\s]+/u.exec(normalized)?.[0] ?? "";
  return (
    ["target", "tar", "targ", "targe", "t"].includes(commandName) ||
    [
      "source",
      "sourc",
      "sour",
      "sou",
      "so",
      "python",
      "py",
      "define",
      "def",
      "alias",
      "ali",
      "unalias",
      "unal",
      "shell",
      "!",
      "eval",
      "eva",
      "ev",
      "with",
      "wit",
      "wi",
      "command",
      "commands",
      "comm",
      "document",
      "doc",
      "if",
      "while",
      "wh",
    ].includes(commandName)
  );
};
