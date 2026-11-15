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

/** Refuse a command on a retained session that stopped, naming why it stopped. */
export const stoppedDebuggerSessionError = (
  tools: DebuggerSessionTools,
  operation: string,
  reason: string,
): AnalysisCapabilityUnavailableError =>
  new AnalysisCapabilityUnavailableError(tools.providerId, operation, reason, {
    userMessage: `The ${tools.name} debug session stopped and accepts no more commands. ${reason}`,
    remediationAction: `Call ${tools.close} with this session_id to release the stopped session, then call ${tools.start} to begin a new one. Earlier commands may have changed the target, so confirm their effects before repeating them.`,
  });

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
