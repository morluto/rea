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
