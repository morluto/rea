import { isUtf8 } from "node:buffer";
import {
  debuggerControlReplyOutput,
  type DebuggerAdmissionLimit,
} from "../config/debuggerSessionLimits.js";
import {
  AnalysisCancelledError,
  cancelledBy,
  carriedReason,
  isAborted,
  type CancellationReason,
} from "../domain/analysisErrorCore.js";
import { Deadline } from "../domain/deadline.js";
import type { DebuggerSessionStop } from "../domain/debuggerSessionErrors.js";
import { err, ok, type Result } from "../domain/result.js";
import { utf8HeadExcerpt } from "../domain/utf8HeadExcerpt.js";
import type { FifoQueue } from "../kernel/FifoQueue.js";
import { debuggerAdmissionRecovery } from "../process/ownedDebuggerSession.js";
import type { ProviderProcessSupervisor } from "../process/ProviderProcess.js";
import {
  MAX_COMMAND_FRAMES,
  MAX_FRAME_BYTES,
  type RizinCommandCapture,
  type RizinCommandInterruption,
  type RizinOutputLimit,
} from "./RizinDebugEvidence.js";

export const CLEANUP_COMMAND_TIMEOUT_MS = 1_000;

export interface RizinFrame {
  readonly text: string;
  readonly truncated: boolean;
  readonly invalidUtf8: boolean;
}

export interface RizinFrameSessionState {
  readonly supervisor: ProviderProcessSupervisor;
  readonly frames: FifoQueue<{
    readonly frame: RizinFrame;
    readonly queueChargeBytes: number;
  }>;
  readonly frameWaiters: Array<{
    readonly resolve: (frame: RizinFrame) => void;
    readonly reject: (cause: Error) => void;
  }>;
  invalidUtf8Observed: boolean;
  queuedFrameBytes: number;
  frameChunks: Buffer[];
  bufferedFrameBytes: number;
  exited: boolean;
  protocolError: DebuggerSessionStop | undefined;
  commandOutputDropped: boolean;
  discardingOversizedFrame: boolean;
}

export class RizinProcessExitError extends Error {
  constructor(message = "Rizin exited before completing the active command") {
    super(message);
  }
}

export class RizinFrameTimeoutError extends Error {
  constructor() {
    super("Timed out waiting for the next Rizin NUL frame");
  }
}

export const hasUnclaimedRizinFrames = (
  session: RizinFrameSessionState,
): boolean =>
  session.frames.size > 0 ||
  session.bufferedFrameBytes > 0 ||
  session.discardingOversizedFrame;

export const decodeRizinFrameBytes = (
  session: RizinFrameSessionState,
  bytes: Buffer,
  truncated: boolean,
) => {
  const invalidUtf8 = !isUtf8(bytes);
  session.invalidUtf8Observed ||= invalidUtf8;
  return {
    bytes: bytes.length,
    frame: { text: bytes.toString("utf8"), truncated, invalidUtf8 },
  };
};

/** Parse the receiver's bounded bytes once for normal, startup and interrupted reads. */
export const bufferedRizinFrame = (
  session: RizinFrameSessionState,
  truncated: boolean,
) => {
  const bytes =
    session.frameChunks.length === 1
      ? session.frameChunks[0]!
      : Buffer.concat(session.frameChunks, session.bufferedFrameBytes);
  return decodeRizinFrameBytes(session, bytes, truncated);
};

export const waitForCommandFrames = async (
  session: RizinFrameSessionState,
  marker: string,
  timeoutMs: number,
  commandOutput: DebuggerAdmissionLimit,
  signal?: AbortSignal,
): Promise<Result<RizinCommandCapture, RizinCommandInterruption>> => {
  const maxCommandOutputBytes = commandOutput.value;
  const deadline = Deadline.after(timeoutMs);
  const output: string[] = [];
  let outputBytes = 0;
  let outputInvalidUtf8 = false;
  let outputTruncated = false;
  let outputLimit: RizinOutputLimit | undefined;
  let frameCount = 0;
  const noteLimit = (limit: RizinOutputLimit): void => {
    outputTruncated = true;
    outputLimit ??= limit;
  };
  const snapshot = (): RizinCommandCapture => {
    const dropped = session.commandOutputDropped;
    const limit = outputLimit ?? (dropped ? "queued_frames" : undefined);
    return {
      output: output.join("\n"),
      outputTruncated: outputTruncated || dropped,
      outputInvalidUtf8,
      ...(limit === undefined ? {} : { outputLimit: limit }),
    };
  };
  const append = (frame: RizinFrame): boolean => {
    outputInvalidUtf8 ||= frame.invalidUtf8;
    if (frame.truncated) noteLimit("frame_bytes");
    const markerIndex = frame.text.indexOf(marker);
    const text =
      markerIndex < 0 ? frame.text : frame.text.slice(0, markerIndex);
    if (markerIndex >= 0 && text.length === 0) return true;
    const separatorBytes = output.length > 0 ? 1 : 0;
    const remaining = maxCommandOutputBytes - outputBytes - separatorBytes;
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > remaining) {
      noteLimit("command_output_bytes");
      const retained = utf8HeadExcerpt(text, remaining).text;
      if (retained.length > 0) output.push(retained);
      outputBytes = maxCommandOutputBytes;
    } else {
      output.push(text);
      outputBytes += separatorBytes + bytes;
    }
    return markerIndex >= 0;
  };
  // After dispatch, queued complete frames and the unfinished frame belong to
  // this command interval. Never publish the private completion marker or bytes
  // following it, and apply the same decoded UTF-8 budget as normal frames.
  const interrupted = () => {
    let markerSeen = false;
    while (session.frames.size > 0) {
      const queued = session.frames.shift()!;
      session.queuedFrameBytes -= queued.queueChargeBytes;
      frameCount += 1;
      if (frameCount > MAX_COMMAND_FRAMES) {
        noteLimit("command_frames");
        break;
      }
      markerSeen = append(queued.frame);
      if (markerSeen || outputTruncated) break;
    }
    if (!markerSeen && !outputTruncated && session.bufferedFrameBytes > 0)
      append(
        bufferedRizinFrame(session, session.discardingOversizedFrame).frame,
      );
    else if (session.bufferedFrameBytes > 0 && !markerSeen)
      outputTruncated = true;
    session.frameChunks = [];
    session.bufferedFrameBytes = 0;
    return snapshot();
  };
  for (;;) {
    if (session.protocolError !== undefined) {
      const capture = interrupted();
      // Capacity failures already have a bounded partial-result contract.
      // Truncation still forces debugger cleanup before that result is returned.
      if (session.commandOutputDropped) return ok(capture);
      return err({
        kind: "failed",
        cause: new Error(session.protocolError.reason),
        capture,
      });
    }
    const remaining = deadline.remainingMs();
    if (remaining <= 0)
      return err({
        kind: "timeout",
        cause: new RizinFrameTimeoutError(),
        capture: interrupted(),
      });
    let received: RizinFrame;
    try {
      received = await waitForFrame(session, remaining, signal);
    } catch (cause) {
      let drained = true;
      if (cause instanceof RizinProcessExitError) {
        // `exit` observes the leader, not its pipe lifetime. Keep the bounded
        // receiver active until the supervisor observes output closure, using
        // the same settlement interval as owned-debugger cleanup.
        drained = await session.supervisor.waitForOutputClose(
          CLEANUP_COMMAND_TIMEOUT_MS,
        );
      }
      const captured = interrupted();
      return err({
        kind:
          cause instanceof AnalysisCancelledError
            ? "cancelled"
            : cause instanceof RizinProcessExitError
              ? "exited"
              : cause instanceof RizinFrameTimeoutError
                ? "timeout"
                : "failed",
        cause,
        capture: {
          ...captured,
          outputTruncated: captured.outputTruncated || !drained,
        },
      });
    }
    frameCount += 1;
    if (frameCount > MAX_COMMAND_FRAMES) {
      session.protocolError = {
        code: "output-correlation-failure",
        reason: `Rizin emitted more than ${String(MAX_COMMAND_FRAMES)} frames for one command. This release has no runtime override. The session was stopped because output correlation is ambiguous.`,
      };
      noteLimit("command_frames");
      return ok(snapshot());
    }
    const markerSeen = append(received);
    if (outputTruncated) {
      if (outputLimit === "command_output_bytes")
        session.protocolError ??= {
          code: "output-correlation-failure",
          reason:
            commandOutput === debuggerControlReplyOutput
              ? `Rizin control readback exceeded the ${String(maxCommandOutputBytes)} byte control-reply budget. That budget is separate from REA_DEBUGGER_MAX_COMMAND_OUTPUT_BYTES and has no runtime override.`
              : `Rizin command output exceeded the ${String(maxCommandOutputBytes)} byte command limit. ${debuggerAdmissionRecovery(commandOutput)}`,
        };
      else if (outputLimit === "frame_bytes")
        session.protocolError ??= {
          code: "output-correlation-failure",
          reason: `Rizin emitted a NUL frame exceeding the ${String(MAX_FRAME_BYTES)} byte (16 MiB) protocol limit. This release has no runtime override.`,
        };
      return ok(snapshot());
    }
    if (markerSeen) return ok(snapshot());
  }
};

export const waitForFrame = (
  session: RizinFrameSessionState,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<RizinFrame> => {
  if (signal?.aborted)
    return Promise.reject(cancelledBy("rizin_debug_command", signal));
  const queued = session.frames.shift();
  if (queued !== undefined) {
    session.queuedFrameBytes -= queued.queueChargeBytes;
    return Promise.resolve(queued.frame);
  }
  if (session.exited) return Promise.reject(new RizinProcessExitError());
  return new Promise((resolve, reject) => {
    // Settlement removes all three trigger paths before resolving or rejecting.
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const index = session.frameWaiters.indexOf(waiter);
      if (index >= 0) session.frameWaiters.splice(index, 1);
    };
    const onAbort = (): void => {
      cleanup();
      reject(cancelledBy("rizin_debug_command", carriedReason(signal?.reason)));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new RizinFrameTimeoutError());
    }, timeoutMs);
    const waiter = {
      resolve: (frame: RizinFrame): void => {
        cleanup();
        resolve(frame);
      },
      reject: (cause: Error): void => {
        cleanup();
        reject(cause);
      },
    };
    session.frameWaiters.push(waiter);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
};

/** The caller's reason when it aborted, else the reason an earlier failure carried. */
export const rizinCancellationReason = (
  signal: AbortSignal | undefined,
  cause: unknown,
): CancellationReason =>
  isAborted(signal)
    ? signal
    : cause instanceof AnalysisCancelledError
      ? cause
      : carriedReason(cause);
