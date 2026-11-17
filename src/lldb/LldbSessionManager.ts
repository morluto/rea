import { randomUUID } from "node:crypto";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { z } from "zod";

import {
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisTimeoutError,
  AnalysisCancelledError,
  cancelledBy,
  carriedReason,
} from "../domain/analysisErrorCore.js";
import { errorMessage } from "../kernel/errorMessage.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { analysisErrorWithCleanupDependencies } from "../domain/analysisErrorCleanup.js";
import { coverageStatusSchema } from "../domain/coverage.js";
import { MAX_NODE_TIMER_DELAY_MS } from "../domain/analysisResourceLimits.js";
import { createEvidence, type Evidence } from "../domain/evidence.js";
import { err, ok, type Result } from "../domain/result.js";
import { HOST_PLATFORM } from "../platform/HostPlatform.js";
import {
  debuggerConstructionLimits,
  type DebuggerAdmissionLimit,
} from "../config/debuggerSessionLimits.js";
import {
  debuggerResourceConstraintError,
  stopOwnedDebuggerProcess,
  type OwnedDebuggerDetachResult,
} from "../process/ownedDebuggerSession.js";
import {
  unknownTarget,
  type FileTargetIdentity,
  type SessionTargetIdentity,
  type UnknownTargetIdentity,
} from "../domain/targetIdentity.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import {
  observeDebuggerLaunchFile,
  retryDebuggerStartupFileCleanup,
  type DebuggerLaunchFileObservation,
} from "../process/DebuggerLaunchFile.js";
import { ArtifactResourceScope } from "../resources/index.js";
import {
  ProviderProcessSupervisor,
  spawnOwnedProviderProcess,
  type OwnedProviderProcessSpawnOptions,
  type SpawnedOwnedProviderProcess,
  type ProviderProcessHandle,
} from "../process/ProviderProcess.js";
import { OwnedDebuggerSessionRegistry } from "../process/OwnedDebuggerSessionRegistry.js";
import { AbortedWait, waitForAbortable } from "../process/AbortablePromise.js";
import { LLDB_PROVIDER_IDENTITY } from "./LldbProviderIdentity.js";

const initializeResponseSchema = z.object({
  status: z.string(),
  version: z.string(),
});

const launchAttachResponseSchema = z.object({
  status: z.string(),
  pid: z.number().nullable().optional(),
  state: z.string().optional(),
  error: z.string().optional(),
  target: z.string().nullable().optional(),
  breakpoints: z.array(z.unknown()).optional(),
});

const commandResponseSchema = z.object({
  command: z.string(),
  output: z.string(),
  process_state: z.string().optional(),
  output_truncated: z.boolean().optional(),
  completion_status: coverageStatusSchema,
  pid: z.number().nullable().optional(),
  target: z.string().nullable().optional(),
});

const statusResponseSchema = z.object({
  state: z.enum(["ready", "closed"]).optional(),
  process_state: z.string().optional(),
  pid: z.number().nullable().optional(),
  target: z.string().nullable().optional(),
});

const closeResponseSchema = z.object({
  target_state: z
    .enum(["terminated", "detached", "exited", "none_observed", "unknown"])
    .optional(),
});

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
  readonly completion_status: "complete" | "partial" | "unknown";
}

export interface LldbStatusResult {
  readonly session_id: string;
  readonly state: "ready" | "closed";
  readonly process_state: string;
  readonly pid: number | null;
  readonly target: string | null;
}

export interface LldbLaunchProvenance {
  readonly caller_selected_path: string;
  readonly resolved_path: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

export interface LldbLaunchFile {
  readonly identity: FileTargetIdentity | UnknownTargetIdentity;
  readonly unobservedReason?: string;
  readonly provenance?: LldbLaunchProvenance;
}

interface PendingRpc {
  readonly resolve: (value: any) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

interface ActiveSession {
  readonly id: string;
  readonly launchFile: LldbLaunchFile;
  readonly launched: SpawnedOwnedProviderProcess;
  readonly supervisor: ProviderProcessSupervisor;
  readonly child: ProviderProcessHandle;
  readonly rl: readline.Interface;
  readonly pending: Map<number, PendingRpc>;
  nextId: number;
  closed: boolean;
  closing: boolean;
  closeRequested: boolean;
  exited: boolean;
  state: "ready" | "closed";
  processState: string;
  pid: number | null;
  target: string | null;
  commandTail: Promise<void>;
  pendingCommandCount: number;
  targetStateUnknown: boolean;
  lastObservedTargetState:
    | "terminated"
    | "detached"
    | "exited"
    | "none_observed"
    | "unknown";
  detachInferior: () => Promise<OwnedDebuggerDetachResult>;
}

/** Await a serialized command turn, preserving the caller's cancellation reason. */
const waitForLldbCommandTurn = (
  previous: Promise<void>,
  signal?: AbortSignal,
  operation: string = "lldb_command",
): Promise<void> => {
  if (signal === undefined) return previous;
  return waitForAbortable(previous, signal).then((outcome) => {
    if (outcome instanceof AbortedWait) throw cancelledBy(operation, outcome);
  });
};

const lldbSessionSubject = (
  session: Pick<ActiveSession, "id" | "launchFile">,
): SessionTargetIdentity => ({
  kind: "session",
  session_kind: "lldb",
  id: session.id,
  target: session.launchFile.identity,
});

/**
 * Persistent Apple Silicon LLDB session manager for REA on macOS.
 * Contributed by Hardik Shah <hardik05@gmail.com> (https://fuzzing.in, @hardik05).
 */
export class LldbSessionManager {
  readonly #startupResources = new ArtifactResourceScope();
  readonly #sessions: OwnedDebuggerSessionRegistry<ActiveSession>;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #platform: NodeJS.Platform;
  readonly #commandTimeoutMs: number;
  readonly #startupTimeoutMs: number;
  readonly #maxSessions: DebuggerAdmissionLimit;
  readonly #maxPendingCommands: DebuggerAdmissionLimit;
  readonly #spawnProcess: typeof spawnOwnedProviderProcess;
  readonly #stopProcess: typeof stopOwnedDebuggerProcess;

  constructor(
    options: {
      readonly environment?: Readonly<NodeJS.ProcessEnv>;
      readonly platform?: NodeJS.Platform;
      readonly commandTimeoutMs?: number;
      readonly startupTimeoutMs?: number;
      readonly spawnProcess?: typeof spawnOwnedProviderProcess;
      readonly stopProcess?: typeof stopOwnedDebuggerProcess;
    } = {},
  ) {
    this.#environment = { ...(options.environment ?? process.env) };
    this.#platform = options.platform ?? HOST_PLATFORM.platform;
    const limits = debuggerConstructionLimits(this.#environment);
    this.#maxSessions = limits.maxSessions;
    this.#maxPendingCommands = limits.maxPendingCommands;
    this.#commandTimeoutMs =
      options.commandTimeoutMs ?? limits.commandDeadline.value;
    this.#startupTimeoutMs =
      options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.#spawnProcess = options.spawnProcess ?? spawnOwnedProviderProcess;
    this.#stopProcess = options.stopProcess ?? stopOwnedDebuggerProcess;
    this.#sessions = new OwnedDebuggerSessionRegistry({
      provider: "lldb",
      displayName: "LLDB",
      sealSession: (session) => {
        session.closing = true;
      },
      stopProcess: (session) =>
        this.#stopProcess(session, "LLDB", { platform: this.#platform }),
      stopFailurePrefix: "Owned LLDB shutdown failed",
    });
  }

  #retryStartupFileCleanup(): Promise<Result<null, AnalysisError>> {
    return retryDebuggerStartupFileCleanup({
      provider: "lldb",
      operation: "start_lldb_session",
      resources: this.#startupResources,
    });
  }

  async start(
    signal?: AbortSignal,
    options: LldbStartOptions = {},
  ): Promise<Result<LldbStartResult, AnalysisError>> {
    if (signal?.aborted) return err(cancelledBy("start_lldb_session", signal));
    if (this.#platform !== "darwin") {
      return err(
        new AnalysisCapabilityUnavailableError(
          "lldb",
          "start_lldb_session",
          "Persistent native LLDB sessions require Apple Silicon macOS (Darwin).",
        ),
      );
    }

    const files = await this.#retryStartupFileCleanup();
    if (!files.ok) return files;

    if (options.path !== undefined && options.pid !== undefined) {
      return err(
        new AnalysisInputError("start_lldb_session", undefined, [
          {
            path: ["path"],
            reason: "invalid_value",
            message: "Cannot specify both path (launch) and pid (attach).",
          },
        ]),
      );
    }

    return this.#sessions.start("start_lldb_session", signal, (started) =>
      this.#startWithReservation(started, options),
    );
  }

  async #startWithReservation(
    signal: AbortSignal,
    options: LldbStartOptions = {},
  ): Promise<Result<LldbStartResult, AnalysisError>> {
    if (signal?.aborted) return err(cancelledBy("start_lldb_session", signal));
    const occupied = this.#sessions.occupied();
    if (occupied >= this.#maxSessions.value) {
      return err(
        debuggerResourceConstraintError(
          "start_lldb_session",
          "memory",
          `LLDB session capacity reached (${String(this.#maxSessions.value)} sessions).`,
          "Close an LLDB session before starting another; a stopped session that lldb_session_status reports closed still holds its slot until close_lldb_session releases it.",
          this.#maxSessions,
          {
            max_sessions: this.#maxSessions.value,
            active_or_reserved_sessions: occupied,
          },
        ),
      );
    }

    const releaseReservation = this.#sessions.reserve();
    try {
      return await this.#startReserved(signal, options);
    } finally {
      releaseReservation();
    }
  }

  async #startReserved(
    signal: AbortSignal,
    options: LldbStartOptions = {},
  ): Promise<Result<LldbStartResult, AnalysisError>> {
    if (signal?.aborted) return err(cancelledBy("start_lldb_session", signal));

    let launchFile: LldbLaunchFile = {
      identity: unknownTarget("not-observed"),
    };
    let launchPath: string | undefined = options.path;
    if (options.path !== undefined) {
      const callerPath = absoluteCallerPath(options.path);
      const resolved = await realpath(callerPath).catch(() => callerPath);
      launchPath = resolved;
      const observed = await observeDebuggerLaunchFile(resolved, {
        provider: "lldb",
        operation: "start_lldb_session",
        resources: this.#startupResources,
        signal,
      });
      if (!observed.ok) return observed;
      launchFile = {
        ...observed.value,
        provenance: {
          caller_selected_path: options.path,
          resolved_path: resolved,
          ...(options.args !== undefined ? { args: [...options.args] } : {}),
          ...(options.env !== undefined ? { env: { ...options.env } } : {}),
        },
      };
    }
    if (signal?.aborted) return err(cancelledBy("start_lldb_session", signal));

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

    let launched: SpawnedOwnedProviderProcess;
    try {
      const spawnOptions: OwnedProviderProcessSpawnOptions = {
        command: "/usr/bin/python3",
        arguments: [BRIDGE_SCRIPT],
        runId: sessionId,
        stdin: "pipe",
        hostEnvironment: childEnv,
        platform: this.#platform,
        signal,
      };
      launched = await this.#spawnProcess(spawnOptions);
    } catch (cause) {
      if (
        (signal?.aborted && cause === signal.reason) ||
        cause instanceof AnalysisCancelledError
      ) {
        return err(cancelledBy("start_lldb_session", carriedReason(cause)));
      }
      return err(
        new AnalysisCapabilityUnavailableError(
          "lldb",
          "start_lldb_session",
          cause instanceof Error
            ? cause.message
            : "Unable to launch LLDB bridge process.",
          { cause },
        ),
      );
    }

    const child = launched.process;
    const supervisor = new ProviderProcessSupervisor(
      { process: child, ownsProcessLifetime: false },
      { captureStdout: false, maxDiagnosticBytes: 64 * 1024 },
    );

    const pending = new Map<number, PendingRpc>();
    const rl = readline.createInterface({ input: child.stdout! });

    child.on("error", (error: Error) => {
      for (const [id, rpc] of pending.entries()) {
        clearTimeout(rpc.timer);
        rpc.reject(error);
        pending.delete(id);
      }
    });

    child.stdin?.on("error", (error: Error) => {
      for (const [id, rpc] of pending.entries()) {
        clearTimeout(rpc.timer);
        rpc.reject(error);
        pending.delete(id);
      }
    });

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
            const errorMsg =
              typeof msg.error === "string"
                ? msg.error
                : typeof msg.error === "object" &&
                    msg.error !== null &&
                    "message" in msg.error
                  ? String(msg.error.message)
                  : "RPC error";
            rpc.reject(new Error(errorMsg));
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
      launchFile,
      launched,
      supervisor,
      child,
      rl,
      pending,
      nextId: 1,
      closed: false,
      closing: false,
      closeRequested: false,
      exited: false,
      state: "ready",
      processState: "no_process",
      pid: null,
      target: launchPath ?? null,
      commandTail: Promise.resolve(),
      pendingCommandCount: 0,
      targetStateUnknown: false,
      lastObservedTargetState: "none_observed",
      detachInferior: async (): Promise<OwnedDebuggerDetachResult> => {
        if (
          session.pid === null ||
          session.processState === "no_process" ||
          session.processState === "none"
        ) {
          session.lastObservedTargetState = "none_observed";
          return { status: "no-inferior" };
        }
        if (session.targetStateUnknown) {
          throw new Error("LLDB target cleanup was not confirmed.");
        }
        try {
          const res = await this.#sendSessionRpc(
            closeResponseSchema,
            session,
            "close",
            {},
            5000,
            undefined,
            "close_lldb_session",
          );
          session.lastObservedTargetState = res?.target_state ?? "unknown";
          if (
            res?.target_state === "none_observed" ||
            res?.target_state === "exited"
          ) {
            return { status: "no-inferior" };
          }
          if (
            res?.target_state === "detached" ||
            res?.target_state === "terminated"
          ) {
            return { status: "detached", outputSink: "durable" };
          }
          session.targetStateUnknown = true;
          throw new Error(
            `LLDB target cleanup unconfirmed: state is ${res?.target_state ?? "unknown"}`,
          );
        } catch (cause) {
          session.targetStateUnknown = true;
          throw cause;
        }
      },
    };

    child.once("exit", () => {
      session.exited = true;
      session.closed = true;
      session.state = "closed";
      for (const [id, rpc] of pending.entries()) {
        clearTimeout(rpc.timer);
        rpc.reject(new Error("LLDB bridge exited unexpectedly."));
        pending.delete(id);
      }
    });

    try {
      if (signal?.aborted) {
        throw cancelledBy("start_lldb_session", signal);
      }

      // 1. Initialize
      await this.#sendSessionRpc(
        initializeResponseSchema,
        session,
        "initialize",
        {},
        this.#startupTimeoutMs,
        signal,
        "start_lldb_session",
      );

      // 2. Launch target or attach
      let launchState: LldbStartResult["state"] = "ready";
      if (launchPath) {
        const launchRes = await this.#sendSessionRpc(
          launchAttachResponseSchema,
          session,
          "launch",
          {
            path: launchPath,
            args: options.args,
            env: options.env,
            stop_at_entry: options.stop_at_entry ?? true,
            disable_aslr: options.disable_aslr ?? true,
            breakpoints: options.breakpoints,
          },
          this.#startupTimeoutMs,
          signal,
          "start_lldb_session",
        );

        if (launchRes.error || launchRes.status === "failed") {
          throw new AnalysisCapabilityUnavailableError(
            "lldb",
            "start_lldb_session",
            launchRes.error ?? "Failed to launch target",
          );
        }
        session.pid = launchRes.pid ?? null;
        session.processState = launchRes.state ?? "stopped";
        launchState = "launched";
      } else if (options.pid) {
        const attachRes = await this.#sendSessionRpc(
          launchAttachResponseSchema,
          session,
          "attach",
          {
            pid: options.pid,
          },
          this.#startupTimeoutMs,
          signal,
          "start_lldb_session",
        );
        if (attachRes.error || attachRes.status === "failed") {
          throw new AnalysisCapabilityUnavailableError(
            "lldb",
            "start_lldb_session",
            attachRes.error ?? "Failed to attach to target",
          );
        }
        session.pid = attachRes.pid ?? null;
        session.processState = attachRes.state ?? "stopped";
        launchState = "attached";
      }

      if (signal?.aborted) {
        throw cancelledBy("start_lldb_session", signal);
      }

      this.#sessions.add(session);

      return ok({
        session_id: sessionId,
        state: launchState,
        ...(session.pid !== null ? { pid: session.pid } : {}),
        ...(session.target !== null ? { target: session.target } : {}),
      });
    } catch (cause) {
      session.closing = true;
      session.closeRequested = true;
      const stopped = await this.#sessions.stop(session);
      if (stopped.status === "incomplete") {
        this.#sessions.add(session);
        const cleanupFailure = this.#sessions.retainCleanupFailure(
          session,
          "start_lldb_session",
          stopped,
          { cause },
        );
        const primary =
          (signal?.aborted && cause === signal.reason) ||
          cause instanceof AnalysisCancelledError
            ? cancelledBy("start_lldb_session", carriedReason(cause))
            : cause instanceof AnalysisError
              ? cause
              : new AnalysisCapabilityUnavailableError(
                  "lldb",
                  "start_lldb_session",
                  errorMessage(cause),
                );
        return err(
          analysisErrorWithCleanupDependencies(
            primary,
            cleanupFailure,
            "start_lldb_session",
          ),
        );
      }
      session.closed = true;
      session.state = "closed";
      rl.close();
      supervisor.dispose();

      if (
        (signal?.aborted && cause === signal.reason) ||
        cause instanceof AnalysisCancelledError
      ) {
        return err(cancelledBy("start_lldb_session", carriedReason(cause)));
      }
      if (cause instanceof AnalysisError) return err(cause);
      return err(
        new AnalysisCapabilityUnavailableError(
          "lldb",
          "start_lldb_session",
          errorMessage(cause),
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
    if (!session || session.closed || session.closing) {
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
    if (signal?.aborted) return err(cancelledBy("lldb_command", signal));
    if (session.pendingCommandCount >= this.#maxPendingCommands.value) {
      return err(
        debuggerResourceConstraintError(
          "lldb_command",
          "transport",
          `LLDB command queue capacity reached (${String(this.#maxPendingCommands.value)} pending commands).`,
          "Wait for an LLDB command on this session to finish, then retry.",
          this.#maxPendingCommands,
          {
            max_pending_commands: this.#maxPendingCommands.value,
            active_or_queued_commands: session.pendingCommandCount,
          },
        ),
      );
    }
    session.pendingCommandCount += 1;
    const previous = session.commandTail;
    let release: (() => void) | undefined;
    let acquired = false;
    session.commandTail = new Promise<void>((resolve) => {
      release = resolve;
    });

    try {
      await waitForLldbCommandTurn(previous, signal, "lldb_command");
      acquired = true;
      if (signal?.aborted) return err(cancelledBy("lldb_command", signal));
      return await this.#executeInTurn(session, sessionId, command, signal);
    } catch (cause) {
      if (
        (signal?.aborted && cause === signal.reason) ||
        cause instanceof AnalysisCancelledError
      ) {
        if (
          cause instanceof AnalysisCancelledError &&
          cause.partialObservation
        ) {
          return err(cause);
        }
        return err(cancelledBy("lldb_command", carriedReason(cause)));
      }
      if (cause instanceof AnalysisError) return err(cause);
      return err(
        new AnalysisCapabilityUnavailableError(
          "lldb",
          "lldb_command",
          errorMessage(cause),
        ),
      );
    } finally {
      if (acquired) {
        session.pendingCommandCount -= 1;
        release?.();
      } else {
        void previous.then(() => {
          session.pendingCommandCount -= 1;
          release?.();
        });
      }
    }
  }

  async #executeInTurn(
    session: ActiveSession,
    sessionId: string,
    command: string,
    signal?: AbortSignal,
  ): Promise<
    Result<
      { readonly result: LldbCommandResult; readonly evidence: Evidence },
      AnalysisError
    >
  > {
    if (session.closed || session.closing) {
      return err(
        new AnalysisInputError("lldb_command", undefined, [
          {
            path: ["session_id"],
            reason: "invalid_value",
            message: "LLDB session was closed while queued.",
          },
        ]),
      );
    }
    const timeoutMs = this.#commandTimeoutMs;
    const rpcTimeoutMs = Math.min(timeoutMs + 5000, MAX_NODE_TIMER_DELAY_MS);
    const res = await this.#sendSessionRpc(
      commandResponseSchema,
      session,
      "command",
      { command, timeout: timeoutMs / 1000 },
      rpcTimeoutMs,
      signal,
      "lldb_command",
    );

    if (res.process_state) {
      session.processState = res.process_state;
    }
    if (res.pid !== undefined) {
      session.pid = res.pid;
    }
    if (res.target !== undefined) {
      session.target = res.target;
    }

    const cmdResult: LldbCommandResult = {
      command,
      output: res.output ?? "",
      ...(res.process_state !== undefined
        ? { process_state: res.process_state }
        : {}),
      output_truncated: res.output_truncated ?? false,
      completion_status: res.completion_status ?? "complete",
    };

    const { provenance, unobservedReason } = session.launchFile;
    const evidence = createEvidence(
      lldbSessionSubject(session),
      LLDB_PROVIDER_IDENTITY,
      {
        predicateType: "rea.debugger.console-observation",
        operation: "lldb_command",
        parameters: {
          session_id: sessionId,
          command,
          ...(provenance === undefined
            ? {}
            : {
                ...(provenance.caller_selected_path !== undefined
                  ? { path: provenance.caller_selected_path }
                  : {}),
                ...(provenance.args !== undefined
                  ? { args: [...provenance.args] }
                  : {}),
                ...(provenance.env !== undefined
                  ? { env: { ...provenance.env } }
                  : {}),
                launch_provenance: { ...provenance },
              }),
        },
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
        limitations: [
          "LLDB commands run unrestricted against the local target inferior and host runtime.",
          "The session target is the initial file selected and hashed before loading; later debugger commands do not rebind it or establish the current inferior's identity.",
          ...(unobservedReason === undefined
            ? []
            : [
                `The launch file could not be hashed at session start, so the session target is unknown: ${unobservedReason}`,
              ]),
        ],
      },
    );

    if (signal?.aborted) {
      throw cancelledBy("lldb_command", signal, {
        partialObservation: evidence,
      });
    }

    return ok({ result: cmdResult, evidence });
  }

  async status(sessionId: string): Promise<LldbStatusResult | undefined> {
    const session = this.#sessions.get(sessionId);
    if (!session) return undefined;

    if (!session.closed) {
      try {
        const res = await this.#sendSessionRpc(
          statusResponseSchema,
          session,
          "status",
          {},
          3000,
          undefined,
          "lldb_session_status",
        );
        if (res) {
          if (res.process_state !== undefined)
            session.processState = res.process_state;
          if (res.pid !== undefined) session.pid = res.pid;
          if (res.target !== undefined) session.target = res.target;
        }
      } catch {
        // Fall back to cached session values if status query times out
      }
    }

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
    signal?: AbortSignal,
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

    if (signal?.aborted) return err(cancelledBy("close_lldb_session", signal));

    const previous = session.commandTail;
    let release: (() => void) | undefined;
    session.commandTail = new Promise<void>((resolve) => {
      release = resolve;
    });

    try {
      await waitForLldbCommandTurn(previous, signal, "close_lldb_session");

      session.closing = true;
      session.closeRequested = true;

      const stopResult = await this.#sessions.stop(session);
      if (stopResult.status === "incomplete" || session.targetStateUnknown) {
        return err(
          this.#sessions.retainCleanupFailure(
            session,
            "close_lldb_session",
            stopResult.status === "incomplete"
              ? stopResult
              : {
                  code: "detach-failed",
                  reason: "LLDB target cleanup could not be confirmed.",
                },
          ),
        );
      }

      session.closed = true;
      session.state = "closed";
      session.rl.close();
      session.supervisor.dispose();
      this.#sessions.remove(session);

      if (signal?.aborted) {
        return err(cancelledBy("close_lldb_session", signal));
      }

      return ok({ target_state: session.lastObservedTargetState });
    } finally {
      release?.();
    }
  }

  async closeAll(): Promise<void> {
    await this.#sessions.closeAll();
    await this.#startupResources.close();
  }

  async retryCleanupFailures(): Promise<Result<null, AnalysisError>> {
    const files = await this.#retryStartupFileCleanup();
    if (!files.ok) return files;
    return this.#sessions.retryCleanupFailures(
      (session) => !session.closeRequested,
    );
  }

  async #sendSessionRpc<T>(
    schema: z.ZodType<T>,
    session: ActiveSession,
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
    operation: string = method,
  ): Promise<T> {
    if (signal?.aborted) {
      throw cancelledBy(operation, signal);
    }

    const raw = await new Promise<unknown>((resolve, reject) => {
      const child = session.launched.process;
      if (session.closed || !child.stdin?.writable) {
        return reject(new Error("LLDB session is closed."));
      }

      const reqId = session.nextId++;
      let onAbort: (() => void) | undefined;

      const timer = setTimeout(
        () => {
          session.pending.delete(reqId);
          if (onAbort !== undefined && signal !== undefined) {
            signal.removeEventListener("abort", onAbort);
          }
          reject(new AnalysisTimeoutError(operation, timeoutMs));
        },
        Math.min(timeoutMs, MAX_NODE_TIMER_DELAY_MS),
      );
      timer.unref();

      const rpcResolve = (value: unknown) => {
        clearTimeout(timer);
        if (onAbort !== undefined && signal !== undefined) {
          signal.removeEventListener("abort", onAbort);
        }
        resolve(value);
      };

      const rpcReject = (error: Error) => {
        clearTimeout(timer);
        if (onAbort !== undefined && signal !== undefined) {
          signal.removeEventListener("abort", onAbort);
        }
        reject(error);
      };

      if (signal !== undefined) {
        onAbort = () => {
          session.pending.delete(reqId);
          clearTimeout(timer);
          try {
            session.child.kill("SIGINT");
          } catch {}
          reject(cancelledBy(operation, signal));
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }

      session.pending.set(reqId, {
        resolve: rpcResolve,
        reject: rpcReject,
        timer,
      });

      const payload = JSON.stringify({
        jsonrpc: "2.0",
        id: reqId,
        method,
        params,
      });

      try {
        child.stdin.write(payload + "\n", (err) => {
          if (err) {
            session.pending.delete(reqId);
            clearTimeout(timer);
            if (onAbort !== undefined && signal !== undefined) {
              signal.removeEventListener("abort", onAbort);
            }
            reject(err);
          }
        });
      } catch (err) {
        session.pending.delete(reqId);
        clearTimeout(timer);
        if (onAbort !== undefined && signal !== undefined) {
          signal.removeEventListener("abort", onAbort);
        }
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });

    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new AnalysisCapabilityUnavailableError(
        "lldb",
        operation,
        `Invalid or malformed RPC reply from LLDB daemon: ${parsed.error.message}`,
        {
          diagnostics: {
            method,
            operation,
            raw: typeof raw === "object" ? JSON.stringify(raw) : String(raw),
          },
        },
      );
    }
    return parsed.data;
  }
}
