import type { DebuggerAdmissionLimit } from "../config/debuggerSessionLimits.js";
import { createEvidence, type Evidence } from "../domain/evidence.js";
import type { DebuggerLaunchFileObservation } from "../process/DebuggerLaunchFile.js";
import { debuggerAdmissionRecovery } from "../process/ownedDebuggerSession.js";
import { RIZIN_DEBUGGER_PROVIDER_IDENTITY } from "./RizinDebuggerProviderIdentity.js";

export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
export const MAX_QUEUED_FRAME_BYTES = 4 * 1024 * 1024;
export const MAX_QUEUED_FRAMES = 4096;
export const MAX_COMMAND_FRAMES = 4096;

export interface RizinLaunchProvenance {
  readonly caller_selected_path: string;
  readonly resolved_path: string;
}

export interface RizinDebugCommandResult {
  readonly command: string;
  readonly output: string;
  readonly output_scope: "command_and_interleaved_session_output";
  readonly output_truncated: boolean;
  readonly output_invalid_utf8?: true;
  readonly completion_status: "complete" | "unknown";
  readonly backend: string | null;
}

export type RizinOutputLimit =
  | "command_output_bytes"
  | "frame_bytes"
  | "command_frames"
  | "queued_frames";

export interface RizinCommandCapture {
  readonly output: string;
  readonly outputTruncated: boolean;
  readonly outputInvalidUtf8: boolean;
  /** Cap that first stopped this capture. Absent when output is complete. */
  readonly outputLimit?: RizinOutputLimit;
}

export interface RizinCommandInterruption {
  readonly kind: "cancelled" | "exited" | "timeout" | "failed";
  readonly cause: unknown;
  readonly capture: RizinCommandCapture;
}

export const RIZIN_SESSION_TARGET_LIMITATION =
  "The session target is the launch file hashed at session start; later debugger commands do not rebind it.";

export const RIZIN_LAUNCH_PROVENANCE_LIMITATION =
  "Launch provenance records the original and resolved startup paths; it does not establish the current target after unrestricted debugger commands.";

export const RIZIN_TERMINATED_WITHOUT_VERIFIED_DETACH_LIMITATION =
  "The owned Rizin process was terminated without a verified inferior detach because its command transport could not be resynchronized; the target may continue running and its state and output route are unknown.";

export interface RizinCommandEvidenceInput {
  readonly sessionId: string;
  readonly command: string;
  readonly result: RizinDebugCommandResult;
  readonly inferiorTty: string;
  readonly launchProvenance: RizinLaunchProvenance;
  readonly launchTarget: DebuggerLaunchFileObservation;
  readonly limitations: readonly string[];
}

export const createRizinCommandEvidence = ({
  sessionId,
  command,
  result,
  inferiorTty,
  launchProvenance,
  launchTarget,
  limitations,
}: RizinCommandEvidenceInput): Evidence =>
  createEvidence(
    {
      kind: "session",
      session_kind: "rizin",
      id: sessionId,
      target: launchTarget.identity,
    },
    RIZIN_DEBUGGER_PROVIDER_IDENTITY,
    {
      predicateType: "rea.debugger.command-observation",
      operation: "rizin_debug_command",
      parameters: {
        session_id: sessionId,
        command,
        inferior_tty: inferiorTty,
        launch_provenance: { ...launchProvenance },
      },
      result: { ...result },
      authority: "controlled-replay",
      limitations: [
        RIZIN_SESSION_TARGET_LIMITATION,
        ...(launchTarget.unobservedReason === undefined
          ? []
          : [
              `The launch file could not be hashed at session start, so the session target is unknown: ${launchTarget.unobservedReason}`,
            ]),
        ...limitations,
        ...(result.completion_status === "unknown"
          ? [
              "Interrupted output may include an incomplete completion-marker prefix; it is retained because it cannot be distinguished from command diagnostics.",
            ]
          : []),
        ...(result.output_invalid_utf8
          ? [
              "Collected command frames contained invalid UTF-8 bytes; decoded text may contain replacement characters.",
            ]
          : []),
        RIZIN_LAUNCH_PROVENANCE_LIMITATION,
      ],
    },
  );

export interface RizinCommandTimeoutEvidenceInput {
  readonly sessionId: string;
  readonly command: string;
  readonly result: RizinDebugCommandResult;
  readonly inferiorTty: string;
  readonly cleanupFailure: string | undefined;
  readonly inferiorDetachUnverified: boolean;
  readonly launchProvenance: RizinLaunchProvenance;
  readonly launchTarget: DebuggerLaunchFileObservation;
  readonly deadline: DebuggerAdmissionLimit;
}

export const rizinCommandTimeoutLimitation = (
  deadline: DebuggerAdmissionLimit,
): string =>
  `The command timed out before its completion marker at ${String(deadline.value)} ms (deadlineExpired). ${debuggerAdmissionRecovery(deadline)} Retained output is partial and completion is unknown.`;

export const createRizinCommandTimeoutEvidence = ({
  sessionId,
  command,
  result,
  inferiorTty,
  cleanupFailure,
  inferiorDetachUnverified,
  launchProvenance,
  launchTarget,
  deadline,
}: RizinCommandTimeoutEvidenceInput): Evidence =>
  createRizinCommandEvidence({
    sessionId,
    command,
    result,
    inferiorTty,
    launchProvenance,
    launchTarget,
    limitations: [
      rizinCommandTimeoutLimitation(deadline),
      ...(result.output_invalid_utf8
        ? [
            "Collected command frame bytes did not form valid UTF-8; displayed output contains replacement characters.",
          ]
        : []),
      ...(cleanupFailure !== undefined
        ? [
            `The owned debugger session remains retained because cleanup could not be verified: ${cleanupFailure}`,
          ]
        : inferiorDetachUnverified
          ? [RIZIN_TERMINATED_WITHOUT_VERIFIED_DETACH_LIMITATION]
          : [
              "The owned debugger session was stopped because output correlation could no longer be guaranteed.",
            ]),
      "The command is unrestricted and may access local files, the shell, network, or mutate the target.",
    ],
  });

export const rizinCaptureStoppedSentence = (
  limit: RizinOutputLimit | undefined,
  output: DebuggerAdmissionLimit,
  cleanupFailure: string | undefined,
  inferiorDetachUnverified: boolean,
): string => {
  const cap =
    limit === "command_frames"
      ? `the ${String(MAX_COMMAND_FRAMES)} frame command limit`
      : limit === "frame_bytes"
        ? `the ${String(MAX_FRAME_BYTES)} byte frame limit`
        : limit === "queued_frames"
          ? `the queued frame limit of ${String(MAX_QUEUED_FRAMES)} frames or ${String(MAX_QUEUED_FRAME_BYTES)} bytes`
          : limit === "command_output_bytes"
            ? `the ${String(output.value)} byte output limit`
            : "a capture limit";
  const cleanup =
    cleanupFailure !== undefined
      ? ` The owned debugger session remains retained because cleanup could not be verified: ${cleanupFailure}`
      : inferiorDetachUnverified
        ? ` ${RIZIN_TERMINATED_WITHOUT_VERIFIED_DETACH_LIMITATION}`
        : " The owned debugger session was stopped.";
  const recovery =
    limit === "command_output_bytes"
      ? ` ${debuggerAdmissionRecovery(output)}`
      : " This release has no runtime override.";
  return `The Rizin command exceeded ${cap}.${recovery} Retained output is partial and command completion is unknown.${cleanup}`;
};

export const parseRizinPtraceRows = (
  output: string,
): Array<[string, string]> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (cause) {
    throw new Error("Rizin returned malformed JSON for `olj`.", { cause });
  }
  if (!Array.isArray(parsed))
    throw new Error("Rizin `olj` response is not an array.");
  const rows: Array<[string, string]> = [];
  for (const row of parsed) {
    if (
      typeof row !== "object" ||
      row === null ||
      typeof (row as { fd?: unknown }).fd !== "number" ||
      !Number.isSafeInteger((row as { fd: number }).fd) ||
      (row as { fd: number }).fd < 0 ||
      typeof (row as { raised?: unknown }).raised !== "boolean" ||
      typeof (row as { uri?: unknown }).uri !== "string"
    )
      throw new Error(
        "Rizin `olj` response contains a malformed descriptor row.",
      );
    const uri = (row as { uri: string }).uri;
    const match = /^ptrace:\/\/(\d+)$/u.exec(uri);
    if (match !== null) {
      if ((row as { raised: boolean }).raised !== true)
        throw new Error("Rizin `olj` ptrace descriptor is not active.");
      rows.push([String((row as { fd: number }).fd), match[1]!]);
    } else if (uri.startsWith("ptrace://"))
      throw new Error("Rizin `olj` returned a malformed ptrace URI.");
  }
  return rows;
};
