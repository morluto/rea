import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisTimeoutError,
} from "../domain/analysisErrorCore.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { createEvidence, type Evidence } from "../domain/evidence.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  ProviderProcessSupervisor,
  spawnOwnedProviderProcess,
  type SpawnedOwnedProviderProcess,
} from "../process/ProviderProcess.js";
import {
  closeOwnedDebuggerSessions,
  stopOwnedDebuggerProcess,
} from "../process/ownedDebuggerSession.js";

const FRAME_TIMEOUT_MS = 120_000;
const STARTUP_TIMEOUT_MS = 30_000;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_QUEUED_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_QUEUED_FRAMES = 4096;
const MIN_QUEUED_FRAME_CHARGE_BYTES = 64;
const MAX_COMMAND_FRAMES = 4096;
const MAX_RECENT_FRAME_BYTES = 16 * 1024;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;

export const RIZIN_DEBUGGER_PROVIDER_IDENTITY = {
  id: "rizin.debugger",
  name: "Rizin debugger",
  version: null,
} as const;

interface RizinDebugSession {
  readonly id: string;
  readonly launched: SpawnedOwnedProviderProcess;
  readonly supervisor: ProviderProcessSupervisor;
  readonly frames: Array<{
    readonly frame: RizinFrame;
    readonly queueChargeBytes: number;
  }>;
  readonly frameWaiters: Array<{
    readonly resolve: (frame: RizinFrame) => void;
    readonly reject: (cause: Error) => void;
  }>;
  readonly backend: string | null;
  readonly history: string[];
  queuedFrameBytes: number;
  historyTruncated: boolean;
  buffer: Buffer;
  ready: boolean;
  exited: boolean;
  commandTail: Promise<void>;
  protocolError: string | undefined;
  commandCaptureActive: boolean;
  discardingOversizedFrame: boolean;
}

interface RizinFrame {
  readonly text: string;
  readonly truncated: boolean;
}

class RizinCommandTimeoutError extends Error {
  constructor(readonly partialOutput: string) {
    super("Timed out waiting for Rizin's command-completion marker");
  }
}

/** Owns persistent Rizin debugger processes independently from BinarySession. */
export class RizinDebugSessionManager {
  readonly #sessions = new Map<string, RizinDebugSession>();
  readonly #command: string;
  readonly #frameTimeoutMs: number;
  readonly #platform: NodeJS.Platform;

  constructor(
    environment: Readonly<NodeJS.ProcessEnv> = process.env,
    options: {
      readonly frameTimeoutMs?: number;
      readonly platform?: NodeJS.Platform;
    } = {},
  ) {
    this.#command = environment.REA_RIZIN_COMMAND ?? "rizin";
    this.#frameTimeoutMs = options.frameTimeoutMs ?? FRAME_TIMEOUT_MS;
    this.#platform = options.platform ?? process.platform;
  }

  async start(
    input: { readonly path: string; readonly backend?: string },
    signal?: AbortSignal,
  ): Promise<
    Result<
      { readonly session_id: string; readonly backend: string | null },
      AnalysisError
    >
  > {
    if (signal?.aborted)
      return err(new AnalysisCancelledError("start_rizin_debug_session"));
    if (this.#platform === "win32")
      return err(
        new AnalysisCapabilityUnavailableError(
          "rizin",
          "start_rizin_debug_session",
          "Persistent Windows Rizin debugger sessions are unavailable because the owned Job Object cleanup can terminate debugger inferiors.",
        ),
      );
    const id = randomUUID();
    const arguments_ = [
      "-N",
      "-0",
      "-d",
      ...(input.backend === undefined ? [] : ["-D", input.backend]),
      resolve(input.path),
    ];
    let launched: SpawnedOwnedProviderProcess;
    try {
      launched = await spawnOwnedProviderProcess({
        command: this.#command,
        arguments: arguments_,
        runId: id,
        stdin: "pipe",
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (cause) {
      if (signal?.aborted)
        return err(
          new AnalysisCancelledError("start_rizin_debug_session", { cause }),
        );
      return err(
        new AnalysisCapabilityUnavailableError(
          "rizin",
          "start_rizin_debug_session",
          cause instanceof Error
            ? cause.message
            : "Unable to start Rizin debugger",
        ),
      );
    }
    const session: RizinDebugSession = {
      id,
      launched,
      backend: input.backend ?? null,
      supervisor: new ProviderProcessSupervisor(
        { process: launched.process, ownsProcessLifetime: false },
        {
          captureStdout: false,
          maxDiagnosticBytes: MAX_DIAGNOSTIC_BYTES,
        },
      ),
      frames: [],
      frameWaiters: [],
      history: [],
      queuedFrameBytes: 0,
      historyTruncated: false,
      buffer: Buffer.alloc(0),
      ready: false,
      exited: false,
      commandTail: Promise.resolve(),
      protocolError: undefined,
      commandCaptureActive: false,
      discardingOversizedFrame: false,
    };
    this.#sessions.set(id, session);
    launched.process.stdout?.on("data", (chunk: Buffer | string) =>
      this.#receive(session, Buffer.from(chunk)),
    );
    launched.process.stdin?.on("error", (cause: Error) =>
      this.#failProtocol(
        session,
        `Rizin stdin stream failed: ${cause.message}`,
      ),
    );
    launched.process.stdin?.once("close", () => {
      if (!session.exited && session.protocolError === undefined)
        this.#failProtocol(session, "Rizin stdin stream closed unexpectedly.");
    });
    launched.process.once("exit", () => {
      session.exited = true;
      for (const waiter of session.frameWaiters)
        waiter.reject(
          new Error("Rizin exited before completing the NUL-framed response"),
        );
      session.frameWaiters.length = 0;
    });
    try {
      const startupFrame = await waitForFrame(
        session,
        STARTUP_TIMEOUT_MS,
        signal,
      );
      if (startupFrame.truncated)
        throw new Error("Rizin emitted an oversized startup frame");
      if (signal?.aborted)
        throw new AnalysisCancelledError("start_rizin_debug_session");
      session.ready = true;
      return ok({ session_id: id, backend: input.backend ?? null });
    } catch (cause) {
      const stopped = await stopDebuggerOnly(session);
      if (stopped.status !== "incomplete") this.#sessions.delete(id);
      if (stopped.status === "incomplete")
        return err(
          new AnalysisCapabilityUnavailableError(
            "rizin",
            "start_rizin_debug_session",
            `Rizin startup failed and its owned process could not be confirmed stopped: ${stopped.reason}`,
            { cause },
          ),
        );
      if (signal?.aborted || cause instanceof AnalysisCancelledError)
        return err(
          new AnalysisCancelledError("start_rizin_debug_session", { cause }),
        );
      if (session.protocolError !== undefined)
        return err(
          new AnalysisCapabilityUnavailableError(
            "rizin",
            "start_rizin_debug_session",
            session.protocolError,
            { cause },
          ),
        );
      return err(
        new AnalysisTimeoutError(
          "start_rizin_debug_session",
          STARTUP_TIMEOUT_MS,
          { cause },
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
      { readonly result: RizinDebugCommandResult; readonly evidence: Evidence },
      AnalysisError
    >
  > {
    const session = this.#sessions.get(sessionId);
    if (
      session === undefined ||
      !session.ready ||
      session.exited ||
      session.protocolError !== undefined
    )
      return err(new AnalysisInputError("rizin_debug_command"));
    if (signal?.aborted)
      return err(new AnalysisCancelledError("rizin_debug_command"));
    let release: (() => void) | undefined;
    let acquired = false;
    let commandSent = false;
    const previous = session.commandTail;
    session.commandTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await waitForTurn(previous, signal);
      acquired = true;
      if (signal?.aborted)
        return err(new AnalysisCancelledError("rizin_debug_command"));
      if (session.frames.length > 0) {
        const message =
          "Unsolicited Rizin frames arrived before a command; command output can no longer be safely correlated.";
        this.#failProtocol(session, message);
        return err(
          new AnalysisCapabilityUnavailableError(
            "rizin",
            "rizin_debug_command",
            message,
          ),
        );
      }
      const marker = `__REA_COMMAND_COMPLETE_${randomUUID().replaceAll("-", "")}__`;
      commandSent = true;
      const stdin = session.launched.process.stdin;
      if (
        stdin === null ||
        stdin === undefined ||
        stdin.destroyed ||
        !stdin.writable
      ) {
        this.#failProtocol(session, "Rizin stdin stream is closed.");
      } else {
        try {
          stdin.write(
            `${command}\n!echo ${marker}\n`,
            "utf8",
            (cause?: Error | null) => {
              if (cause)
                this.#failProtocol(
                  session,
                  `Rizin stdin write failed: ${cause.message}`,
                );
            },
          );
        } catch (cause) {
          this.#failProtocol(
            session,
            `Rizin stdin write failed: ${cause instanceof Error ? cause.message : "unknown error"}`,
          );
        }
      }
      if (session.protocolError !== undefined)
        throw new Error(session.protocolError);
      session.commandCaptureActive = true;
      const captured = await waitForCommandFrames(
        session,
        marker,
        this.#frameTimeoutMs,
        signal,
      );
      if (signal?.aborted)
        throw new AnalysisCancelledError("rizin_debug_command");
      if (captured.outputTruncated) {
        const stopped = await stopDebuggerOnly(session);
        if (stopped.status === "incomplete")
          return err(
            new AnalysisCapabilityUnavailableError(
              "rizin",
              "rizin_debug_command",
              `Rizin output exceeded its capture limit and the owned process could not be confirmed stopped: ${stopped.reason}`,
            ),
          );
      }
      const result = {
        command,
        output: captured.output,
        output_scope: "command_and_interleaved_session_output" as const,
        output_truncated: captured.outputTruncated,
        completion_status: captured.outputTruncated
          ? ("unknown" as const)
          : ("complete" as const),
        backend: session.backend,
      };
      const evidence = createEvidence(
        undefined,
        RIZIN_DEBUGGER_PROVIDER_IDENTITY,
        {
          predicateType: "rea.debugger.command-observation",
          operation: "rizin_debug_command",
          parameters: { session_id: sessionId, command },
          result,
          rawResult: result,
          subjectUnavailableReason:
            "The current debugger target identity is not established by the Rizin session identifier.",
          limitations: [
            "Rizin commands and debugger effects depend on the loaded IO plugin and target.",
            "Output contains all NUL frames through an explicit command-completion marker; backend output interleaved before that marker cannot be distinguished from command output.",
            ...(captured.outputTruncated
              ? [
                  "The Rizin command exceeded the output or frame limit. Retained output is partial, command completion is unknown, and the owned debugger session was stopped.",
                ]
              : []),
            "The command is unrestricted and may access local files, the shell, network, or mutate the target.",
          ],
        },
      );
      return ok({ result, evidence });
    } catch (cause) {
      if (signal?.aborted || cause instanceof AnalysisCancelledError) {
        if (!commandSent)
          return err(
            new AnalysisCancelledError("rizin_debug_command", { cause }),
          );
        session.protocolError =
          "A Rizin command was cancelled; the owned session was stopped because command output can no longer be correlated safely.";
        const stopped = await stopDebuggerOnly(session);
        if (stopped.status === "incomplete")
          return err(
            new AnalysisCapabilityUnavailableError(
              "rizin",
              "rizin_debug_command",
              `Cancellation was requested, but the owned Rizin process could not be confirmed stopped: ${stopped.reason}`,
              { cause: new AnalysisCancelledError("rizin_debug_command") },
            ),
          );
        return err(
          new AnalysisCancelledError("rizin_debug_command", { cause }),
        );
      }
      if (session.protocolError !== undefined)
        return err(await this.#stopAfterProtocolFailure(session, cause));
      if (cause instanceof RizinCommandTimeoutError) {
        session.protocolError =
          "Rizin command timed out before its completion marker; output correlation is no longer safe.";
        const stopped = await stopDebuggerOnly(session);
        if (stopped.status === "incomplete")
          return err(
            new AnalysisCapabilityUnavailableError(
              "rizin",
              "rizin_debug_command",
              `Rizin timed out and the owned process could not be confirmed stopped: ${stopped.reason}`,
              { cause },
            ),
          );
        const result: RizinDebugCommandResult = {
          command,
          output: cause.partialOutput,
          output_scope: "command_and_interleaved_session_output",
          output_truncated: true,
          completion_status: "unknown",
          backend: session.backend,
        };
        const evidence = createEvidence(
          undefined,
          RIZIN_DEBUGGER_PROVIDER_IDENTITY,
          {
            predicateType: "rea.debugger.command-observation",
            operation: "rizin_debug_command",
            parameters: { session_id: sessionId, command },
            result: { ...result },
            rawResult: { ...result },
            subjectUnavailableReason:
              "The current debugger target identity is not established by the Rizin session identifier.",
            limitations: [
              "The command timed out before its completion marker; retained output is partial and completion is unknown.",
              "The owned debugger process was stopped because output correlation could no longer be guaranteed.",
              "The command is unrestricted and may access local files, the shell, network, or mutate the target.",
            ],
          },
        );
        return ok({ result, evidence });
      }
      if (session.exited)
        return err(
          new AnalysisCapabilityUnavailableError(
            "rizin",
            "rizin_debug_command",
            "Rizin exited before returning a NUL-framed command result",
            { cause },
          ),
        );
      session.protocolError =
        "Rizin did not return the current command-completion marker; the session was stopped to prevent late output from being attributed to a later command.";
      const stopped = await stopDebuggerOnly(session);
      if (stopped.status === "incomplete")
        return err(
          new AnalysisCapabilityUnavailableError(
            "rizin",
            "rizin_debug_command",
            `Rizin command output could not be correlated and its owned process could not be confirmed stopped: ${stopped.reason}`,
            { cause },
          ),
        );
      return err(
        new AnalysisTimeoutError("rizin_debug_command", this.#frameTimeoutMs, {
          cause,
        }),
      );
    } finally {
      if (acquired) {
        session.commandCaptureActive = false;
        release?.();
      } else
        void previous.then(
          () => release?.(),
          () => release?.(),
        );
    }
  }

  status(sessionId: string):
    | {
        readonly session_id: string;
        readonly state: "ready" | "closed";
        readonly recent_output: readonly string[];
        readonly recent_output_truncated: boolean;
        readonly diagnostics_truncated: boolean;
      }
    | undefined {
    const session = this.#sessions.get(sessionId);
    return session === undefined
      ? undefined
      : {
          session_id: session.id,
          state:
            session.exited || session.protocolError !== undefined
              ? "closed"
              : session.ready
                ? "ready"
                : "closed",
          recent_output: [...session.history],
          recent_output_truncated: session.historyTruncated,
          diagnostics_truncated:
            session.supervisor.snapshot().diagnosticTruncated === true,
        };
  }

  async close(
    sessionId: string,
  ): Promise<Result<{ readonly target_state: "unknown" }, AnalysisError>> {
    const session = this.#sessions.get(sessionId);
    if (session === undefined)
      return err(new AnalysisInputError("close_rizin_debug_session"));
    const stopped = await stopDebuggerOnly(session);
    if (stopped.status === "incomplete")
      return err(
        new AnalysisCapabilityUnavailableError(
          "rizin",
          "close_rizin_debug_session",
          stopped.reason,
        ),
      );
    this.#sessions.delete(sessionId);
    return ok({ target_state: "unknown" });
  }

  async closeAll(): Promise<void> {
    return closeOwnedDebuggerSessions(
      this.#sessions,
      stopDebuggerOnly,
      "Rizin",
    );
  }

  #receive(session: RizinDebugSession, chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length) {
      const boundary = chunk.indexOf(0, offset);
      const end = boundary < 0 ? chunk.length : boundary;
      const piece = chunk.subarray(offset, end);
      if (session.discardingOversizedFrame) {
        if (boundary < 0) return;
        const frame = session.buffer.toString("utf8");
        const frameBytes = session.buffer.length;
        session.buffer = Buffer.alloc(0);
        session.discardingOversizedFrame = false;
        this.#deliverFrame(
          session,
          { text: frame, truncated: true },
          frameBytes,
        );
        offset = boundary + 1;
        continue;
      }
      if (session.buffer.length + piece.length > MAX_FRAME_BYTES) {
        const message =
          "Rizin emitted an NUL frame exceeding the 16 MiB protocol limit.";
        if (!session.commandCaptureActive) {
          this.#failProtocol(session, message);
          return;
        }
        session.protocolError = message;
        session.historyTruncated = true;
        const remainingBytes = MAX_FRAME_BYTES - session.buffer.length;
        session.buffer = Buffer.concat([
          session.buffer,
          piece.subarray(0, remainingBytes),
        ]);
        if (boundary < 0) {
          session.discardingOversizedFrame = true;
          return;
        }
        const frame = session.buffer.toString("utf8");
        const frameBytes = session.buffer.length;
        session.buffer = Buffer.alloc(0);
        this.#deliverFrame(
          session,
          { text: frame, truncated: true },
          frameBytes,
        );
        offset = boundary + 1;
        continue;
      }
      session.buffer = Buffer.concat([session.buffer, piece]);
      if (boundary < 0) return;
      const frame = session.buffer.toString("utf8");
      const frameBytes = session.buffer.length;
      session.buffer = Buffer.alloc(0);
      this.#deliverFrame(
        session,
        { text: frame, truncated: false },
        frameBytes,
      );
      offset = boundary + 1;
    }
  }

  #deliverFrame(
    session: RizinDebugSession,
    frame: RizinFrame,
    frameBytes: number,
  ): void {
    const historyFrame =
      frameBytes > MAX_RECENT_FRAME_BYTES || frame.truncated
        ? `${frame.text.slice(0, MAX_RECENT_FRAME_BYTES)}[recent frame truncated]`
        : frame.text;
    if (frameBytes > MAX_RECENT_FRAME_BYTES || frame.truncated)
      session.historyTruncated = true;
    session.history.push(historyFrame);
    if (session.history.length > 64) {
      session.history.splice(0, session.history.length - 64);
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
        "Rizin produced unsolicited frames exceeding the bounded queue limit.",
      );
      return;
    }
    session.frames.push({ frame, queueChargeBytes });
    session.queuedFrameBytes += queueChargeBytes;
  }

  #failProtocol(session: RizinDebugSession, message: string): void {
    session.protocolError = message;
    session.buffer = Buffer.alloc(0);
    for (const waiter of session.frameWaiters)
      waiter.reject(new Error(message));
    session.frameWaiters.length = 0;
    session.launched.process.kill("SIGTERM");
  }

  async #stopAfterProtocolFailure(
    session: RizinDebugSession,
    cause: unknown,
  ): Promise<AnalysisError> {
    const stopped = await stopDebuggerOnly(session);
    return new AnalysisCapabilityUnavailableError(
      "rizin",
      "rizin_debug_command",
      stopped.status === "incomplete"
        ? `${session.protocolError} The owned process could not be confirmed stopped: ${stopped.reason}`
        : (session.protocolError ?? "Rizin protocol failed."),
      { cause },
    );
  }
}

export interface RizinDebugCommandResult {
  readonly command: string;
  readonly output: string;
  readonly output_scope: "command_and_interleaved_session_output";
  readonly output_truncated: boolean;
  readonly completion_status: "complete" | "unknown";
  readonly backend: string | null;
}

const waitForCommandFrames = async (
  session: RizinDebugSession,
  marker: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ readonly output: string; readonly outputTruncated: boolean }> => {
  const deadline = Date.now() + timeoutMs;
  const output: string[] = [];
  let outputBytes = 0;
  let frameCount = 0;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0)
      throw new Error(
        "Timed out waiting for Rizin's command-completion marker",
      );
    let received: RizinFrame;
    try {
      received = await waitForFrame(session, remaining, signal);
    } catch (cause) {
      if (cause instanceof AnalysisCancelledError) throw cause;
      throw new RizinCommandTimeoutError(output.join("\n"));
    }
    frameCount += 1;
    if (frameCount > MAX_COMMAND_FRAMES) {
      const message =
        "Rizin emitted more than 4096 frames for one command; the session was stopped because output correlation is ambiguous.";
      session.protocolError = message;
      return { output: output.join("\n"), outputTruncated: true };
    }
    if (received.truncated) {
      const separatorBytes = output.length > 0 ? 1 : 0;
      output.push(
        truncateUtf8(
          received.text,
          MAX_COMMAND_OUTPUT_BYTES - outputBytes - separatorBytes,
        ),
      );
      return { output: output.join("\n"), outputTruncated: true };
    }
    const frame = received.text;
    const markerIndex = frame.indexOf(marker);
    if (markerIndex >= 0) {
      const beforeMarker = frame.slice(0, markerIndex).trimEnd();
      if (beforeMarker.length > 0) {
        const beforeMarkerBytes = Buffer.byteLength(beforeMarker, "utf8");
        const separatorBytes = output.length > 0 ? 1 : 0;
        if (
          outputBytes + separatorBytes + beforeMarkerBytes >
          MAX_COMMAND_OUTPUT_BYTES
        ) {
          const message =
            "Rizin command output exceeded the 16 MiB command limit.";
          session.protocolError = message;
          output.push(
            truncateUtf8(
              beforeMarker,
              MAX_COMMAND_OUTPUT_BYTES - outputBytes - separatorBytes,
            ),
          );
          return { output: output.join("\n"), outputTruncated: true };
        }
        outputBytes += separatorBytes + beforeMarkerBytes;
        output.push(beforeMarker);
      }
      return { output: output.join("\n"), outputTruncated: false };
    }
    const frameBytes = Buffer.byteLength(frame, "utf8");
    const separatorBytes = output.length > 0 ? 1 : 0;
    if (outputBytes + separatorBytes + frameBytes > MAX_COMMAND_OUTPUT_BYTES) {
      const message = "Rizin command output exceeded the 16 MiB command limit.";
      session.protocolError = message;
      output.push(
        truncateUtf8(
          frame,
          MAX_COMMAND_OUTPUT_BYTES - outputBytes - separatorBytes,
        ),
      );
      return { output: output.join("\n"), outputTruncated: true };
    }
    outputBytes += separatorBytes + frameBytes;
    output.push(frame);
  }
};

const truncateUtf8 = (value: string, maximumBytes: number): string => {
  if (maximumBytes <= 0) return "";
  const bytes = Buffer.from(value, "utf8").subarray(0, maximumBytes);
  return bytes.toString("utf8").replace(/\uFFFD$/u, "");
};

const waitForFrame = (
  session: RizinDebugSession,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<RizinFrame> => {
  if (signal?.aborted)
    return Promise.reject(new AnalysisCancelledError("rizin_debug_command"));
  const queued = session.frames.shift();
  if (queued !== undefined) {
    session.queuedFrameBytes -= queued.queueChargeBytes;
    return Promise.resolve(queued.frame);
  }
  if (session.exited)
    return Promise.reject(
      new Error("Rizin process exited before the next NUL frame"),
    );
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const index = session.frameWaiters.indexOf(waiter);
      if (index >= 0) session.frameWaiters.splice(index, 1);
    };
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new AnalysisCancelledError("rizin_debug_command"));
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("Timed out waiting for the next Rizin NUL frame"));
    }, timeoutMs);
    const waiter = {
      resolve: (frame: RizinFrame): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(frame);
      },
      reject: (cause: Error): void => {
        if (settled) return;
        settled = true;
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
    return Promise.reject(new AnalysisCancelledError("rizin_debug_command"));
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void =>
      reject(new AnalysisCancelledError("rizin_debug_command"));
    signal.addEventListener("abort", onAbort, { once: true });
    previous.then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      (cause: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(cause);
      },
    );
  });
};

/** Stop only the directly owned debugger process, never its process group or target. */
const stopDebuggerOnly = async (
  session: RizinDebugSession,
): ReturnType<typeof stopOwnedDebuggerProcess> =>
  stopOwnedDebuggerProcess(session, "Rizin debugger");
