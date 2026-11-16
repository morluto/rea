import {
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
} from "./analysisErrorCore.js";

/** Tool names and wording for one persistent debugger's session errors. */
export interface DebuggerSessionTools {
  readonly providerId: string;
  readonly name: string;
  readonly start: string;
  readonly close: string;
}

/** A session_id this server does not hold, unlike a retained stopped session. */
export const unknownDebuggerSessionError = (
  tools: DebuggerSessionTools,
  operation: string,
): AnalysisInputError =>
  new AnalysisInputError(
    operation,
    {
      conformsToInputContract: true,
      userMessage: `No ${tools.name} debug session has this session_id in this REA server.`,
      remediationAction: `Use a session_id that ${tools.start} returned in this server process; ${tools.close} releases a session's ID. Call ${tools.start} to begin a new session.`,
    },
    [
      {
        path: ["session_id"],
        reason: "invalid_value",
        message: `No ${tools.name} debug session has this session_id in this REA server.`,
      },
    ],
  );

/**
 * Why a retained debugger session accepts no more commands:
 * - `input-stream-failure`: the debugger's stdin closed, errored or refused a write.
 * - `output-correlation-failure`: debugger output could no longer be attributed
 *   to one command, such as an oversized or invalid record or a missing marker.
 * - `command-deadline` / `command-cancelled`: a command's deadline or caller
 *   cancellation stopped the session, because late output could not be correlated.
 * - `server-shutdown`: REA is closing every session.
 * - `close-requested`: the close tool started releasing this session.
 * - `process-exited`: the debugger process exited.
 * - `stopped`: REA stopped the session for another reason.
 */
export const DEBUGGER_SESSION_STOP_CODES = [
  "input-stream-failure",
  "output-correlation-failure",
  "command-deadline",
  "command-cancelled",
  "server-shutdown",
  "close-requested",
  "process-exited",
  "stopped",
] as const;
export type DebuggerSessionStopCode =
  (typeof DEBUGGER_SESSION_STOP_CODES)[number];

/** A stopped session's reason code and its explanation. */
export interface DebuggerSessionStop {
  readonly code: DebuggerSessionStopCode;
  readonly reason: string;
}

/**
 * Refuse a command on a retained session that stopped, naming why it stopped.
 * The code projects as `details.diagnostics.session_stop`.
 */
export const stoppedDebuggerSessionError = (
  tools: DebuggerSessionTools,
  operation: string,
  stop: DebuggerSessionStop,
): AnalysisCapabilityUnavailableError =>
  new AnalysisCapabilityUnavailableError(
    tools.providerId,
    operation,
    stop.reason,
    {
      diagnostics: { session_stop: stop.code },
      userMessage: `The ${tools.name} debug session stopped and accepts no more commands. ${stop.reason}`,
      remediationAction: `Call ${tools.close} with this session_id to release the stopped session, then call ${tools.start} to begin a new one. Earlier commands may have changed the target, so confirm their effects before repeating them.`,
    },
  );

/**
 * Why REA could not confirm an owned debugger process stopped, so it retains
 * the session for cleanup retry:
 * - `output-unsettled`: the process leader exited, but inherited output
 *   streams (or the Windows Job Object) did not settle or could not be checked.
 * - `detach-pending`: an inferior detach was still running when the debugger exited.
 * - `inferior-disposition-unverified`: the debugger exited before the inferior
 *   was detached or confirmed absent, and no owner proof shows it ended.
 * - `inferior-identity-unverified`: the inferior's process identity could not
 *   be read after the debugger exited.
 * - `windows-stop-unsafe`: stopping the debugger on Windows could also end its inferior.
 * - `detach-unsupported`: the provider has no detach capability.
 * - `detach-timeout`: detach did not complete within its fixed allowance.
 * - `detach-unconfirmed`: the provider confirmed neither no inferior nor a
 *   detach with a durable output sink.
 * - `inferior-state-unknown`: the debugger could not report a complete,
 *   synchronized inferior list.
 * - `multiple-inferiors`: automatic detach supports only one inferior.
 * - `no-durable-output-sink`: no durable inferior output sink was verified, so
 *   detaching the live inferior is refused.
 * - `inferior-tty-changed`: the debugger no longer reports the caller-selected inferior TTY.
 * - `detach-failed`: the detach request failed or was not confirmed.
 * - `process-did-not-exit`: the debugger did not exit after direct termination.
 * - `stop-failed`: the stop attempt itself failed.
 */
export const DEBUGGER_CLEANUP_INCOMPLETE_CODES = [
  "output-unsettled",
  "detach-pending",
  "inferior-disposition-unverified",
  "inferior-identity-unverified",
  "windows-stop-unsafe",
  "detach-unsupported",
  "detach-timeout",
  "detach-unconfirmed",
  "inferior-state-unknown",
  "multiple-inferiors",
  "no-durable-output-sink",
  "inferior-tty-changed",
  "detach-failed",
  "process-did-not-exit",
  "stop-failed",
] as const;
export type DebuggerCleanupIncompleteCode =
  (typeof DEBUGGER_CLEANUP_INCOMPLETE_CODES)[number];

/** A debugger stop REA could not confirm: its code and explanation. */
export interface DebuggerCleanupIncomplete {
  readonly code: DebuggerCleanupIncompleteCode;
  readonly reason: string;
}

export const RIZIN_DEBUG_SESSION_TOOLS = {
  providerId: "rizin",
  name: "Rizin",
  start: "start_rizin_debug_session",
  close: "close_rizin_debug_session",
} as const satisfies DebuggerSessionTools;

export const GDB_SESSION_TOOLS = {
  providerId: "gdb",
  name: "GDB",
  start: "start_gdb_session",
  close: "close_gdb_session",
} as const satisfies DebuggerSessionTools;
