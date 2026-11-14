import { randomUUID } from "node:crypto";
import { isUtf8 } from "node:buffer";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
  AnalysisCapabilityUnavailableError,
} from "../domain/analysisErrorCore.js";
import type {
  AnalysisError,
  AnalysisErrorOptions,
} from "../domain/analysisErrorBase.js";
import { createEvidence, type Evidence } from "../domain/evidence.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  ProviderProcessSupervisor,
  spawnOwnedProviderProcess,
  type SpawnedOwnedProviderProcess,
} from "../process/ProviderProcess.js";
import { resolveProviderExecutable } from "../process/resolveWindowsProviderExecutable.js";
import {
  projectRadare2JsonOutput,
  projectRadare2Summary,
  projectRadare2DeliveryViews,
} from "./radare2CommandOutput.js";

const MAX_SESSIONS = 8;
const MAX_PENDING_COMMANDS = 16;
const FRAME_TIMEOUT_MS = 120_000;
const CLEANUP_COMMAND_TIMEOUT_MS = 1_000;
const STARTUP_TIMEOUT_MS = 30_000;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_QUEUED_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_QUEUED_FRAMES = 4096;
const MIN_QUEUED_FRAME_CHARGE_BYTES = 64;
const MAX_COMMAND_FRAMES = 4096;
const MAX_HISTORY_FRAMES = 64;
const MAX_RECENT_FRAME_BYTES = 16 * 1024;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const MAX_RECENT_STDERR_BYTES = 4 * 1024;
/** Cap for partial frame text retained in a failure diagnostic. */
const MAX_FAILURE_FRAME_BYTES = 4096;

export const RADARE2_SESSION_PROVIDER_IDENTITY = {
  id: "radare2.session",
  name: "Radare2 session",
  version: null,
} as const;

export interface Radare2CommandResult {
  readonly command: string;
  readonly output: string;
  readonly output_truncated: boolean;
  readonly output_invalid_utf8?: true;
  readonly completion_status: "complete" | "unknown";
  readonly command_error: boolean;
  readonly command_code: number | null;
  readonly command_logs: ReadonlyArray<{
    readonly type: string;
    readonly origin?: string;
    readonly message: string;
  }>;
  readonly parsed?: JsonValue;
  readonly summary?: ReadonlyArray<JsonValue>;
}

interface R2Pipe2Reply {
  readonly res: string;
  readonly error: boolean;
  readonly code: number | null;
  readonly logs: Radare2CommandResult["command_logs"];
}

const isReplyLog = (
  value: unknown,
): value is Radare2CommandResult["command_logs"][number] => {
  if (typeof value !== "object" || value === null) return false;
  const log = value as Record<string, unknown>;
  return (
    typeof log.type === "string" &&
    typeof log.message === "string" &&
    (log.origin === undefined || typeof log.origin === "string")
  );
};

/**
 * Parse one NUL frame as a r2pipe2 reply object.
 *
 * radare2 reports many command failures with `error:false` and the reason in
 * `logs` (for example decompiler-plugin errors), so `logs` must be preserved
 * instead of trusting the error flag alone. A reply that failed before it
 * produced output (an invalid `@` address, for example) carries the envelope
 * without `res`, so that field is optional. Returns `undefined` only when the
 * frame is not a r2pipe2 reply envelope, which callers treat as a protocol
 * failure.
 */
const parseR2Pipe2Reply = (text: string): R2Pipe2Reply | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const reply = parsed as Record<string, unknown>;
  const hasRes = typeof reply.res === "string";
  // Every observed reply shape carries `error` and `code`; requiring them keeps
  // target-produced JSON from impersonating a failed reply and hiding output.
  const isEnvelope =
    typeof reply.error === "boolean" &&
    typeof reply.code === "number" &&
    (typeof reply.value === "number" || Array.isArray(reply.logs));
  if (!hasRes && !isEnvelope) return undefined;
  return {
    res: typeof reply.res === "string" ? reply.res : "",
    error: reply.error === true,
    code:
      typeof reply.code === "number" && Number.isFinite(reply.code)
        ? reply.code
        : null,
    logs: Array.isArray(reply.logs)
      ? reply.logs.filter(isReplyLog).map((log) => ({
          type: log.type,
          message: log.message,
          ...(log.origin === undefined ? {} : { origin: log.origin }),
        }))
      : [],
  };
};

interface Radare2Frame {
  readonly text: string;
  readonly truncated: boolean;
  readonly invalidUtf8: boolean;
}

type StopOutcome =
  | { readonly status: "verified-cleanup" }
  | { readonly status: "incomplete"; readonly reason: string };

interface Radare2Session {
  readonly id: string;
  readonly launched: SpawnedOwnedProviderProcess;
  readonly supervisor: ProviderProcessSupervisor;
  readonly callerSelectedPath: string;
  readonly resolvedPath: string;
  readonly frames: Array<{
    readonly frame: Radare2Frame;
    readonly queueChargeBytes: number;
  }>;
  readonly frameWaiters: Array<{
    readonly resolve: (frame: Radare2Frame) => void;
    readonly reject: (cause: Error) => void;
  }>;
  readonly history: string[];
  historyTruncated: boolean;
  queuedFrameBytes: number;
  frameChunks: Buffer[];
  bufferedFrameBytes: number;
  ready: boolean;
  exited: boolean;
  commandTail: Promise<void>;
  protocolError: string | undefined;
  commandCaptureActive: boolean;
  discardingOversizedFrame: boolean;
  readonly cleanupFailures: Set<AnalysisError>;
  pendingCommandCount: number;
  invalidUtf8Observed: boolean;
  closing: boolean;
  stopAttempt: Promise<StopOutcome> | undefined;
}

class Radare2ProcessExitError extends Error {
  constructor(
    readonly partialOutput: string,
    readonly outputInvalidUtf8 = false,
    message = "The owned Radare2 process exited.",
  ) {
    super(message);
  }
}

class Radare2FrameTimeoutError extends Error {
  constructor() {
    super("Timed out waiting for the next Radare2 NUL frame.");
  }
}

class Radare2CommandTimeoutError extends AnalysisTimeoutError {
  constructor(
    readonly partialOutput: string,
    readonly outputInvalidUtf8 = false,
    timeoutMs = FRAME_TIMEOUT_MS,
  ) {
    super("radare2_command", timeoutMs, {
      capturedOutput: {
        stdout: partialOutput,
        stderr: "",
        truncated: false,
        ...(outputInvalidUtf8 ? { stdoutInvalidUtf8: true } : {}),
      },
    });
  }
}

interface Radare2SessionManagerOptions {
  /** @internal Test seam; production callers should use the 120 s default. */
  readonly frameTimeoutMs?: number;
  /** @internal Test seam; production callers should use the 30 s default. */
  readonly startupTimeoutMs?: number;
  /** @internal Test seam for stop-verification failures. */
  readonly stopProcess?: (session: Radare2Session) => Promise<StopOutcome>;
  /** @internal Test seam for injected provider processes. */
  readonly spawnProcess?: typeof spawnOwnedProviderProcess;
  /** @internal Test seam; production callers use the host platform. */
  readonly platform?: NodeJS.Platform;
  /** @internal Test seam for BYO executable resolution. */
  readonly resolveExecutable?: typeof resolveProviderExecutable;
}

/**
 * Owns persistent non-debugging Radare2 analysis sessions. Sessions run
 * `radare2 -N -q0` with NUL-delimited frames; no target is executed by REA
 * and no analysis is run automatically.
 */
export class Radare2SessionManager {
  readonly #sessions = new Map<string, Radare2Session>();
  #activeStarts = 0;
  #sessionReservations = 0;
  #closingAll = false;
  readonly #startDrainWaiters: Array<() => void> = [];
  readonly #environment: Readonly<NodeJS.ProcessEnv>;
  readonly #command: string;
  readonly #frameTimeoutMs: number;
  readonly #startupTimeoutMs: number;
  readonly #spawnProcess: typeof spawnOwnedProviderProcess;
  readonly #stopProcess: (session: Radare2Session) => Promise<StopOutcome>;

  constructor(
    environment: Readonly<NodeJS.ProcessEnv> = process.env,
    options: Radare2SessionManagerOptions = {},
  ) {
    this.#environment = { ...environment };
    this.#command = (options.resolveExecutable ?? resolveProviderExecutable)(
      environment.REA_R2_COMMAND ?? "radare2",
      this.#environment,
      options.platform ?? process.platform,
    );
    this.#frameTimeoutMs = options.frameTimeoutMs ?? FRAME_TIMEOUT_MS;
    this.#startupTimeoutMs = options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
    this.#spawnProcess = options.spawnProcess ?? spawnOwnedProviderProcess;
    this.#stopProcess = options.stopProcess ?? defaultStopSession;
  }

  async start(
    input: { readonly path: string },
    signal?: AbortSignal,
  ): Promise<Result<{ readonly session_id: string }, AnalysisError>> {
    if (this.#closingAll)
      return err(new AnalysisInputError("start_radare2_session"));
    const occupied = this.#sessions.size + this.#sessionReservations;
    if (occupied >= MAX_SESSIONS)
      return err(
        new AnalysisResourceConstraintError(
          "start_radare2_session",
          "memory",
          "Radare2 session capacity reached.",
          { max_sessions: MAX_SESSIONS, active_or_reserved_sessions: occupied },
        ),
      );
    this.#activeStarts += 1;
    this.#sessionReservations += 1;
    let reserved = true;
    const releaseReservation = () => {
      if (!reserved) return;
      reserved = false;
      this.#sessionReservations -= 1;
    };
    try {
      return await this.#start(input, signal, releaseReservation);
    } finally {
      releaseReservation();
      this.#activeStarts -= 1;
      if (this.#activeStarts === 0)
        for (const resolve of this.#startDrainWaiters.splice(0)) resolve();
    }
  }

  async #start(
    input: { readonly path: string },
    signal: AbortSignal | undefined,
    releaseReservation: () => void,
  ): Promise<Result<{ readonly session_id: string }, AnalysisError>> {
    if (signal?.aborted)
      return err(new AnalysisCancelledError("start_radare2_session"));
    if (input.path.length === 0)
      return err(new AnalysisInputError("start_radare2_session"));
    const id = randomUUID();
    const resolvedPath = absoluteCallerPath(input.path);
    let launched: SpawnedOwnedProviderProcess;
    try {
      launched = await this.#spawnProcess({
        command: this.#command,
        arguments: [
          "-N",
          "-q",
          "-e",
          "scr.color=0",
          "-e",
          "scr.utf8=0",
          "-0",
          resolvedPath,
        ],
        hostEnvironment: this.#environment,
        runId: id,
        stdin: "pipe",
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (cause) {
      if (signal?.aborted)
        return err(
          new AnalysisCancelledError("start_radare2_session", { cause }),
        );
      return err(
        new AnalysisCapabilityUnavailableError(
          "radare2",
          "start_radare2_session",
          cause instanceof Error ? cause.message : "Unable to start Radare2",
          { cause },
        ),
      );
    }
    const session: Radare2Session = {
      id,
      launched,
      callerSelectedPath: input.path,
      resolvedPath,
      supervisor: new ProviderProcessSupervisor(
        { process: launched.process, ownsProcessLifetime: true },
        { captureStdout: false, maxDiagnosticBytes: MAX_DIAGNOSTIC_BYTES },
      ),
      frames: [],
      frameWaiters: [],
      history: [],
      historyTruncated: false,
      queuedFrameBytes: 0,
      frameChunks: [],
      bufferedFrameBytes: 0,
      ready: false,
      exited: false,
      commandTail: Promise.resolve(),
      protocolError: undefined,
      commandCaptureActive: false,
      discardingOversizedFrame: false,
      cleanupFailures: new Set(),
      pendingCommandCount: 0,
      invalidUtf8Observed: false,
      closing: false,
      stopAttempt: undefined,
    };
    this.#sessions.set(id, session);
    releaseReservation();
    launched.process.stdout?.on("data", (chunk: Buffer | string) =>
      this.#receive(session, Buffer.from(chunk)),
    );
    launched.process.stdin?.on("error", (cause: Error) =>
      this.#failProtocol(
        session,
        `Radare2 stdin stream failed: ${cause.message}`,
      ),
    );
    launched.process.stdin?.once("close", () => {
      if (!session.exited && session.protocolError === undefined)
        this.#failProtocol(
          session,
          "Radare2 stdin stream closed unexpectedly.",
        );
    });
    launched.process.once("exit", () => {
      session.exited = true;
      // A process that exits mid-frame leaves a correlation-less tail. Report it
      // as partial output instead of dropping the only bytes that arrived. The
      // buffers stay intact so startup diagnostics can still include the tail.
      const buffered = Buffer.concat(
        session.frameChunks,
        session.bufferedFrameBytes,
      );
      const partialOutput = buffered
        .subarray(0, MAX_FAILURE_FRAME_BYTES)
        .toString("utf8");
      const partialInvalidUtf8 = buffered.length > 0 && !isUtf8(buffered);
      for (const waiter of session.frameWaiters)
        waiter.reject(
          new Radare2ProcessExitError(partialOutput, partialInvalidUtf8),
        );
      session.frameWaiters.length = 0;
    });
    try {
      await waitForFrame(session, this.#startupTimeoutMs, signal);
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (signal?.aborted)
        throw new AnalysisCancelledError("start_radare2_session");
      if (session.exited)
        throw new Radare2ProcessExitError(
          "",
          false,
          "Radare2 exited during startup.",
        );
      if (session.protocolError !== undefined)
        throw new Error(session.protocolError);
      session.ready = true;
      return ok({ session_id: id });
    } catch (cause) {
      const stopped = await this.#stopAndRetire(session);
      const capturedOutput = this.#startupCapturedOutput(session);
      if (stopped.status === "incomplete")
        return err(
          this.#retainCleanupFailure(
            session,
            "start_radare2_session",
            stopped.reason,
            { cause, capturedOutput },
          ),
        );
      if (signal?.aborted || cause instanceof AnalysisCancelledError)
        return err(
          new AnalysisCancelledError("start_radare2_session", {
            cause,
            capturedOutput,
          }),
        );
      if (session.protocolError !== undefined)
        return err(
          new AnalysisCapabilityUnavailableError(
            "radare2",
            "start_radare2_session",
            session.protocolError,
            { cause, capturedOutput },
          ),
        );
      if (cause instanceof Radare2ProcessExitError)
        return err(
          new AnalysisCapabilityUnavailableError(
            "radare2",
            "start_radare2_session",
            cause.message,
            { cause, capturedOutput },
          ),
        );
      return err(
        new AnalysisTimeoutError(
          "start_radare2_session",
          this.#startupTimeoutMs,
          {
            cause,
            capturedOutput,
          },
        ),
      );
    }
  }

  async execute(
    sessionId: string,
    command: string,
    signal?: AbortSignal,
  ): Promise<
    Result<
      { readonly result: Radare2CommandResult; readonly evidence: Evidence },
      AnalysisError
    >
  > {
    const session = this.#sessions.get(sessionId);
    if (
      session === undefined ||
      !session.ready ||
      session.exited ||
      session.protocolError !== undefined ||
      session.closing ||
      this.#closingAll
    )
      return err(new AnalysisInputError("radare2_command"));
    if (command.length === 0 || /[\r\n\u0000]/u.test(command))
      return err(new AnalysisInputError("radare2_command"));
    if (signal?.aborted)
      return err(
        new AnalysisCancelledError("radare2_command", { cause: signal.reason }),
      );
    if (session.pendingCommandCount >= MAX_PENDING_COMMANDS)
      return err(
        new AnalysisResourceConstraintError(
          "radare2_command",
          "transport",
          "Radare2 command queue capacity reached.",
          {
            max_pending_commands: MAX_PENDING_COMMANDS,
            active_or_queued_commands: session.pendingCommandCount,
          },
        ),
      );
    let release!: () => void;
    session.pendingCommandCount += 1;
    let commandSent = false;
    let acquired = false;
    const previous = session.commandTail;
    session.commandTail = new Promise<void>((resolve) => {
      // A cancelled waiter still holds the queue tail until its predecessor
      // finishes; releasing it early would let the next command overlap the
      // still-running one.
      release = () => {
        void previous.catch(() => undefined).then(() => resolve());
      };
    });
    try {
      await waitForTurn(previous, signal);
      acquired = true;
      if (signal?.aborted)
        return err(
          new AnalysisCancelledError("radare2_command", {
            cause: signal.reason,
          }),
        );
      if (
        !session.ready ||
        session.exited ||
        session.closing ||
        this.#closingAll ||
        session.protocolError !== undefined
      )
        return err(new AnalysisInputError("radare2_command"));
      if (session.frames.length > 0) {
        const message =
          "Unsolicited Radare2 frames arrived before a command; command output can no longer be safely correlated.";
        this.#failProtocol(session, message);
        return err(await this.#errorAfterProtocolFailure(session, undefined));
      }
      commandSent = true;
      const stdin = session.launched.process.stdin;
      if (
        stdin === null ||
        stdin === undefined ||
        stdin.destroyed ||
        !stdin.writable
      ) {
        this.#failProtocol(session, "Radare2 stdin stream is closed.");
      } else {
        try {
          stdin.write(
            `${JSON.stringify({ cmd: command })}\n`,
            "utf8",
            (cause?: Error | null) => {
              if (cause)
                this.#failProtocol(
                  session,
                  `Radare2 stdin write failed: ${cause.message}`,
                );
            },
          );
        } catch (cause) {
          this.#failProtocol(
            session,
            `Radare2 stdin write failed: ${cause instanceof Error ? cause.message : "unknown error"}`,
          );
        }
      }
      if (session.protocolError !== undefined)
        throw new Error(session.protocolError);
      session.commandCaptureActive = true;
      const reply = await waitForFrame(
        session,
        this.#frameTimeoutMs,
        signal,
        () =>
          new Radare2CommandTimeoutError(
            bufferedFrameText(session),
            false,
            this.#frameTimeoutMs,
          ),
      );
      if (signal?.aborted)
        throw new AnalysisCancelledError("radare2_command", {
          cause: signal.reason,
        });
      let cleanupFailure: string | undefined;
      let parsedReply: R2Pipe2Reply | undefined;
      let outputTruncated = false;
      if (reply.truncated) {
        const stopped = await this.#stopAndRetire(session);
        if (stopped.status === "incomplete") cleanupFailure = stopped.reason;
        outputTruncated = true;
      } else {
        parsedReply = parseR2Pipe2Reply(reply.text);
        if (parsedReply === undefined) {
          session.protocolError =
            "Radare2 returned a frame that is not a r2pipe2 JSON reply; the session was stopped because the protocol no longer holds.";
          const cause = new Error(session.protocolError);
          const partialEvidence = this.#commandEvidence(
            session,
            command,
            {
              command,
              output: boundedText(reply.text),
              output_truncated: false,
              completion_status: "unknown",
              command_error: false,
              command_code: null,
              command_logs: [],
            },
            [
              "The reply frame was not valid r2pipe2 JSON; retained frame text is partial and command completion is unknown.",
              "The owned Radare2 session was stopped because the protocol no longer holds.",
              "The command is unrestricted and may access local files, the shell, network, or mutate files.",
            ],
          );
          const stopped = await this.#stopAndRetire(session);
          if (stopped.status === "incomplete")
            return err(
              this.#retainCleanupFailure(
                session,
                "radare2_command",
                stopped.reason,
                { cause, partialObservation: partialEvidence },
              ),
            );
          return err(
            new AnalysisCapabilityUnavailableError(
              "radare2",
              "radare2_command",
              session.protocolError,
              { cause, partialObservation: partialEvidence },
            ),
          );
        }
      }
      const result: Radare2CommandResult = {
        command,
        output: parsedReply === undefined ? reply.text : parsedReply.res,
        output_truncated: outputTruncated,
        completion_status: outputTruncated ? "unknown" : "complete",
        command_error: parsedReply === undefined ? false : parsedReply.error,
        command_code: parsedReply === undefined ? null : parsedReply.code,
        command_logs: parsedReply === undefined ? [] : parsedReply.logs,
        ...(reply.invalidUtf8 ? { output_invalid_utf8: true as const } : {}),
        ...projectRadare2DeliveryViews(
          command,
          parsedReply === undefined ? reply.text : parsedReply.res,
        ),
      };
      const evidence = this.#commandEvidence(session, command, result, [
        "Radare2 command output is the `res` field of one r2pipe2 JSON reply, empty when the reply failed before producing output; radare2 reports many command failures with error:false and the reason in `logs`, which is preserved in command_logs.",
        ...(outputTruncated
          ? [
              `The Radare2 command exceeded the output or frame limit. Retained output is partial and command completion is unknown.${cleanupFailure === undefined ? " The owned Radare2 session was stopped." : ` The owned Radare2 session remains retained because cleanup could not be verified: ${cleanupFailure}`}`,
            ]
          : []),
        "The command is unrestricted and may access local files, the shell, network, or mutate files.",
      ]);
      if (cleanupFailure !== undefined)
        return err(
          this.#retainCleanupFailure(
            session,
            "radare2_command",
            cleanupFailure,
            {
              partialObservation: evidence,
            },
          ),
        );
      return ok({ result, evidence });
    } catch (cause) {
      if (signal?.aborted || cause instanceof AnalysisCancelledError) {
        if (!commandSent)
          return err(new AnalysisCancelledError("radare2_command", { cause }));
        session.protocolError =
          "A Radare2 command was cancelled; the owned session was stopped because command output can no longer be correlated safely.";
        const stopped = await this.#stopAndRetire(session);
        if (stopped.status === "incomplete")
          return err(
            this.#retainCleanupFailure(
              session,
              "radare2_command",
              stopped.reason,
              {
                cause: new AnalysisCancelledError("radare2_command", { cause }),
              },
            ),
          );
        return err(new AnalysisCancelledError("radare2_command", { cause }));
      }
      if (cause instanceof Radare2CommandTimeoutError) {
        session.protocolError =
          "A Radare2 command timed out; the owned session was stopped because command output can no longer be correlated safely.";
        const partialEvidence = this.#commandEvidence(
          session,
          command,
          {
            command,
            output: cause.capturedOutput?.stdout ?? "",
            output_truncated: false,
            completion_status: "unknown",
            command_error: false,
            command_code: null,
            command_logs: [],
            ...(cause.outputInvalidUtf8
              ? { output_invalid_utf8: true as const }
              : {}),
          },
          [
            "The Radare2 command timed out; collected frame output is partial and command completion is unknown.",
            "The owned Radare2 session was stopped because command output can no longer be correlated safely.",
            "The command is unrestricted and may access local files, the shell, network, or mutate files.",
          ],
        );
        const stopped = await this.#stopAndRetire(session);
        if (stopped.status === "incomplete")
          return err(
            this.#retainCleanupFailure(
              session,
              "radare2_command",
              stopped.reason,
              { cause, partialObservation: partialEvidence },
            ),
          );
        return err(
          new AnalysisTimeoutError("radare2_command", this.#frameTimeoutMs, {
            cause,
            partialObservation: partialEvidence,
          }),
        );
      }
      if (cause instanceof Radare2ProcessExitError) {
        const partialEvidence =
          cause.partialOutput.length === 0
            ? undefined
            : this.#commandEvidence(
                session,
                command,
                {
                  command,
                  output: cause.partialOutput,
                  output_truncated: false,
                  completion_status: "unknown",
                  command_error: false,
                  command_code: null,
                  command_logs: [],
                  ...(cause.outputInvalidUtf8
                    ? { output_invalid_utf8: true as const }
                    : {}),
                },
                [
                  "The owned Radare2 process exited before the r2pipe2 reply arrived; retained frame output is partial and command completion is unknown.",
                  "The command is unrestricted and may access local files, the shell, network, or mutate files.",
                ],
              );
        const stopped = await this.#stopAndRetire(session);
        if (stopped.status === "incomplete")
          return err(
            this.#retainCleanupFailure(
              session,
              "radare2_command",
              stopped.reason,
              {
                cause,
                ...(partialEvidence === undefined
                  ? {}
                  : { partialObservation: partialEvidence }),
              },
            ),
          );
        return err(
          new AnalysisCapabilityUnavailableError(
            "radare2",
            "radare2_command",
            "The owned Radare2 process exited before the command completed.",
            {
              cause,
              ...(cause.partialOutput.length === 0
                ? {}
                : {
                    capturedOutput: {
                      stdout: cause.partialOutput,
                      stderr: "",
                      truncated: false,
                      ...(cause.outputInvalidUtf8
                        ? { stdoutInvalidUtf8: true }
                        : {}),
                    },
                  }),
              ...(partialEvidence === undefined
                ? {}
                : { partialObservation: partialEvidence }),
            },
          ),
        );
      }
      return err(await this.#errorAfterProtocolFailure(session, cause));
    } finally {
      // Command capture is per command, and it belongs to the command that holds
      // the turn: a queued command cancelled before its turn must not clear the
      // running command's capture state, or its oversized reply would be read as
      // unsolicited output and dropped instead of delivered as truncation.
      if (acquired) session.commandCaptureActive = false;
      // A cancelled waiter's chain node stays on the queue tail until its
      // predecessor settles, so its reservation must too: releasing the count
      // early would let repeated queue-and-cancel calls grow the chain past
      // MAX_PENDING_COMMANDS while the counter stays low.
      if (acquired) {
        session.pendingCommandCount -= 1;
        release();
      } else {
        void previous.then(() => {
          session.pendingCommandCount -= 1;
          release();
        });
      }
    }
  }

  status(sessionId: string):
    | {
        readonly session_id: string;
        readonly state: "ready" | "closed";
        readonly caller_selected_path: string;
        readonly resolved_path: string;
        readonly recent_output: readonly string[];
        readonly recent_stderr: string;
        readonly output_invalid_utf8: boolean;
        readonly protocol_error: string | null;
      }
    | undefined {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return undefined;
    return {
      session_id: session.id,
      // A stopped, closing, or protocol-failed session accepts no commands, so
      // reporting it as ready would invite calls that can only fail.
      state:
        session.ready &&
        !session.exited &&
        !session.closing &&
        session.protocolError === undefined
          ? "ready"
          : "closed",
      caller_selected_path: session.callerSelectedPath,
      resolved_path: session.resolvedPath,
      recent_output: [...session.history],
      recent_stderr: session.supervisor
        .snapshot()
        .stderr.text.slice(0, MAX_RECENT_STDERR_BYTES),
      output_invalid_utf8: session.invalidUtf8Observed,
      protocol_error: session.protocolError ?? null,
    };
  }

  async close(
    sessionId: string,
  ): Promise<Result<{ readonly closed: true }, AnalysisError>> {
    if (this.#closingAll)
      return err(new AnalysisInputError("close_radare2_session"));
    const session = this.#sessions.get(sessionId);
    if (session === undefined)
      return err(new AnalysisInputError("close_radare2_session"));
    session.closing = true;
    const stopped = await this.#stopAndRetire(session);
    if (stopped.status === "incomplete")
      return err(
        this.#retainCleanupFailure(
          session,
          "close_radare2_session",
          stopped.reason,
        ),
      );
    return ok({ closed: true as const });
  }

  async retryCleanupFailures(): Promise<Result<null, AnalysisError>> {
    for (const session of this.#sessions.values()) {
      if (session.cleanupFailures.size === 0) continue;
      const stopped = await this.#stopAndRetire(session);
      if (stopped.status === "incomplete")
        return err(
          [...session.cleanupFailures].at(-1) ??
            this.#retainCleanupFailure(
              session,
              "close_radare2_session",
              stopped.reason,
            ),
        );
    }
    return ok(null);
  }

  async closeAll(): Promise<void> {
    this.#closingAll = true;
    if (this.#activeStarts > 0)
      await new Promise<void>((resolve) =>
        this.#startDrainWaiters.push(resolve),
      );
    const sessions = [...this.#sessions.values()];
    for (const session of sessions) session.closing = true;
    const results = await Promise.allSettled(
      sessions.map(async (session) => ({
        session,
        stopped: await this.#stopAndRetire(session),
      })),
    );
    const failures: Error[] = [];
    for (const settled of results) {
      if (settled.status === "rejected") {
        failures.push(
          settled.reason instanceof Error
            ? settled.reason
            : new Error(String(settled.reason)),
        );
        continue;
      }
      const { session, stopped } = settled.value;
      // Register the retained failure so a later retry finds this session and
      // shutdown cannot report success while an owned engine still runs. Reuse
      // an already-retained failure so repeated shutdown retries do not stack.
      if (stopped.status === "incomplete")
        failures.push(
          [...session.cleanupFailures][0] ??
            this.#retainCleanupFailure(
              session,
              "close_radare2_session",
              stopped.reason,
            ),
        );
    }
    if (failures.length > 0)
      throw new AggregateError(
        failures,
        "Owned Radare2 sessions could not be stopped.",
      );
  }

  #commandEvidence(
    session: Radare2Session,
    command: string,
    result: Radare2CommandResult,
    limitations: readonly string[],
  ): Evidence {
    return createEvidence(undefined, RADARE2_SESSION_PROVIDER_IDENTITY, {
      predicateType: "rea.reverse-engineering.command-observation",
      operation: "radare2_command",
      parameters: {
        session_id: session.id,
        command,
        caller_selected_path: session.callerSelectedPath,
        resolved_path: session.resolvedPath,
      },
      result: {
        completion_status: result.completion_status,
        output_truncated: result.output_truncated,
        command_error: result.command_error,
      },
      rawResult: {
        command: result.command,
        output: result.output,
        output_truncated: result.output_truncated,
        ...(result.output_invalid_utf8 ? { output_invalid_utf8: true } : {}),
        completion_status: result.completion_status,
        command_error: result.command_error,
        command_code: result.command_code,
        ...(result.command_logs.length === 0
          ? {}
          : {
              command_logs: result.command_logs.map((log) => ({
                ...log,
              })),
            }),
        ...(result.parsed === undefined ? {} : { parsed: result.parsed }),
        ...(result.summary === undefined
          ? {}
          : { summary: result.summary.map((entry) => entry) }),
      },
      limitations,
    });
  }

  #receive(session: Radare2Session, chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length) {
      const boundary = chunk.indexOf(0, offset);
      const end = boundary < 0 ? chunk.length : boundary;
      const nextOffset = boundary + 1;
      if (boundary >= 0 && nextOffset <= offset) {
        this.#failProtocol(
          session,
          "Radare2 frame parser failed to advance past a NUL delimiter.",
        );
        return;
      }
      const piece = chunk.subarray(offset, end);
      if (session.discardingOversizedFrame) {
        if (boundary < 0) return;
        // The bounded frame was already delivered when the limit was crossed;
        // drain the remainder of this oversized frame without delivering twice.
        session.discardingOversizedFrame = false;
        offset = nextOffset;
        continue;
      }
      if (session.bufferedFrameBytes + piece.length > MAX_FRAME_BYTES) {
        const message =
          "Radare2 emitted an NUL frame exceeding the 16 MiB protocol limit.";
        if (!session.commandCaptureActive) {
          this.#failProtocol(session, message);
          return;
        }
        session.protocolError = message;
        session.historyTruncated = true;
        const remainingBytes = MAX_FRAME_BYTES - session.bufferedFrameBytes;
        if (remainingBytes > 0) {
          session.frameChunks.push(
            Buffer.from(piece.subarray(0, remainingBytes)),
          );
          session.bufferedFrameBytes += remainingBytes;
        }
        if (boundary < 0) {
          // Deliver the bounded frame now instead of waiting for a delimiter
          // that may never arrive; the caller stops the session on truncation.
          session.discardingOversizedFrame = true;
          this.#deliverBufferedFrame(session, true);
          return;
        }
        this.#deliverBufferedFrame(session, true);
        offset = nextOffset;
        continue;
      }
      if (piece.length > 0) {
        session.frameChunks.push(Buffer.from(piece));
        session.bufferedFrameBytes += piece.length;
      }
      if (boundary < 0) return;
      this.#deliverBufferedFrame(session, false);
      offset = nextOffset;
    }
  }

  #deliverBufferedFrame(session: Radare2Session, truncated: boolean): void {
    const frameBytes = Buffer.concat(
      session.frameChunks,
      session.bufferedFrameBytes,
    );
    session.frameChunks = [];
    session.bufferedFrameBytes = 0;
    const invalidUtf8 = !isUtf8(frameBytes);
    session.invalidUtf8Observed ||= invalidUtf8;
    this.#deliverFrame(
      session,
      { text: frameBytes.toString("utf8"), truncated, invalidUtf8 },
      frameBytes.length,
    );
  }

  #deliverFrame(
    session: Radare2Session,
    frame: Radare2Frame,
    frameBytes: number,
  ): void {
    const overRecentFrameLimit =
      frameBytes > MAX_RECENT_FRAME_BYTES || frame.truncated;
    const historyFrame = overRecentFrameLimit
      ? `${frame.text.slice(0, MAX_RECENT_FRAME_BYTES)}[recent frame truncated]`
      : frame.text;
    if (overRecentFrameLimit) session.historyTruncated = true;
    session.history.push(historyFrame);
    if (session.history.length > MAX_HISTORY_FRAMES) {
      session.history.splice(0, session.history.length - MAX_HISTORY_FRAMES);
      session.historyTruncated = true;
    }
    const waiter = session.frameWaiters.shift();
    if (waiter !== undefined) {
      waiter.resolve(frame);
      return;
    }
    const queueChargeBytes = Math.max(
      frameBytes,
      MIN_QUEUED_FRAME_CHARGE_BYTES,
    );
    if (
      session.frames.length >= MAX_QUEUED_FRAMES ||
      session.queuedFrameBytes + queueChargeBytes > MAX_QUEUED_FRAME_BYTES
    ) {
      this.#failProtocol(
        session,
        "Radare2 produced unsolicited frames exceeding the bounded queue limit.",
      );
      return;
    }
    session.frames.push({ frame, queueChargeBytes });
    session.queuedFrameBytes += queueChargeBytes;
  }

  #failProtocol(session: Radare2Session, message: string): void {
    session.protocolError = message;
    session.frameChunks = [];
    session.bufferedFrameBytes = 0;
    for (const waiter of session.frameWaiters)
      waiter.reject(new Error(message));
    session.frameWaiters.length = 0;
    // An unusable session must not keep its engine running just because no
    // command is waiting: start owned cleanup immediately and retire the
    // session when the stop is verified.
    if (
      session.stopAttempt === undefined &&
      !session.closing &&
      !session.exited &&
      session.ready
    ) {
      void this.#stopSession(session).then((stopped) => {
        if (stopped.status !== "incomplete") this.#sessions.delete(session.id);
      });
    }
  }

  /** Stop one owned session and retire it once the stop is verified. */
  async #stopAndRetire(session: Radare2Session): Promise<StopOutcome> {
    const stopped = await this.#stopSession(session);
    if (stopped.status !== "incomplete") this.#sessions.delete(session.id);
    return stopped;
  }

  async #stopSession(session: Radare2Session): Promise<StopOutcome> {
    session.closing = true;
    if (session.stopAttempt !== undefined) return session.stopAttempt;
    session.stopAttempt = this.#stopProcess(session).then((result) => {
      if (result.status === "incomplete") {
        session.stopAttempt = undefined;
        return result;
      }
      // A verified stop resolves the cleanup failures this session retained;
      // callers must not stay blocked on an ownership error that no longer exists.
      for (const failure of session.cleanupFailures) failure.resolveCleanup();
      session.cleanupFailures.clear();
      return result;
    });
    return session.stopAttempt;
  }

  async #errorAfterProtocolFailure(
    session: Radare2Session,
    cause: unknown,
  ): Promise<AnalysisError> {
    const stopped = await this.#stopAndRetire(session);
    if (stopped.status === "incomplete")
      return this.#retainCleanupFailure(
        session,
        "radare2_command",
        stopped.reason,
        { cause },
      );
    return new AnalysisCapabilityUnavailableError(
      "radare2",
      "radare2_command",
      session.protocolError ?? "Radare2 session protocol failed.",
      { cause },
    );
  }

  #retainCleanupFailure(
    session: Radare2Session,
    operation: string,
    reason: string,
    options: AnalysisErrorOptions = {},
  ): AnalysisError {
    const failure = new AnalysisCapabilityUnavailableError(
      "radare2",
      operation,
      `The owned Radare2 process could not be confirmed stopped: ${reason}`,
      { ...options, cleanup: { reason, resources: [session.id] } },
    );
    session.cleanupFailures.add(failure);
    return failure;
  }

  #startupCapturedOutput(session: Radare2Session) {
    const output = session.supervisor.snapshot();
    const partialFrame =
      session.bufferedFrameBytes === 0
        ? ""
        : Buffer.concat(
            session.frameChunks,
            session.bufferedFrameBytes,
          ).toString("utf8");
    const protocolOutput = [...session.history, partialFrame]
      .filter((frame) => frame.length > 0)
      .join("\n");
    const protocolBytes = Buffer.from(protocolOutput, "utf8");
    let stdoutBytes = Math.min(protocolBytes.length, MAX_DIAGNOSTIC_BYTES);
    while (
      stdoutBytes > 0 &&
      stdoutBytes < protocolBytes.length &&
      (protocolBytes[stdoutBytes]! & 0xc0) === 0x80
    )
      stdoutBytes -= 1;
    return {
      stdout: protocolBytes.subarray(0, stdoutBytes).toString("utf8"),
      stderr: output.stderr.text,
      truncated:
        session.historyTruncated ||
        protocolBytes.length > stdoutBytes ||
        output.diagnosticTruncated === true,
    };
  }
}

const defaultStopSession = async (
  session: Radare2Session,
): Promise<StopOutcome> => {
  const stdin = session.launched.process.stdin;
  if (
    stdin !== null &&
    stdin !== undefined &&
    !stdin.destroyed &&
    stdin.writable
  ) {
    try {
      stdin.write("q\n");
    } catch {
      // The quit command is best-effort; supervision enforces the stop.
    }
  }
  if (!session.exited)
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, CLEANUP_COMMAND_TIMEOUT_MS);
      session.launched.process.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  const stopped = await session.supervisor.stop();
  return stopped.status === "incomplete"
    ? { status: "incomplete", reason: stopped.reason }
    : { status: "verified-cleanup" };
};

const waitForFrame = (
  session: Radare2Session,
  timeoutMs: number,
  signal?: AbortSignal,
  timeoutError?: () => Error,
): Promise<Radare2Frame> => {
  if (signal?.aborted)
    return Promise.reject(
      new AnalysisCancelledError("radare2_command", { cause: signal.reason }),
    );
  const queued = session.frames.shift();
  if (queued !== undefined) {
    session.queuedFrameBytes -= queued.queueChargeBytes;
    return Promise.resolve(queued.frame);
  }
  if (session.exited) return Promise.reject(new Radare2ProcessExitError(""));
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const index = session.frameWaiters.indexOf(waiter);
      if (index >= 0) session.frameWaiters.splice(index, 1);
    };
    const onAbort = (): void => {
      cleanup();
      reject(new AnalysisCancelledError("radare2_command"));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(timeoutError?.() ?? new Radare2FrameTimeoutError());
    }, timeoutMs);
    const waiter = {
      resolve: (frame: Radare2Frame): void => {
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

const waitForTurn = (
  previous: Promise<void>,
  signal?: AbortSignal,
): Promise<void> => {
  if (signal === undefined) return previous;
  if (signal.aborted)
    return Promise.reject(
      new AnalysisCancelledError("radare2_command", { cause: signal.reason }),
    );
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void =>
      reject(new AnalysisCancelledError("radare2_command"));
    signal.addEventListener("abort", onAbort, { once: true });
    void previous.then(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    });
  });
};

/** Bounded partial frame text for failure diagnostics (never unbounded). */
const boundedText = (value: string): string =>
  value.length > 4096 ? `${value.slice(0, 4096)}…` : value;

const bufferedFrameText = (session: Radare2Session): string =>
  boundedFrameBytes(session).toString("utf8");

const boundedFrameBytes = (session: Radare2Session): Buffer => {
  const bytes = Buffer.concat(session.frameChunks, session.bufferedFrameBytes);
  return bytes.length > MAX_FAILURE_FRAME_BYTES
    ? bytes.subarray(0, MAX_FAILURE_FRAME_BYTES)
    : bytes;
};
