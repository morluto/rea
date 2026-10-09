import { randomUUID } from "node:crypto";

import {
  AnalysisCapabilityUnavailableError,
  AnalysisCancelledError,
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

const STARTUP_TIMEOUT_MS = 10_000;
const COMMAND_TIMEOUT_MS = 120_000;
const MAX_COMMAND_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_MI_LINE_BYTES = 16 * 1024 * 1024;
const MAX_RECENT_MI_LINE_BYTES = 64 * 1024;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;

export const GDB_PROVIDER_IDENTITY = {
  id: "gnu.gdb",
  name: "GNU GDB",
  version: null,
} as const;

interface PendingCommand {
  readonly token: number;
  readonly lines: string[];
  outputBytes: number;
  outputTruncated: boolean;
  readonly resolve: (result: GdbCommandResult) => void;
  readonly reject: (error: Error) => void;
  readonly cleanup: () => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export interface GdbCommandResult {
  readonly command: string;
  readonly mi: string;
  readonly records: readonly string[];
  readonly console: string;
  readonly target: string;
  readonly log: string;
  readonly process_exit_observed?: boolean;
  readonly output_truncated: boolean;
  readonly completion_status: "complete" | "unknown";
}

class GdbCommandTimeoutError extends AnalysisTimeoutError {
  constructor(
    readonly partial: GdbCommandResult,
    timeoutMs: number,
  ) {
    super("gdb_console", timeoutMs);
  }
}

interface GdbSession {
  readonly id: string;
  readonly miVersion: "mi3" | "mi2";
  readonly launched: SpawnedOwnedProviderProcess;
  readonly supervisor: ProviderProcessSupervisor;
  readonly pending: Map<number, PendingCommand>;
  readonly lines: string[];
  buffer: string;
  ready: boolean;
  exited: boolean;
  nextToken: number;
  startupResolve: (() => void) | undefined;
  startupReject: ((error: Error) => void) | undefined;
  commandTail: Promise<void>;
  protocolError: string | undefined;
  recentRecordsTruncated: boolean;
}

/** Owns persistent GDB/MI sessions independently from the active binary target. */
export class GdbSessionManager {
  readonly #sessions = new Map<string, GdbSession>();
  readonly #command: string;
  readonly #commandTimeoutMs: number;
  readonly #platform: NodeJS.Platform;

  constructor(
    options: {
      readonly environment?: Readonly<NodeJS.ProcessEnv>;
      readonly commandTimeoutMs?: number;
      readonly platform?: NodeJS.Platform;
    } = {},
  ) {
    this.#command =
      options.environment?.REA_GDB_COMMAND ??
      process.env.REA_GDB_COMMAND ??
      "gdb";
    this.#commandTimeoutMs = options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS;
    this.#platform = options.platform ?? process.platform;
  }

  async start(
    signal?: AbortSignal,
  ): Promise<
    Result<
      { readonly session_id: string; readonly mi_version: "mi3" | "mi2" },
      AnalysisError
    >
  > {
    if (signal?.aborted)
      return err(new AnalysisCancelledError("start_gdb_session"));
    if (this.#platform === "win32")
      return err(
        new AnalysisCapabilityUnavailableError(
          "gdb",
          "start_gdb_session",
          "Persistent Windows GDB sessions are unavailable because the owned Job Object cleanup can terminate debugger inferiors.",
        ),
      );
    const id = randomUUID();
    const mi3 = await this.#startProtocol(id, "mi3", signal);
    return mi3.ok || signal?.aborted || this.#sessions.has(id)
      ? mi3
      : this.#startProtocol(id, "mi2", signal);
  }

  async #startProtocol(
    id: string,
    miVersion: "mi3" | "mi2",
    signal?: AbortSignal,
  ): Promise<
    Result<
      { readonly session_id: string; readonly mi_version: "mi3" | "mi2" },
      AnalysisError
    >
  > {
    let launched: SpawnedOwnedProviderProcess;
    try {
      launched = await spawnOwnedProviderProcess({
        command: this.#command,
        arguments: ["--nx", "--quiet", `--interpreter=${miVersion}`],
        runId: randomUUID(),
        stdin: "pipe",
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (cause) {
      return err(
        new AnalysisCapabilityUnavailableError(
          "gdb",
          "start_gdb_session",
          cause instanceof Error ? cause.message : "Unable to start GDB",
        ),
      );
    }
    const supervisor = new ProviderProcessSupervisor(
      { process: launched.process, ownsProcessLifetime: false },
      { captureStdout: false, maxDiagnosticBytes: MAX_DIAGNOSTIC_BYTES },
    );
    const session: GdbSession = {
      id,
      miVersion,
      launched,
      supervisor,
      pending: new Map(),
      lines: [],
      buffer: "",
      ready: false,
      exited: false,
      nextToken: 1,
      startupResolve: undefined,
      startupReject: undefined,
      commandTail: Promise.resolve(),
      protocolError: undefined,
      recentRecordsTruncated: false,
    };
    launched.process.stdout?.setEncoding("utf8");
    launched.process.stdout?.on("data", (chunk: string | Buffer) =>
      this.#receive(session, String(chunk)),
    );
    launched.process.stdin?.on("error", (cause: Error) =>
      this.#failProtocol(session, `GDB stdin stream failed: ${cause.message}`),
    );
    launched.process.stdin?.once("close", () => {
      if (!session.exited && session.protocolError === undefined)
        this.#failProtocol(session, "GDB stdin stream closed unexpectedly.");
    });
    launched.process.once("exit", () => {
      session.exited = true;
      for (const pending of session.pending.values()) {
        if (pending.timer !== undefined) clearTimeout(pending.timer);
        pending.reject(
          new Error("GDB exited before completing the MI command"),
        );
      }
      session.pending.clear();
      session.startupReject?.(new Error("GDB exited during startup"));
    });
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    let startupAbortListener: (() => void) | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        session.startupResolve = resolve;
        session.startupReject = reject;
        startupAbortListener = () =>
          reject(new AnalysisCancelledError("start_gdb_session"));
        signal?.addEventListener("abort", startupAbortListener, {
          once: true,
        });
        if (signal?.aborted) startupAbortListener();
        startupTimer = setTimeout(
          () =>
            reject(
              new Error(
                "GDB did not emit the MI prompt before the startup deadline",
              ),
            ),
          STARTUP_TIMEOUT_MS,
        );
        startupTimer.unref();
      });
      session.ready = true;
      if (signal?.aborted)
        throw new AnalysisCancelledError("start_gdb_session");
      const autoLoad = await this.#request(
        session,
        "-gdb-set auto-load off",
        signal,
      );
      if (!/^\d+\^done(?:,|$)/u.test(autoLoad.mi)) {
        session.protocolError = `GDB rejected the required automatic-loading disable command (${autoLoad.mi || "no MI result"}); the session was not started.`;
        throw new Error(session.protocolError);
      }
      if (signal?.aborted)
        throw new AnalysisCancelledError("start_gdb_session");
      this.#sessions.set(id, session);
      return ok({ session_id: id, mi_version: miVersion });
    } catch (cause) {
      const stopped = await stopDebuggerOnly(session);
      if (stopped.status === "incomplete") {
        this.#sessions.set(id, session);
        return err(
          new AnalysisCapabilityUnavailableError(
            "gdb",
            "start_gdb_session",
            `GDB startup failed and its owned process could not be confirmed stopped: ${stopped.reason}`,
            { cause },
          ),
        );
      }
      const error =
        signal?.aborted || cause instanceof AnalysisCancelledError
          ? new AnalysisCancelledError("start_gdb_session", { cause })
          : cause instanceof AnalysisTimeoutError
            ? cause
            : session.protocolError !== undefined
              ? new AnalysisCapabilityUnavailableError(
                  "gdb",
                  "start_gdb_session",
                  session.protocolError,
                  { cause },
                )
              : new AnalysisTimeoutError(
                  "start_gdb_session",
                  STARTUP_TIMEOUT_MS,
                  {
                    cause,
                  },
                );
      return err(error);
    } finally {
      if (startupTimer !== undefined) clearTimeout(startupTimer);
      if (startupAbortListener !== undefined)
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
    if (
      session === undefined ||
      !session.ready ||
      session.exited ||
      session.protocolError !== undefined
    )
      return err(
        new AnalysisInputError("gdb_console", undefined, [
          {
            path: ["session_id"],
            reason: "invalid_value",
            message: "GDB session is unavailable or closed.",
          },
        ]),
      );
    if (signal?.aborted) return err(new AnalysisCancelledError("gdb_console"));
    try {
      return await this.#serialize(
        session,
        async () => {
          if (session.exited || session.protocolError !== undefined)
            return err(new AnalysisInputError("gdb_console"));
          try {
            const result = await this.#request(
              session,
              `-interpreter-exec console ${miQuote(command)}`,
              signal,
            );
            const evidence = createEvidence(
              undefined,
              { id: "gnu.gdb", name: "GNU GDB", version: null },
              {
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
                  completion_status: result.completion_status,
                },
                subjectUnavailableReason:
                  "The active GDB inferior identity is not established by the debugger session identifier.",
                limitations: [
                  "MI records are preserved raw; their semantics depend on GDB version and target.",
                  "The unrestricted GDB console can access local shell, filesystem, network, and target controls.",
                ],
              },
            );
            return ok({ result, evidence });
          } catch (cause) {
            if (signal?.aborted || cause instanceof AnalysisCancelledError)
              return err(new AnalysisCancelledError("gdb_console", { cause }));
            if (cause instanceof GdbCommandTimeoutError) {
              const result = cause.partial;
              const evidence = createEvidence(
                undefined,
                GDB_PROVIDER_IDENTITY,
                {
                  predicateType: "rea.debugger.console-observation",
                  operation: "gdb_console",
                  parameters: { session_id: sessionId, command },
                  result: { ...result, records: [...result.records] },
                  rawResult: { ...result, records: [...result.records] },
                  subjectUnavailableReason:
                    "The active GDB inferior identity is not established by the debugger session identifier.",
                  limitations: [
                    "The GDB command exceeded its deadline; retained MI and stream records are partial and command completion is unknown.",
                    "The owned GDB process was stopped because output correlation could no longer be guaranteed.",
                    "The unrestricted GDB console can access local shell, filesystem, network, and target controls.",
                  ],
                },
              );
              return ok({ result, evidence });
            }
            if (cause instanceof AnalysisTimeoutError) return err(cause);
            if (session.protocolError !== undefined)
              return err(await this.#stopAfterProtocolFailure(session, cause));
            if (session.exited) {
              const result: GdbCommandResult = {
                command,
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
                output_truncated: session.recentRecordsTruncated,
                completion_status: "unknown",
              };
              const evidence = createEvidence(
                undefined,
                { id: "gnu.gdb", name: "GNU GDB", version: null },
                {
                  predicateType: "rea.debugger.console-observation",
                  operation: "gdb_console",
                  parameters: { session_id: sessionId, command },
                  result: {
                    command: result.command,
                    mi: result.mi,
                    records: [...result.records],
                    console: result.console,
                    target: result.target,
                    log: result.log,
                    process_exit_observed: true,
                    output_truncated: result.output_truncated,
                    completion_status: "unknown",
                  },
                  rawResult: {
                    command: result.command,
                    mi: result.mi,
                    records: [...result.records],
                    console: result.console,
                    target: result.target,
                    log: result.log,
                    process_exit_observed: true,
                    output_truncated: result.output_truncated,
                    completion_status: "unknown",
                  },
                  subjectUnavailableReason:
                    "The active GDB inferior identity is not established by the debugger session identifier.",
                  limitations: [
                    "GDB exited before returning a correlated MI result record; all retained MI and stream records are returned raw.",
                    ...(result.output_truncated
                      ? [
                          "Retained MI records are a truncated suffix; output completeness is unknown.",
                        ]
                      : []),
                  ],
                },
              );
              return ok({ result, evidence });
            }
            return err(
              new AnalysisTimeoutError("gdb_console", COMMAND_TIMEOUT_MS, {
                cause,
              }),
            );
          }
        },
        signal,
      );
    } catch (cause) {
      return err(new AnalysisCancelledError("gdb_console", { cause }));
    }
  }

  status(sessionId: string):
    | {
        readonly session_id: string;
        readonly mi_version: "mi3" | "mi2";
        readonly state: "ready" | "closed";
        readonly recent_mi_records: readonly string[];
        readonly recent_mi_records_truncated: boolean;
        readonly diagnostics_truncated: boolean;
      }
    | undefined {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return undefined;
    return {
      session_id: session.id,
      mi_version: session.miVersion,
      state:
        session.exited || session.protocolError !== undefined
          ? "closed"
          : session.ready
            ? "ready"
            : "closed",
      recent_mi_records: [...session.lines],
      recent_mi_records_truncated: session.recentRecordsTruncated,
      diagnostics_truncated:
        session.supervisor.snapshot().diagnosticTruncated === true,
    };
  }

  async close(
    sessionId: string,
  ): Promise<
    Result<
      { readonly target_state: "none_observed" | "unknown" },
      AnalysisError
    >
  > {
    const session = this.#sessions.get(sessionId);
    if (session === undefined)
      return err(new AnalysisInputError("close_gdb_session"));
    if (session.exited) {
      this.#sessions.delete(sessionId);
      session.supervisor.dispose();
      return ok({ target_state: "unknown" });
    }
    return this.#serialize(session, async () => {
      if (session.exited) {
        this.#sessions.delete(sessionId);
        session.supervisor.dispose();
        return ok({ target_state: "unknown" });
      }
      let targetState: "none_observed" | "unknown" = "unknown";
      try {
        const groups = await this.#request(
          session,
          "-list-thread-groups --recurse 1",
        );
        if (!/^\d+\^done(?:,|$)/u.test(groups.mi))
          throw new Error(
            "GDB could not confirm its live thread groups before shutdown.",
          );
        const hasLiveTarget =
          /\bpid=(?:"[^"]+"|[0-9]+)/u.test(groups.mi) ||
          /\bthreads=\[(?!\s*\])/u.test(groups.mi);
        if (hasLiveTarget)
          return err(
            new AnalysisInputError("close_gdb_session", undefined, [
              {
                path: ["session_id"],
                reason: "invalid_value",
                message:
                  "Live GDB thread groups remain. Use the unrestricted console to select a disposition for each inferior, then close the debugger session.",
              },
            ]),
          );
        targetState = "none_observed";
        await this.#request(session, "-gdb-exit");
      } catch {
        // If MI synchronization is lost, stop only the owned debugger process.
      }
      const stopped = await stopDebuggerOnly(session);
      if (stopped.status === "incomplete")
        return err(
          new AnalysisCapabilityUnavailableError(
            "gdb",
            "close_gdb_session",
            stopped.reason,
          ),
        );
      this.#sessions.delete(sessionId);
      return ok({ target_state: targetState });
    });
  }

  async closeAll(): Promise<void> {
    return closeOwnedDebuggerSessions(this.#sessions, stopDebuggerOnly, "GDB");
  }

  async #serialize<Value>(
    session: GdbSession,
    operation: () => Promise<Value>,
    signal?: AbortSignal,
  ): Promise<Value> {
    const previous = session.commandTail;
    let release: (() => void) | undefined;
    let acquired = false;
    session.commandTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await waitForTurn(previous, signal);
      acquired = true;
      return await operation();
    } finally {
      if (acquired) release?.();
      else
        void previous.then(
          () => release?.(),
          () => release?.(),
        );
    }
  }

  #receive(session: GdbSession, data: string): void {
    const combined = session.buffer + data;
    session.buffer = "";
    const parts = combined.split(/\r?\n/u);
    if (!combined.endsWith("\n")) session.buffer = parts.pop() ?? "";
    if (Buffer.byteLength(session.buffer, "utf8") > MAX_MI_LINE_BYTES) {
      this.#failProtocol(
        session,
        "GDB emitted a partial MI line exceeding the 16 MiB protocol limit.",
      );
      return;
    }
    const lines = parts.filter((line) => line.length > 0);
    if (
      lines.some((line) => Buffer.byteLength(line, "utf8") > MAX_MI_LINE_BYTES)
    ) {
      this.#failProtocol(
        session,
        "GDB emitted an MI line exceeding the 16 MiB protocol limit.",
      );
      return;
    }
    for (const line of lines) {
      if (Buffer.byteLength(line, "utf8") > MAX_RECENT_MI_LINE_BYTES) {
        session.lines.push(
          `${line.slice(0, MAX_RECENT_MI_LINE_BYTES)}[recent record truncated]`,
        );
        session.recentRecordsTruncated = true;
      } else session.lines.push(line);
    }
    if (session.lines.length > 256) {
      session.lines.splice(0, session.lines.length - 256);
      session.recentRecordsTruncated = true;
    }
    if (combined.includes("(gdb)")) session.startupResolve?.();
    for (const line of lines) {
      for (const pending of session.pending.values()) {
        const lineBytes = Buffer.byteLength(line, "utf8") + 1;
        if (pending.outputBytes + lineBytes <= MAX_COMMAND_OUTPUT_BYTES) {
          pending.lines.push(line);
          pending.outputBytes += lineBytes;
        } else pending.outputTruncated = true;
      }
      const match = /^(\d+)\^(done|running|connected|error|exit)(?:,|$)/u.exec(
        line,
      );
      if (match === null) continue;
      const token = Number(match[1]);
      const pending = session.pending.get(token);
      if (pending === undefined) continue;
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      session.pending.delete(token);
      pending.cleanup();
      const records = [...pending.lines];
      pending.resolve({
        command: "",
        mi: line,
        records,
        console: records.filter((record) => record.startsWith("~")).join("\n"),
        target: records.filter((record) => record.startsWith("@")).join("\n"),
        log: records.filter((record) => record.startsWith("&")).join("\n"),
        output_truncated: pending.outputTruncated,
        completion_status: "complete",
      });
    }
  }

  #failProtocol(session: GdbSession, message: string): void {
    session.protocolError = message;
    for (const pending of session.pending.values()) {
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      pending.cleanup();
      pending.reject(new Error(message));
    }
    session.pending.clear();
    session.startupReject?.(new Error(message));
    session.launched.process.kill("SIGTERM");
  }

  async #stopAfterProtocolFailure(
    session: GdbSession,
    cause: unknown,
  ): Promise<AnalysisCapabilityUnavailableError> {
    const stopped = await stopDebuggerOnly(session);
    return new AnalysisCapabilityUnavailableError(
      "gdb",
      "gdb_console",
      stopped.status === "incomplete"
        ? `${session.protocolError} The owned process could not be confirmed stopped: ${stopped.reason}`
        : (session.protocolError ?? "GDB protocol failed."),
      { cause },
    );
  }

  #request(
    session: GdbSession,
    command: string,
    signal?: AbortSignal,
  ): Promise<GdbCommandResult> {
    const stdin = session.launched.process.stdin;
    if (session.exited)
      return Promise.reject(new Error("GDB MI process has exited"));
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
      let abortListener: (() => void) | undefined;
      const cleanup = (): void => {
        if (abortListener !== undefined)
          signal?.removeEventListener("abort", abortListener);
      };
      const pending: PendingCommand = {
        token,
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
        timer: undefined,
        outputBytes: 0,
        outputTruncated: false,
      };
      pending.timer = setTimeout(() => {
        session.pending.delete(token);
        session.protocolError =
          "A GDB MI command timed out; untagged stream output can no longer be safely correlated with later commands.";
        pending.cleanup();
        void stopDebuggerOnly(session).then(
          (stopped) =>
            pending.reject(
              stopped.status === "incomplete"
                ? new AnalysisCapabilityUnavailableError(
                    "gdb",
                    "gdb_console",
                    `GDB command output could not be correlated and its owned process could not be confirmed stopped: ${stopped.reason}`,
                    {
                      cause: new AnalysisTimeoutError(
                        "gdb_console",
                        this.#commandTimeoutMs,
                        {
                          cause: new Error(
                            `GDB MI command timed out: ${command}`,
                          ),
                        },
                      ),
                    },
                  )
                : new GdbCommandTimeoutError(
                    {
                      command,
                      mi: "",
                      records: [...pending.lines],
                      console: pending.lines
                        .filter((line) => line.startsWith("~"))
                        .join("\n"),
                      target: pending.lines
                        .filter((line) => line.startsWith("@"))
                        .join("\n"),
                      log: pending.lines
                        .filter((line) => line.startsWith("&"))
                        .join("\n"),
                      output_truncated: pending.outputTruncated,
                      completion_status: "unknown",
                    },
                    this.#commandTimeoutMs,
                  ),
            ),
          (cause: unknown) =>
            pending.reject(
              new AnalysisCapabilityUnavailableError(
                "gdb",
                "gdb_console",
                "GDB command output could not be correlated and owned process shutdown failed.",
                { cause },
              ),
            ),
        );
      }, this.#commandTimeoutMs);
      session.pending.set(token, pending);
      abortListener = (): void => {
        if (pending.timer !== undefined) clearTimeout(pending.timer);
        session.pending.delete(token);
        session.protocolError =
          "A GDB MI command was cancelled; the owned session was stopped because output correlation can no longer be guaranteed.";
        void stopDebuggerOnly(session).then(
          (stopped) => {
            pending.reject(
              stopped.status === "incomplete"
                ? new AnalysisCapabilityUnavailableError(
                    "gdb",
                    "gdb_console",
                    `Cancellation was requested, but the owned GDB process could not be confirmed stopped: ${stopped.reason}`,
                    { cause: new AnalysisCancelledError("gdb_console") },
                  )
                : new AnalysisCancelledError("gdb_console"),
            );
          },
          () => pending.reject(new AnalysisCancelledError("gdb_console")),
        );
      };
      signal?.addEventListener("abort", abortListener, { once: true });
      if (signal?.aborted) {
        abortListener();
        return;
      }
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
    }).then((result) => ({ ...result, command }));
  }
}

const miQuote = (value: string): string =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\r", "\\r").replaceAll("\n", "\\n")}"`;

/** Terminate only the directly owned debugger process, never its process group or inferiors. */
const stopDebuggerOnly = async (
  session: GdbSession,
): ReturnType<typeof stopOwnedDebuggerProcess> =>
  stopOwnedDebuggerProcess(session, "GDB");

const waitForTurn = (
  previous: Promise<void>,
  signal?: AbortSignal,
): Promise<void> => {
  if (signal === undefined) return previous;
  if (signal.aborted)
    return Promise.reject(new AnalysisCancelledError("gdb_console"));
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void =>
      reject(new AnalysisCancelledError("gdb_console"));
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
