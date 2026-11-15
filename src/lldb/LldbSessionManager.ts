import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

import {
  AnalysisCapabilityUnavailableError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisTimeoutError,
} from "../domain/analysisErrorCore.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { createEvidence, type Evidence } from "../domain/evidence.js";
import { err, ok, type Result } from "../domain/result.js";

const BRIDGE_SCRIPT = fileURLToPath(
  new URL("../../bridge/native/rea_lldb_session.py", import.meta.url),
);

const LLDB_FRAMEWORK_PYTHON_CANDIDATES = [
  "/Volumes/MyData/Applications/Xcode-26.6.0.app/Contents/SharedFrameworks/LLDB.framework/Resources/Python",
  "/Applications/Xcode.app/Contents/SharedFrameworks/LLDB.framework/Resources/Python",
  "/Library/Developer/CommandLineTools/Library/PrivateFrameworks/LLDB.framework/Resources/Python",
];

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 20_000;

export interface LldbStartOptions {
  readonly path?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly pid?: number;
  readonly stop_at_entry?: boolean;
  readonly disable_aslr?: boolean;
  readonly breakpoints?: readonly string[];
}

export interface LldbStartResult {
  readonly session_id: string;
  readonly state:
    | "ready"
    | "launched"
    | "attached"
    | "stopped"
    | "running"
    | "failed";
  readonly pid?: number | null;
  readonly target?: string | null;
}

export interface LldbCommandResult {
  readonly command: string;
  readonly output: string;
  readonly process_state?: string;
  readonly output_truncated: boolean;
  readonly output_invalid_utf8?: true;
  readonly completion_status: "complete" | "unknown";
}

export interface LldbStatusResult {
  readonly session_id: string;
  readonly state: "ready" | "closed";
  readonly process_state: string;
  readonly pid: number | null;
  readonly target: string | null;
}

interface PendingRpc {
  readonly resolve: (value: any) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

interface ActiveSession {
  readonly id: string;
  readonly child: ChildProcess;
  readonly rl: readline.Interface;
  readonly pending: Map<number, PendingRpc>;
  nextId: number;
  closed: boolean;
  state: "ready" | "closed";
  processState: string;
  pid: number | null;
  target: string | null;
  queue: Promise<unknown>;
}

/**
 * Persistent Apple Silicon LLDB session manager for REA on macOS.
 * Contributed by Hardik Shah <hardik05@gmail.com> (https://fuzzing.in, @hardik05).
 */
export class LldbSessionManager {
  readonly #sessions = new Map<string, ActiveSession>();
  readonly #environment: NodeJS.ProcessEnv;
  readonly #platform: NodeJS.Platform;
  readonly #commandTimeoutMs: number;
  readonly #startupTimeoutMs: number;

  constructor(
    options: {
      readonly environment?: Readonly<NodeJS.ProcessEnv>;
      readonly platform?: NodeJS.Platform;
      readonly commandTimeoutMs?: number;
      readonly startupTimeoutMs?: number;
    } = {},
  ) {
    this.#environment = { ...(options.environment ?? process.env) };
    this.#platform = options.platform ?? process.platform;
    this.#commandTimeoutMs =
      options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.#startupTimeoutMs =
      options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  }

  async start(
    signal?: AbortSignal,
    options: LldbStartOptions = {},
  ): Promise<Result<LldbStartResult, AnalysisError>> {
    if (signal?.aborted) return err(new AnalysisCancelledError("start_lldb_session"));
    if (this.#platform !== "darwin") {
      return err(
        new AnalysisCapabilityUnavailableError(
          "lldb",
          "start_lldb_session",
          "Persistent native LLDB sessions require Apple Silicon macOS (Darwin).",
        ),
      );
    }

    const sessionId = randomUUID();
    const childEnv = { ...this.#environment };

    // Supplement PYTHONPATH with Xcode LLDB framework python bindings if not set
    let addedPythonPath = "";
    for (const cand of LLDB_FRAMEWORK_PYTHON_CANDIDATES) {
      if (existsSync(cand)) {
        addedPythonPath = cand;
        break;
      }
    }
    if (addedPythonPath) {
      childEnv.PYTHONPATH = childEnv.PYTHONPATH
        ? `${addedPythonPath}:${childEnv.PYTHONPATH}`
        : addedPythonPath;
    }

    const child = spawn("/usr/bin/python3", [BRIDGE_SCRIPT], {
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const pending = new Map<number, PendingRpc>();
    const rl = readline.createInterface({ input: child.stdout! });

    rl.on("line", (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const msg = JSON.parse(trimmed);
        if (msg.id !== undefined && pending.has(msg.id)) {
          const rpc = pending.get(msg.id)!;
          pending.delete(msg.id);
          clearTimeout(rpc.timer);
          if (msg.error) {
            rpc.reject(new Error(msg.error.message ?? "RPC error"));
          } else {
            rpc.resolve(msg.result);
          }
        }
      } catch {
        // Discard unformatted lines from inferior stdout
      }
    });

    const session: ActiveSession = {
      id: sessionId,
      child,
      rl,
      pending,
      nextId: 1,
      closed: false,
      state: "ready",
      processState: "no_process",
      pid: null,
      target: options.path ?? null,
      queue: Promise.resolve(),
    };

    child.on("exit", () => {
      session.closed = true;
      session.state = "closed";
      for (const [id, rpc] of pending.entries()) {
        clearTimeout(rpc.timer);
        rpc.reject(new Error("LLDB bridge exited unexpectedly."));
        pending.delete(id);
      }
    });

    const sendRpc = <T>(
      method: string,
      params: Record<string, unknown> = {},
      timeoutMs: number = this.#startupTimeoutMs,
    ): Promise<T> => {
      return new Promise<T>((resolve, reject) => {
        if (session.closed || !child.stdin?.writable) {
          return reject(new Error("LLDB session is closed."));
        }
        const reqId = session.nextId++;
        const timer = setTimeout(() => {
          pending.delete(reqId);
          reject(new AnalysisTimeoutError(method, timeoutMs));
        }, timeoutMs);
        timer.unref();

        pending.set(reqId, { resolve, reject, timer });
        const payload = JSON.stringify({
          jsonrpc: "2.0",
          id: reqId,
          method,
          params,
        });
        child.stdin.write(payload + "\n");
      });
    };

    try {
      // 1. Initialize
      await sendRpc<{ status: string; version: string }>("initialize");

      // 2. Launch target or attach
      let launchState: LldbStartResult["state"] = "ready";
      if (options.path) {
        const launchRes = await sendRpc<{
          status: string;
          pid?: number;
          state?: string;
          error?: string;
        }>("launch", {
          path: options.path,
          args: options.args,
          env: options.env,
          stop_at_entry: options.stop_at_entry ?? true,
          disable_aslr: options.disable_aslr ?? true,
          breakpoints: options.breakpoints,
        });

        if (launchRes.error || launchRes.status === "failed") {
          await this.#terminateChild(child);
          return err(
            new AnalysisCapabilityUnavailableError(
              "lldb",
              "start_lldb_session",
              launchRes.error ?? "Failed to launch target",
            ),
          );
        }
        session.pid = launchRes.pid ?? null;
        session.processState = launchRes.state ?? "stopped";
        launchState = "launched";
      } else if (options.pid) {
        const attachRes = await sendRpc<{
          status: string;
          pid?: number;
          state?: string;
          error?: string;
        }>("attach", {
          pid: options.pid,
        });
        if (attachRes.error || attachRes.status === "failed") {
          await this.#terminateChild(child);
          return err(
            new AnalysisCapabilityUnavailableError(
              "lldb",
              "start_lldb_session",
              attachRes.error ?? "Failed to attach to target",
            ),
          );
        }
        session.pid = attachRes.pid ?? null;
        session.processState = attachRes.state ?? "stopped";
        launchState = "attached";
      }

      this.#sessions.set(sessionId, session);

      return ok({
        session_id: sessionId,
        state: launchState,
        ...(session.pid !== null ? { pid: session.pid } : {}),
        ...(session.target !== null ? { target: session.target } : {}),
      });
    } catch (cause) {
      await this.#terminateChild(child);
      if (cause instanceof AnalysisError) return err(cause);
      return err(
        new AnalysisCapabilityUnavailableError(
          "lldb",
          "start_lldb_session",
          cause instanceof Error ? cause.message : String(cause),
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
      { readonly result: LldbCommandResult; readonly evidence: Evidence },
      AnalysisError
    >
  > {
    const session = this.#sessions.get(sessionId);
    if (!session || session.closed) {
      return err(
        new AnalysisInputError("lldb_command", undefined, [
          {
            path: ["session_id"],
            reason: "invalid_value",
            message: "LLDB session is unavailable or closed.",
          },
        ]),
      );
    }
    if (signal?.aborted) return err(new AnalysisCancelledError("lldb_command"));

    const executeOperation = async (): Promise<
      Result<
        { readonly result: LldbCommandResult; readonly evidence: Evidence },
        AnalysisError
      >
    > => {
      try {
        const timeoutMs = this.#commandTimeoutMs;
        const res = await this.#sendSessionRpc<{
          command: string;
          output: string;
          process_state?: string;
          completion_status: "complete" | "unknown";
        }>(session, "command", { command, timeout: timeoutMs / 1000 }, timeoutMs);

        if (res.process_state) {
          session.processState = res.process_state;
        }

        const cmdResult: LldbCommandResult = {
          command,
          output: res.output ?? "",
          ...(res.process_state !== undefined
            ? { process_state: res.process_state }
            : {}),
          output_truncated: false,
          completion_status: res.completion_status ?? "complete",
        };

        const evidence = createEvidence(
          undefined,
          { id: "apple.lldb", name: "Apple LLDB", version: null },
          {
            predicateType: "rea.debugger.console-observation",
            operation: "lldb_command",
            parameters: { session_id: sessionId, command },
            result: {
              command: cmdResult.command,
              output: cmdResult.output,
              ...(cmdResult.process_state !== undefined
                ? { process_state: cmdResult.process_state }
                : {}),
              output_truncated: cmdResult.output_truncated,
              completion_status: cmdResult.completion_status,
            },
            rawResult: {
              command: cmdResult.command,
              output: cmdResult.output,
              ...(cmdResult.process_state !== undefined
                ? { process_state: cmdResult.process_state }
                : {}),
              output_truncated: cmdResult.output_truncated,
              completion_status: cmdResult.completion_status,
            },
            subjectUnavailableReason:
              "The active LLDB inferior identity is not established by the debugger session identifier.",
            limitations: [
              "LLDB commands run unrestricted against the local target inferior and host runtime.",
            ],
          },
        );

        return ok({ result: cmdResult, evidence });
      } catch (cause) {
        if (cause instanceof AnalysisError) return err(cause);
        return err(
          new AnalysisCapabilityUnavailableError(
            "lldb",
            "lldb_command",
            cause instanceof Error ? cause.message : String(cause),
          ),
        );
      }
    };

    const task = session.queue.then(executeOperation);
    session.queue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  status(sessionId: string): LldbStatusResult | undefined {
    const session = this.#sessions.get(sessionId);
    if (!session) return undefined;

    return {
      session_id: sessionId,
      state: session.state,
      process_state: session.processState,
      pid: session.pid,
      target: session.target,
    };
  }

  async close(
    sessionId: string,
  ): Promise<
    Result<
      {
        readonly target_state:
          | "terminated"
          | "detached"
          | "exited"
          | "none_observed"
          | "unknown";
      },
      AnalysisError
    >
  > {
    const session = this.#sessions.get(sessionId);
    if (!session) {
      return ok({ target_state: "none_observed" });
    }

    this.#sessions.delete(sessionId);
    session.closed = true;
    session.state = "closed";

    let targetState:
      | "terminated"
      | "detached"
      | "exited"
      | "none_observed"
      | "unknown" = "none_observed";

    try {
      const res = await this.#sendSessionRpc<{
        target_state:
          | "terminated"
          | "detached"
          | "exited"
          | "none_observed"
          | "unknown";
      }>(session, "close", {}, 5000);
      if (res?.target_state) {
        targetState = res.target_state;
      }
    } catch {
      targetState = "unknown";
    } finally {
      await this.#terminateChild(session.child);
      session.rl.close();
    }

    return ok({ target_state: targetState });
  }

  async retryCleanupFailures(): Promise<Result<null, AnalysisError>> {
    for (const [id, session] of this.#sessions.entries()) {
      if (session.closed) {
        await this.close(id);
      }
    }
    return ok(null);
  }

  #sendSessionRpc<T>(
    session: ActiveSession,
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (session.closed || !session.child.stdin?.writable) {
        return reject(new Error("LLDB session is closed."));
      }
      const reqId = session.nextId++;
      const timer = setTimeout(() => {
        session.pending.delete(reqId);
        reject(new AnalysisTimeoutError(method, timeoutMs));
      }, timeoutMs);
      timer.unref();

      session.pending.set(reqId, { resolve, reject, timer });
      const payload = JSON.stringify({
        jsonrpc: "2.0",
        id: reqId,
        method,
        params,
      });
      session.child.stdin.write(payload + "\n");
    });
  }

  async #terminateChild(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.killed) return;
    try {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // Already dead
          }
          resolve();
        }, 1500);
        timer.unref();
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    } catch {
      // Ignore process termination errors
    }
  }
}
