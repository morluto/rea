import { RIZIN_DEBUGGER_PROVIDER_IDENTITY } from "./RizinDebuggerProviderIdentity.js";
import { persistentDebuggerHostSupported } from "../process/PersistentDebuggerHost.js";
import { randomUUID } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { open, readlink, realpath, stat } from "node:fs/promises";
import { constants as fsConstants, type Stats } from "node:fs";
import { isatty } from "node:tty";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { AnalysisCleanupLease } from "../artifacts/AnalysisCleanupLease.js";
import { bindArtifactFileCleanup } from "../artifacts/ArtifactFileOperation.js";
import { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import {
  RegularFileCleanupFailure,
  regularFileCancellation,
  withOwnedFileHandle,
} from "../filesystem/OwnedRegularFile.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";

import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisTimeoutError,
} from "../domain/analysisErrorCore.js";
import {
  RIZIN_DEBUG_SESSION_TOOLS,
  stoppedDebuggerSessionError,
  unknownDebuggerSessionError,
} from "../domain/debuggerSessionErrors.js";
import type {
  AnalysisError,
  AnalysisErrorOptions,
} from "../domain/analysisErrorBase.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { createEvidence, type Evidence } from "../domain/evidence.js";
import { currentAnalysisOperationSnapshot } from "../domain/analysisOperationSnapshot.js";
import { err, ok, type Result } from "../domain/result.js";
import { ConfigurationError } from "../domain/configurationErrors.js";
import {
  ProviderProcessSupervisor,
  spawnOwnedProviderProcess,
  type SpawnedOwnedProviderProcess,
} from "../process/ProviderProcess.js";
import {
  debuggerControlReplyOutput,
  debuggerConstructionLimits,
  parseDebuggerCommandDeadline,
  parseDebuggerCommandOutput,
  type DebuggerAdmissionLimit,
} from "../config/debuggerSessionLimits.js";
import {
  closeOwnedDebuggerSessions,
  configurableDeadlineGuidance,
  debuggerAdmissionRecovery,
  debuggerResourceConstraintError,
  fixedDeadlineGuidance,
  stopOwnedDebuggerProcess,
  readLinuxProcessStartTime,
  verifyOwnedInferiorsEnded,
  type OwnedInferiorIdentity,
  type OwnedDebuggerDetachResult,
} from "../process/ownedDebuggerSession.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import { ABORTED, waitForAbortable } from "../process/AbortablePromise.js";

const CLEANUP_COMMAND_TIMEOUT_MS = 1_000;
const STARTUP_TIMEOUT_MS = 30_000;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_QUEUED_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_QUEUED_FRAMES = 4096;
const MIN_QUEUED_FRAME_CHARGE_BYTES = 64;
const MAX_COMMAND_FRAMES = 4096;
const MAX_RECENT_FRAME_BYTES = 16 * 1024;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;

interface RizinLaunchProvenance {
  readonly caller_selected_path: string;
  readonly resolved_path: string;
}

const RIZIN_LAUNCH_PROVENANCE_LIMITATION =
  "Launch provenance records the original and resolved startup paths; it does not establish the current target after unrestricted debugger commands.";

interface RizinCommandEvidenceInput {
  readonly sessionId: string;
  readonly command: string;
  readonly result: RizinDebugCommandResult;
  readonly inferiorTty: string;
  readonly launchProvenance: RizinLaunchProvenance;
  readonly limitations: readonly string[];
}

const createRizinCommandEvidence = ({
  sessionId,
  command,
  result,
  inferiorTty,
  launchProvenance,
  limitations,
}: RizinCommandEvidenceInput): Evidence =>
  createEvidence(undefined, RIZIN_DEBUGGER_PROVIDER_IDENTITY, {
    predicateType: "rea.debugger.command-observation",
    operation: "rizin_debug_command",
    parameters: {
      session_id: sessionId,
      command,
      inferior_tty: inferiorTty,
      launch_provenance: { ...launchProvenance },
    },
    result: { ...result },
    rawResult: { ...result },
    subjectUnavailableReason:
      "The current debugger target identity is not established by the Rizin session identifier.",
    limitations: [
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
  });

type RizinOutputLimit =
  | "command_output_bytes"
  | "frame_bytes"
  | "command_frames"
  | "queued_frames";

interface RizinCommandCapture {
  readonly output: string;
  readonly outputTruncated: boolean;
  readonly outputInvalidUtf8: boolean;
  /** Cap that first stopped this capture. Absent when output is complete. */
  readonly outputLimit?: RizinOutputLimit;
}

interface RizinCommandInterruption {
  readonly kind: "cancelled" | "exited" | "timeout" | "failed";
  readonly cause: unknown;
  readonly capture: RizinCommandCapture;
}

interface RizinCommandTimeoutEvidenceInput {
  readonly sessionId: string;
  readonly command: string;
  readonly result: RizinDebugCommandResult;
  readonly inferiorTty: string;
  readonly cleanupFailure: string | undefined;
  readonly launchProvenance: RizinLaunchProvenance;
  readonly deadline: DebuggerAdmissionLimit;
}

const rizinCommandTimeoutLimitation = (
  deadline: DebuggerAdmissionLimit,
): string =>
  `The command timed out before its completion marker at ${String(deadline.value)} ms (deadlineExpired). ${debuggerAdmissionRecovery(deadline)} Retained output is partial and completion is unknown.`;

const createRizinCommandTimeoutEvidence = ({
  sessionId,
  command,
  result,
  inferiorTty,
  cleanupFailure,
  launchProvenance,
  deadline,
}: RizinCommandTimeoutEvidenceInput): Evidence =>
  createRizinCommandEvidence({
    sessionId,
    command,
    result,
    inferiorTty,
    launchProvenance,
    limitations: [
      rizinCommandTimeoutLimitation(deadline),
      ...(result.output_invalid_utf8
        ? [
            "Collected command frame bytes did not form valid UTF-8; displayed output contains replacement characters.",
          ]
        : []),
      ...(cleanupFailure === undefined
        ? [
            "The owned debugger session was stopped because output correlation could no longer be guaranteed.",
          ]
        : [
            `The owned debugger session remains retained because cleanup could not be verified: ${cleanupFailure}`,
          ]),
      "The command is unrestricted and may access local files, the shell, network, or mutate the target.",
    ],
  });

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
  readonly launchProvenance: RizinLaunchProvenance;
  readonly inferiorTty: string;
  readonly inferiorTtyDevice: number;
  readonly inferiorTtyInode: number;
  readonly knownInferiorIdentities: Map<string, OwnedInferiorIdentity>;
  inferiorInventoryComplete: boolean;
  inferiorStateUnknown: () => boolean;
  verifyInferiorsEndedAfterExit: () => Promise<boolean>;
  readonly detachInferior: () => Promise<OwnedDebuggerDetachResult>;
  cleanupCommandTurnHeld: boolean;
  stopAttempt: ReturnType<typeof stopOwnedDebuggerProcess> | undefined;
  readonly cleanupFailures: Set<AnalysisError>;
  pendingCommandCount: number;
  invalidUtf8Observed: boolean;
  closing: boolean;
  readonly history: string[];
  queuedFrameBytes: number;
  historyTruncated: boolean;
  frameChunks: Buffer[];
  bufferedFrameBytes: number;
  ready: boolean;
  /** start returned this session's ID, so the caller must close it. */
  published: boolean;
  closeRequested: boolean;
  exited: boolean;
  commandTail: Promise<void>;
  protocolError: string | undefined;
  /**
   * Why the session stopped accepting commands. Cleanup synchronization
   * clears protocolError once the transport is correlated again, but the
   * session stays stopped, so the diagnosis is retained here.
   */
  stopReason: string | undefined;
  cleanupSynchronization:
    | {
        readonly marker: string;
        readonly resolve: () => void;
        readonly reject: (cause: Error) => void;
      }
    | undefined;
  commandCaptureActive: boolean;
  commandOutputDropped: boolean;
  discardingOversizedFrame: boolean;
}

interface RizinFrame {
  readonly text: string;
  readonly truncated: boolean;
  readonly invalidUtf8: boolean;
}

class RizinProcessExitError extends Error {
  constructor(message = "Rizin exited before completing the active command") {
    super(message);
  }
}

class RizinFrameTimeoutError extends Error {
  constructor() {
    super("Timed out waiting for the next Rizin NUL frame");
  }
}

/** Owns persistent Rizin debugger processes independently from BinarySession. */
export class RizinDebugSessionManager {
  readonly #sessions = new Map<string, RizinDebugSession>();
  readonly #ttyResources = new ArtifactResourceScope();
  #activeStarts = 0;
  #sessionReservations = 0;
  readonly #environment: Readonly<NodeJS.ProcessEnv>;
  #closingAll = false;
  readonly #startDrainWaiters: Array<() => void> = [];
  readonly #command: string;
  readonly #launchCommandDeadline: DebuggerAdmissionLimit;
  readonly #startupTimeoutMs: number;
  readonly #maxSessions: DebuggerAdmissionLimit;
  readonly #maxPendingCommands: DebuggerAdmissionLimit;
  readonly #launchCommandOutput: DebuggerAdmissionLimit;
  readonly #platform: NodeJS.Platform;
  readonly #stopProcess: typeof stopOwnedDebuggerProcess;
  readonly #spawnProcess: typeof spawnOwnedProviderProcess;

  constructor(
    environment: Readonly<NodeJS.ProcessEnv> = process.env,
    options: {
      /** @internal Test seam; production callers should use the 30 s default. */
      readonly startupTimeoutMs?: number;
      readonly platform?: NodeJS.Platform;
      readonly stopProcess?: typeof stopOwnedDebuggerProcess;
      readonly spawnProcess?: typeof spawnOwnedProviderProcess;
    } = {},
  ) {
    this.#environment = { ...environment };
    this.#command = environment.REA_RIZIN_COMMAND ?? "rizin";
    const limits = debuggerConstructionLimits(this.#environment);
    this.#launchCommandDeadline = limits.commandDeadline;
    this.#startupTimeoutMs = options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
    this.#maxSessions = limits.maxSessions;
    this.#maxPendingCommands = limits.maxPendingCommands;
    this.#launchCommandOutput = limits.maxCommandOutputBytes;
    this.#platform = options.platform ?? process.platform;
    this.#stopProcess = options.stopProcess ?? stopOwnedDebuggerProcess;
    this.#spawnProcess = options.spawnProcess ?? spawnOwnedProviderProcess;
  }

  get #commandDeadline(): DebuggerAdmissionLimit {
    const override =
      currentAnalysisOperationSnapshot()?.overrides[
        "debugger.command_deadline_ms"
      ];
    if (override !== undefined)
      return {
        ...this.#launchCommandDeadline,
        value: override,
        source: "runtime",
      };
    const parsed = parseDebuggerCommandDeadline(this.#environment);
    if (!parsed.ok) throw parsed.error;
    return parsed.value;
  }
  get #frameTimeoutMs(): number {
    return this.#commandDeadline.value;
  }
  get #commandOutput(): DebuggerAdmissionLimit {
    const override =
      currentAnalysisOperationSnapshot()?.overrides[
        "debugger.max_command_output_bytes"
      ];
    if (override !== undefined)
      return {
        ...this.#launchCommandOutput,
        value: override,
        source: "runtime",
      };
    const parsed = parseDebuggerCommandOutput(this.#environment);
    if (!parsed.ok) throw parsed.error;
    return parsed.value;
  }

  async start(
    input: {
      readonly path: string;
      readonly inferior_tty: string;
      readonly backend?: string;
    },
    signal?: AbortSignal,
  ): Promise<
    Result<
      { readonly session_id: string; readonly backend: string | null },
      AnalysisError
    >
  > {
    if (this.#closingAll)
      return err(
        new AnalysisInputError("start_rizin_debug_session", undefined, [
          {
            path: ["inferior_tty"],
            reason: "missing_argument",
            message:
              "Select a persistent readable and writable Linux terminal for inferior input and output.",
          },
        ]),
      );
    const occupied = this.#sessions.size + this.#sessionReservations;
    if (occupied >= this.#maxSessions.value)
      return err(
        debuggerResourceConstraintError(
          "start_rizin_debug_session",
          "memory",
          `Rizin session capacity reached (${String(this.#maxSessions.value)} sessions).`,
          "Close a Rizin debug session before starting another; a stopped session that rizin_debug_session_status reports closed still holds its slot until close_rizin_debug_session releases it.",
          this.#maxSessions,
          {
            max_sessions: this.#maxSessions.value,
            active_or_reserved_sessions: occupied,
          },
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
    input: {
      readonly path: string;
      readonly inferior_tty: string;
      readonly backend?: string;
    },
    signal: AbortSignal | undefined,
    releaseReservation: () => void,
  ): Promise<
    Result<
      { readonly session_id: string; readonly backend: string | null },
      AnalysisError
    >
  > {
    if (signal?.aborted)
      return err(rizinCancellation("start_rizin_debug_session", signal));
    if (!persistentDebuggerHostSupported(this.#platform))
      return err(
        new AnalysisCapabilityUnavailableError(
          "rizin",
          "start_rizin_debug_session",
          "Persistent Rizin debugger sessions require Linux /proc descriptor readback to verify inferior detachment and output routing.",
        ),
      );
    if (input.inferior_tty === undefined || input.inferior_tty.length === 0)
      return err(new AnalysisInputError("start_rizin_debug_session"));
    let ttyPath: string;
    let ttyDevice: number;
    let ttyInode: number;
    let ttyLease: AnalysisCleanupLease | undefined;
    try {
      await this.#ttyResources.retryCleanup();
    } catch (cause: unknown) {
      const cleanup = new ProviderCleanupError(
        "rizin",
        this.#ttyResources.cleanupResources,
        {},
        { operation: "start_rizin_debug_session", cause },
      );
      bindArtifactFileCleanup(cause, cleanup);
      return err(cleanup);
    }
    try {
      ttyPath = await realpath(input.inferior_tty);
      const ttyHandle = await open(
        ttyPath,
        fsConstants.O_RDWR | fsConstants.O_NOCTTY | fsConstants.O_NONBLOCK,
      );
      const tty = await withOwnedFileHandle(
        ttyPath,
        new OwnedFileHandle(ttyHandle),
        {
          ...(signal === undefined ? {} : { signal }),
          retainFailedClose: (owner) => {
            ttyLease = new AnalysisCleanupLease(() => owner.close(), [ttyPath]);
            this.#ttyResources.retain({
              kind: "lease",
              resource: ttyPath,
              lease: ttyLease,
            });
          },
        },
        async (handle) => {
          const ttyStat = await handle.stat();
          if (
            !isatty(handle.fd) ||
            (ttyStat.mode & fsConstants.S_IFMT) !== fsConstants.S_IFCHR
          )
            throw new Error(
              "The selected inferior_tty is not a character TTY.",
            );
          return { device: ttyStat.dev, inode: ttyStat.ino };
        },
      );
      ttyDevice = tty.device;
      ttyInode = tty.inode;
    } catch (cause) {
      const primaryCause =
        cause instanceof RegularFileCleanupFailure &&
        cause.outcome.kind === "failed"
          ? cause.outcome.cause
          : cause;
      const cancellation = regularFileCancellation(cause);
      const primary =
        cancellation === undefined
          ? new AnalysisInputError(
              "start_rizin_debug_session",
              {
                cause: primaryCause,
                diagnostics: { inferior_tty: input.inferior_tty },
              },
              [
                {
                  path: ["inferior_tty"],
                  reason: "invalid_value",
                  message: `Cannot use selected terminal ${input.inferior_tty}: ${primaryCause instanceof Error ? primaryCause.message : String(primaryCause)}`,
                },
              ],
            )
          : rizinCancellation(
              "start_rizin_debug_session",
              undefined,
              cancellation.reason,
            );
      if (!(cause instanceof RegularFileCleanupFailure)) return err(primary);
      const cleanup = new ProviderCleanupError(
        "rizin",
        [ttyPath!],
        {},
        { operation: "start_rizin_debug_session", cause: cause.cleanupCause },
      );
      const error =
        cause.outcome.kind === "failed" || cancellation !== undefined
          ? analysisErrorWithCleanupFailure(
              primary,
              cleanup,
              "start_rizin_debug_session",
            )
          : cleanup;
      ttyLease?.bindCleanupError(cleanup);
      if (error !== cleanup) ttyLease?.bindCleanupError(error);
      return err(error);
    }
    // TTY identity validation is asynchronous. Cancellation may arrive while
    // realpath/open/stat are pending, and must prevent the debugger spawn.
    if (signal?.aborted)
      return err(rizinCancellation("start_rizin_debug_session", signal));
    const id = randomUUID();
    const resolvedPath = absoluteCallerPath(input.path);
    const launchProvenance: RizinLaunchProvenance = {
      caller_selected_path: input.path,
      resolved_path: resolvedPath,
    };
    const arguments_ = [
      "-N",
      "-0",
      "-d",
      // Rizin reads REA's commands from its own stdin. Without this key the
      // target inherits that stream and, once resumed, reads those commands.
      "-R",
      `stdin=${ttyPath}`,
      "-R",
      `stdout=${ttyPath}`,
      "-R",
      `stderr=${ttyPath}`,
      "-e",
      "dbg.exitkills=false",
      ...(input.backend === undefined ? [] : ["-D", input.backend]),
      resolvedPath,
    ];
    let launched: SpawnedOwnedProviderProcess;
    try {
      launched = await this.#spawnProcess({
        command: this.#command,
        arguments: arguments_,
        hostEnvironment: this.#environment,
        runId: id,
        stdin: "pipe",
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (cause) {
      if (signal?.aborted)
        return err(
          rizinCancellation("start_rizin_debug_session", signal, cause),
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
      launchProvenance,
      backend: input.backend ?? null,
      inferiorTty: ttyPath,
      inferiorTtyDevice: ttyDevice,
      inferiorTtyInode: ttyInode,
      knownInferiorIdentities: new Map(),
      inferiorInventoryComplete: false,
      inferiorStateUnknown: () => !session.inferiorInventoryComplete,
      verifyInferiorsEndedAfterExit: async () => {
        if (!session.inferiorInventoryComplete) return false;
        const ended = await verifyOwnedInferiorsEnded(
          session.knownInferiorIdentities.values(),
        );
        if (ended) session.knownInferiorIdentities.clear();
        return ended;
      },
      detachInferior: () =>
        session.cleanupCommandTurnHeld
          ? this.#detachInferiorUnlocked(session)
          : this.#detachInferior(session),
      cleanupCommandTurnHeld: false,
      stopAttempt: undefined,
      cleanupFailures: new Set(),
      pendingCommandCount: 0,
      invalidUtf8Observed: false,
      closing: false,
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
      frameChunks: [],
      bufferedFrameBytes: 0,
      ready: false,
      published: false,
      closeRequested: false,
      exited: false,
      commandTail: Promise.resolve(),
      protocolError: undefined,
      stopReason: undefined,
      cleanupSynchronization: undefined,
      commandCaptureActive: false,
      commandOutputDropped: false,
      discardingOversizedFrame: false,
    };
    this.#sessions.set(id, session);
    releaseReservation();
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
      session.cleanupSynchronization?.reject(new RizinProcessExitError());
      for (const waiter of session.frameWaiters)
        waiter.reject(new RizinProcessExitError());
      session.frameWaiters.length = 0;
    });
    try {
      await waitForFrame(session, this.#startupTimeoutMs, signal);
      // Let process and stream lifecycle notifications queued alongside the
      // initial frame run before publishing the session as ready.
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (signal?.aborted)
        throw rizinCancellation("start_rizin_debug_session", signal);
      if (session.exited)
        throw new RizinProcessExitError("Rizin exited during startup.");
      if (session.protocolError !== undefined)
        throw new Error(session.protocolError);
      session.ready = true;
      session.published = true;
      return ok({ session_id: id, backend: input.backend ?? null });
    } catch (caught) {
      const protocolFailure = session.protocolError;
      const cancellation =
        signal?.aborted || caught instanceof AnalysisCancelledError
          ? rizinCancellation("start_rizin_debug_session", signal, caught)
          : undefined;
      const stopped = await this.#stopDebuggerOnly(session);
      const capturedOutput = this.#startupCapturedOutput(session);
      if (stopped.status !== "incomplete") this.#sessions.delete(id);
      let primary: AnalysisError;
      if (cancellation !== undefined)
        primary = rizinCancellation(
          "start_rizin_debug_session",
          undefined,
          cancellation,
          { capturedOutput },
        );
      else if (protocolFailure !== undefined)
        primary = new AnalysisCapabilityUnavailableError(
          "rizin",
          "start_rizin_debug_session",
          protocolFailure,
          { cause: caught, capturedOutput },
        );
      else if (caught instanceof RizinProcessExitError)
        primary = new AnalysisCapabilityUnavailableError(
          "rizin",
          "start_rizin_debug_session",
          caught.message,
          { cause: caught, capturedOutput },
        );
      else
        primary = new AnalysisTimeoutError(
          "start_rizin_debug_session",
          this.#startupTimeoutMs,
          {
            cause: caught,
            capturedOutput,
            ...fixedDeadlineGuidance(
              "Rizin debug session startup",
              this.#startupTimeoutMs,
            ),
          },
        );
      return err(
        this.#finalizeFailure(
          session,
          "start_rizin_debug_session",
          primary,
          stopped,
          signal,
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
    if (session === undefined)
      return err(
        unknownDebuggerSessionError(
          RIZIN_DEBUG_SESSION_TOOLS,
          "rizin_debug_command",
        ),
      );
    const stopped = this.#stopReason(session);
    if (stopped !== undefined)
      return err(
        stoppedDebuggerSessionError(
          RIZIN_DEBUG_SESSION_TOOLS,
          "rizin_debug_command",
          stopped,
        ),
      );
    if (signal?.aborted)
      return err(rizinCancellation("rizin_debug_command", signal));
    if (session.pendingCommandCount >= this.#maxPendingCommands.value)
      return err(
        debuggerResourceConstraintError(
          "rizin_debug_command",
          "transport",
          `Rizin command queue capacity reached (${String(this.#maxPendingCommands.value)} pending commands).`,
          "Wait for a Rizin debug command on this session to finish, then retry.",
          this.#maxPendingCommands,
          {
            max_pending_commands: this.#maxPendingCommands.value,
            active_or_queued_commands: session.pendingCommandCount,
          },
        ),
      );
    let acceptedDeadline: DebuggerAdmissionLimit;
    let acceptedOutput: DebuggerAdmissionLimit;
    try {
      acceptedDeadline = this.#commandDeadline;
      acceptedOutput = this.#commandOutput;
    } catch (cause: unknown) {
      if (cause instanceof ConfigurationError) return err(cause);
      throw cause;
    }
    session.pendingCommandCount += 1;
    let release: (() => void) | undefined;
    let acquired = false;
    let commandSent = false;
    let commandCapture: RizinCommandCapture | undefined;
    let interruption: RizinCommandInterruption | undefined;
    const commandResult = (
      capture: RizinCommandCapture,
      completion: "complete" | "unknown",
    ): RizinDebugCommandResult => ({
      command,
      output: capture.output,
      output_scope: "command_and_interleaved_session_output",
      output_truncated: capture.outputTruncated,
      completion_status: completion,
      backend: session.backend,
      ...(capture.outputInvalidUtf8
        ? { output_invalid_utf8: true as const }
        : {}),
    });
    const previous = session.commandTail;
    session.commandTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await waitForTurn(previous, signal);
      acquired = true;
      if (signal?.aborted)
        return err(rizinCancellation("rizin_debug_command", signal));
      const stoppedWhileQueued = this.#stopReason(session);
      if (stoppedWhileQueued !== undefined)
        return err(
          stoppedDebuggerSessionError(
            RIZIN_DEBUG_SESSION_TOOLS,
            "rizin_debug_command",
            stoppedWhileQueued,
          ),
        );
      if (hasUnclaimedRizinFrames(session)) {
        const message =
          "Unsolicited Rizin frames arrived before a command; command output can no longer be safely correlated.";
        this.#failProtocol(session, message);
        return err(
          await this.#stopAfterProtocolFailure(session, message, undefined, {
            signal,
            commandTurnHeld: true,
          }),
        );
      }
      const marker = `__REA_COMMAND_COMPLETE_${randomUUID().replaceAll("-", "")}__`;
      // Arbitrary debugger commands can create or replace inferiors. Discard
      // the prior inventory before any command bytes reach the provider.
      session.inferiorInventoryComplete = false;
      session.knownInferiorIdentities.clear();
      commandSent = true;
      session.commandCaptureActive = true;
      session.commandOutputDropped = false;
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
      const received = await waitForCommandFrames(
        session,
        marker,
        acceptedDeadline.value,
        acceptedOutput,
        signal,
      );
      commandCapture = received.ok ? received.value : received.error.capture;
      if (!received.ok) {
        interruption = received.error;
        throw interruption.cause;
      }
      const captured = received.value;
      if (signal?.aborted)
        throw rizinCancellation("rizin_debug_command", signal);
      let stopped: Awaited<ReturnType<typeof stopOwnedDebuggerProcess>> = {
        status: "stopped",
      };
      let cleanupFailure: string | undefined;
      if (captured.outputTruncated) {
        stopped = await this.#stopDebuggerOnly(session, true);
        if (stopped.status === "incomplete") cleanupFailure = stopped.reason;
      }
      const result = commandResult(
        captured,
        captured.outputTruncated ? "unknown" : "complete",
      );
      const evidence = createRizinCommandEvidence({
        sessionId,
        command,
        result,
        inferiorTty: session.inferiorTty,
        launchProvenance: session.launchProvenance,
        limitations: [
          "Rizin commands and debugger effects depend on the loaded IO plugin and target.",
          "Output contains all NUL frames through an explicit command-completion marker; backend output interleaved before that marker cannot be distinguished from command output.",
          ...(captured.outputTruncated
            ? [
                rizinCaptureStoppedSentence(
                  captured.outputLimit,
                  acceptedOutput,
                  cleanupFailure,
                ),
              ]
            : []),
          "The command is unrestricted and may access local files, the shell, network, or mutate the target.",
        ],
      });
      return this.#finalizeCommandObservation(
        session,
        { result, evidence },
        stopped,
        signal,
      );
    } catch (cause) {
      // Capture is owned by this dispatched command, independently of which
      // cancellation, protocol or cleanup outcome ultimately takes precedence.
      const partialResult =
        commandCapture === undefined
          ? undefined
          : commandResult(commandCapture, "unknown");
      const capturedOutput =
        commandCapture === undefined
          ? undefined
          : {
              stdout: commandCapture.output,
              stderr: "",
              truncated: commandCapture.outputTruncated,
            };
      const partialEvidence = (
        limitations: readonly string[],
      ): Evidence | undefined =>
        partialResult === undefined
          ? undefined
          : createRizinCommandEvidence({
              sessionId,
              command,
              result: partialResult,
              inferiorTty: session.inferiorTty,
              launchProvenance: session.launchProvenance,
              limitations,
            });
      if (signal?.aborted || cause instanceof AnalysisCancelledError) {
        if (!commandSent)
          return err(rizinCancellation("rizin_debug_command", signal, cause));
        const evidence = partialEvidence([
          "The Rizin command was cancelled; collected frame output is partial and command completion is unknown.",
          "The owned debugger session was stopped because command output can no longer be correlated safely.",
          "The command is unrestricted and may access local files, the shell, network, or mutate the target.",
        ]);
        session.protocolError =
          "A Rizin command was cancelled; the owned session was stopped because command output can no longer be correlated safely.";
        const primary = rizinCancellation(
          "rizin_debug_command",
          signal,
          cause,
          {
            ...(capturedOutput === undefined ? {} : { capturedOutput }),
            ...(evidence === undefined ? {} : { partialObservation: evidence }),
          },
        );
        const stopped = await this.#stopDebuggerOnly(session, true);
        return err(
          this.#finalizeFailure(
            session,
            "rizin_debug_command",
            primary,
            stopped,
            signal,
          ),
        );
      }
      if (session.protocolError !== undefined) {
        const evidence = partialEvidence([
          session.protocolError,
          "The Rizin protocol failed; retained command output is partial and completion is unknown.",
          "The command is unrestricted and may access local files, the shell, network, or mutate the target.",
        ]);
        return err(
          await this.#stopAfterProtocolFailure(
            session,
            session.protocolError,
            cause,
            {
              commandTurnHeld: true,
              signal,
              ...(evidence === undefined
                ? {}
                : { partialObservation: evidence }),
            },
          ),
        );
      }
      if (interruption?.kind === "timeout") {
        session.protocolError = `Rizin command timed out before its completion marker at ${String(acceptedDeadline.value)} ms (deadlineExpired). ${debuggerAdmissionRecovery(acceptedDeadline)} Output correlation is no longer safe.`;
        const stopped = await this.#stopDebuggerOnly(session, true);
        const result = {
          ...commandResult(interruption.capture, "unknown"),
          output_truncated: true,
        };
        const evidence = createRizinCommandTimeoutEvidence({
          sessionId,
          command,
          result,
          inferiorTty: session.inferiorTty,
          deadline: acceptedDeadline,
          cleanupFailure:
            stopped.status === "incomplete" ? stopped.reason : undefined,
          launchProvenance: session.launchProvenance,
        });
        return this.#finalizeCommandObservation(
          session,
          { result, evidence },
          stopped,
          signal,
        );
      }
      if (interruption?.kind === "exited") {
        const result = commandResult(interruption.capture, "unknown");
        const evidence = createRizinCommandEvidence({
          sessionId,
          command,
          result,
          inferiorTty: session.inferiorTty,
          launchProvenance: session.launchProvenance,
          limitations: [
            "Rizin exited before the command-completion marker; retained frame output is partial and command completion is unknown.",
            "The command is unrestricted and may access local files, the shell, network, or mutate the target.",
          ],
        });
        const stopped = await this.#stopDebuggerOnly(session, true);
        return this.#finalizeCommandObservation(
          session,
          { result, evidence },
          stopped,
          signal,
        );
      }
      session.protocolError =
        "Rizin did not return the current command-completion marker; the session was stopped to prevent late output from being attributed to a later command.";
      const evidence = partialEvidence([
        session.protocolError,
        "The command is unrestricted and may access local files, the shell, network, or mutate the target.",
      ]);
      const errorOptions = {
        cause,
        ...(evidence === undefined ? {} : { partialObservation: evidence }),
      };
      const stopped = await this.#stopDebuggerOnly(session, true);
      const primary = new AnalysisTimeoutError(
        "rizin_debug_command",
        this.#frameTimeoutMs,
        {
          ...errorOptions,
          ...configurableDeadlineGuidance(
            "The Rizin debug command",
            acceptedDeadline,
          ),
        },
      );
      return err(
        this.#finalizeFailure(
          session,
          "rizin_debug_command",
          primary,
          stopped,
          signal,
        ),
      );
    } finally {
      if (acquired) {
        session.commandCaptureActive = false;
        session.pendingCommandCount -= 1;
        release?.();
      } else
        void previous.then(() => {
          session.pendingCommandCount -= 1;
          release?.();
        });
    }
  }

  status(sessionId: string):
    | {
        readonly session_id: string;
        readonly state: "ready" | "closed";
        readonly inferior_tty: string;
        readonly recent_output: readonly string[];
        readonly recent_output_truncated: boolean;
        readonly diagnostics_truncated: boolean;
        readonly output_invalid_utf8: boolean;
        readonly closed_reason?: string;
      }
    | undefined {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return undefined;
    const stopped = this.#stopReason(session);
    return {
      session_id: session.id,
      state: stopped === undefined ? "ready" : "closed",
      inferior_tty: session.inferiorTty,
      recent_output: [...session.history],
      recent_output_truncated: session.historyTruncated,
      diagnostics_truncated:
        session.supervisor.snapshot().diagnosticTruncated === true,
      output_invalid_utf8: session.invalidUtf8Observed,
      ...(stopped === undefined ? {} : { closed_reason: stopped }),
    };
  }

  /** Why a retained session accepts no commands, or undefined while it is ready. */
  #stopReason(session: RizinDebugSession): string | undefined {
    const diagnosed = session.stopReason ?? session.protocolError;
    if (diagnosed !== undefined) return diagnosed;
    if (this.#closingAll)
      return "REA is shutting down and closing every Rizin debug session.";
    if (session.closeRequested)
      return "close_rizin_debug_session started releasing this session, and its owned cleanup has not completed.";
    if (session.exited) {
      const { exitCode, signalCode } = session.launched.process;
      return `The Rizin process exited (exit code ${String(exitCode)}, signal ${String(signalCode)}); a command such as q, or a crash, can end it.`;
    }
    if (session.closing || !session.ready)
      return "REA stopped this Rizin debug session.";
    return undefined;
  }

  async close(
    sessionId: string,
  ): Promise<Result<{ readonly target_state: "unknown" }, AnalysisError>> {
    if (this.#closingAll)
      return err(new AnalysisInputError("close_rizin_debug_session"));
    const session = this.#sessions.get(sessionId);
    if (session === undefined)
      return err(
        unknownDebuggerSessionError(
          RIZIN_DEBUG_SESSION_TOOLS,
          "close_rizin_debug_session",
        ),
      );
    session.closeRequested = true;
    session.closing = true;
    const stopped = await this.#stopDebuggerOnly(session);
    if (stopped.status === "incomplete")
      return err(
        this.#retainCleanupFailure(
          session,
          "close_rizin_debug_session",
          stopped.reason,
        ),
      );
    this.#sessions.delete(sessionId);
    return ok({ target_state: "unknown" });
  }

  async retryCleanupFailures(): Promise<Result<null, AnalysisError>> {
    try {
      await this.#ttyResources.retryCleanup();
    } catch (cause: unknown) {
      const error = new ProviderCleanupError(
        "rizin",
        this.#ttyResources.cleanupResources,
        {},
        {
          operation: "start_rizin_debug_session",
          cause,
        },
      );
      bindArtifactFileCleanup(cause, error);
      return err(error);
    }
    for (const session of this.#sessions.values()) {
      if (session.cleanupFailures.size === 0) continue;
      const stopped = await this.#stopDebuggerOnly(session);
      if (stopped.status === "incomplete")
        return err(
          [...session.cleanupFailures].at(-1) ??
            this.#retainCleanupFailure(
              session,
              "close_rizin_debug_session",
              stopped.reason,
            ),
        );
      // The caller still holds a published session's ID; keep it addressable
      // so commands and status report why it stopped until it is closed.
      if (!session.published || session.closeRequested)
        this.#sessions.delete(session.id);
    }
    return ok(null);
  }

  async closeAll(): Promise<void> {
    this.#closingAll = true;
    if (this.#activeStarts > 0)
      await new Promise<void>((resolve) =>
        this.#startDrainWaiters.push(resolve),
      );
    for (const session of this.#sessions.values()) session.closing = true;
    const outcomes = await Promise.allSettled([
      closeOwnedDebuggerSessions(
        this.#sessions,
        (session) => this.#stopDebuggerOnly(session),
        "Rizin",
      ),
      this.#ttyResources.close(),
    ]);
    const failures = outcomes.flatMap((outcome) =>
      outcome.status === "rejected" ? [outcome.reason] : [],
    );
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(failures, "Rizin cleanup remains incomplete");
  }

  #receive(session: RizinDebugSession, chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length) {
      const boundary = chunk.indexOf(0, offset);
      const end = boundary < 0 ? chunk.length : boundary;
      const nextOffset = boundary + 1;
      if (boundary >= 0 && nextOffset <= offset) {
        this.#failProtocol(
          session,
          "Rizin frame parser failed to advance past a NUL delimiter.",
        );
        return;
      }
      const piece = chunk.subarray(offset, end);
      if (session.discardingOversizedFrame) {
        if (boundary < 0) return;
        session.discardingOversizedFrame = false;
        offset = nextOffset;
        continue;
      }
      if (session.bufferedFrameBytes + piece.length > MAX_FRAME_BYTES) {
        const message = `Rizin emitted a NUL frame exceeding the ${String(MAX_FRAME_BYTES)} byte (16 MiB) protocol limit. This release has no runtime override.`;
        if (
          !session.commandCaptureActive &&
          session.cleanupSynchronization === undefined
        ) {
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

  #deliverBufferedFrame(session: RizinDebugSession, truncated: boolean): void {
    const captured = bufferedRizinFrame(session, truncated);
    session.frameChunks = [];
    session.bufferedFrameBytes = 0;
    this.#deliverFrame(session, captured.frame, captured.bytes);
  }

  #startupCapturedOutput(session: RizinDebugSession) {
    const output = session.supervisor.snapshot();
    const partialFrame = bufferedRizinFrame(session, false).frame.text;
    const protocolOutput = [...session.history, partialFrame]
      .filter((frame) => frame.length > 0)
      .join("\n");
    const stdout = truncateUtf8(protocolOutput, MAX_DIAGNOSTIC_BYTES);
    return {
      stdout,
      stderr: output.stderr.text,
      truncated:
        session.historyTruncated ||
        protocolOutput.length > stdout.length ||
        output.diagnosticTruncated === true ||
        output.stdout.observedBytes > output.stdout.bytes ||
        output.stderr.observedBytes > output.stderr.bytes,
    };
  }

  #deliverFrame(
    session: RizinDebugSession,
    frame: RizinFrame,
    frameBytes: number,
  ): void {
    const synchronization = session.cleanupSynchronization;
    if (synchronization !== undefined) {
      // This fresh, private NUL-delimited echo closes the old command interval.
      // Earlier frames are discarded, never reused as inferior readback.
      if (
        !frame.truncated &&
        !frame.invalidUtf8 &&
        frame.text.trim() === synchronization.marker
      )
        synchronization.resolve();
      return;
    }
    const historyPrefix = truncateUtf8(frame.text, MAX_RECENT_FRAME_BYTES);
    const historyTruncated =
      historyPrefix.length < frame.text.length || frame.truncated;
    if (historyTruncated) session.historyTruncated = true;
    session.history.push(
      historyTruncated
        ? `${historyPrefix}[recent frame truncated]`
        : historyPrefix,
    );
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
      session.commandOutputDropped ||= session.commandCaptureActive;
      this.#failProtocol(
        session,
        `Rizin produced unsolicited frames exceeding the bounded queue limit of ${String(MAX_QUEUED_FRAMES)} frames or ${String(MAX_QUEUED_FRAME_BYTES)} bytes. This release has no runtime override.`,
      );
      return;
    }
    session.frames.push({ frame, queueChargeBytes });
    session.queuedFrameBytes += queueChargeBytes;
  }

  #failProtocol(session: RizinDebugSession, message: string): void {
    session.protocolError = message;
    session.cleanupSynchronization?.reject(new Error(message));
    if (!session.commandCaptureActive) {
      session.frameChunks = [];
      session.bufferedFrameBytes = 0;
    }
    for (const waiter of session.frameWaiters)
      waiter.reject(new Error(message));
    session.frameWaiters.length = 0;
  }

  #stopDebuggerOnly(session: RizinDebugSession, commandTurnHeld = false) {
    session.closing = true;
    if (session.stopAttempt !== undefined) return session.stopAttempt;
    session.cleanupCommandTurnHeld = commandTurnHeld;
    session.stopAttempt = Promise.resolve()
      .then(() =>
        this.#stopProcess(session, "Rizin debugger", {
          platform: this.#platform,
        }),
      )
      .catch((cause: unknown) => ({
        status: "incomplete" as const,
        reason: `Owned Rizin debugger shutdown failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      }))
      .then((stopped) => {
        if (stopped.status !== "incomplete") {
          for (const failure of session.cleanupFailures)
            failure.resolveCleanup();
          session.cleanupFailures.clear();
        }
        return stopped;
      })
      .finally(() => {
        session.stopAttempt = undefined;
      });
    return session.stopAttempt;
  }

  async #detachInferior(
    session: RizinDebugSession,
  ): Promise<OwnedDebuggerDetachResult> {
    if (session.exited)
      throw new Error("Rizin exited before inferior detach could be verified.");
    const previous = session.commandTail;
    let release!: () => void;
    session.commandTail = new Promise<void>((resolve) => (release = resolve));
    await previous;
    try {
      return await this.#detachInferiorUnlocked(session);
    } finally {
      release();
    }
  }

  async #detachInferiorUnlocked(
    session: RizinDebugSession,
  ): Promise<OwnedDebuggerDetachResult> {
    if (session.exited)
      throw new Error("Rizin exited before inferior detach could be verified.");
    if (session.protocolError !== undefined)
      await this.#synchronizeCleanup(session);
    session.inferiorInventoryComplete = false;
    session.knownInferiorIdentities.clear();
    const inferior = parseRizinPtraceRows(
      await this.#runInternalCommand(session, "olj"),
    );
    if (inferior.length === 0) {
      session.knownInferiorIdentities.clear();
      session.inferiorInventoryComplete = true;
      return { status: "no-inferior" };
    }
    session.knownInferiorIdentities.clear();
    for (const [, pid] of inferior) {
      if (session.knownInferiorIdentities.has(pid)) continue;
      const startTime = await readLinuxProcessStartTime(pid);
      if (startTime === null)
        throw new Error(
          `Inferior PID ${pid} ended before its identity could be established.`,
        );
      session.knownInferiorIdentities.set(pid, {
        pid,
        startTime,
      });
    }
    session.inferiorInventoryComplete = true;
    if (inferior.length !== 1)
      throw new Error("Rizin reported multiple or ambiguous ptrace inferiors.");
    const [fd, pid] = inferior[0]!;
    const identity = session.knownInferiorIdentities.get(pid)!;
    assertRizinProcessStartTimeStable(
      identity.startTime,
      await readLinuxProcessStartTime(pid),
    );
    await this.#verifyDebuggerExitPolicy(session);
    await this.#verifyInferiorOutputDescriptors(session, pid);
    await this.#verifyInferiorStdinIsolated(session, pid);
    await this.#runInternalCommand(session, `o- ${fd}`);
    const after = parseRizinPtraceRows(
      await this.#runInternalCommand(session, "olj"),
    );
    if (
      after.some(
        ([activeFd, activePid]) => activeFd === fd || activePid === pid,
      ) ||
      after.length !== 0
    )
      throw new Error(
        "Rizin did not confirm that the selected inferior FD was detached.",
      );
    // Protocol readback must never be waived by proof that a process ended.
    await this.#verifyDebuggerExitPolicy(session);
    try {
      assertRizinProcessStartTimeStable(
        identity.startTime,
        await readLinuxProcessStartTime(pid),
      );
      await this.#verifyInferiorOutputDescriptors(session, pid);
    } catch (cause) {
      // Detach resumes the inferior. Its identity or descriptors may disappear
      // before readback; only a previously identified process can prove its end.
      if (!(await verifyOwnedInferiorsEnded([identity]))) throw cause;
      session.knownInferiorIdentities.clear();
      return { status: "no-inferior" };
    }
    return { status: "detached", outputSink: "durable" };
  }

  async #verifyDebuggerExitPolicy(session: RizinDebugSession): Promise<void> {
    const exitKills = (
      await this.#runInternalCommand(session, "e dbg.exitkills")
    ).trim();
    if (exitKills !== "false")
      throw new Error("Rizin dbg.exitkills readback did not confirm false.");
  }

  async #verifyInferiorOutputDescriptors(
    session: RizinDebugSession,
    pid: string,
  ): Promise<void> {
    for (const descriptor of ["1", "2"]) {
      const descriptorPath = `/proc/${pid}/fd/${descriptor}`;
      const destination = await readlink(descriptorPath);
      const destinationStat = await stat(descriptorPath);
      if (
        destinationStat.dev !== session.inferiorTtyDevice ||
        destinationStat.ino !== session.inferiorTtyInode ||
        (destinationStat.mode & fsConstants.S_IFMT) !== fsConstants.S_IFCHR ||
        (await realpath(destination)) !== session.inferiorTty
      )
        throw new Error(
          `Inferior descriptor ${descriptor} is not routed to the selected TTY.`,
        );
    }
  }

  /**
   * Detach resumes the inferior, which would then read the commands that must
   * confirm the detach. Only sharing the command stream is refused: a target may
   * close or replace its own stdin, and neither can consume those commands.
   */
  async #verifyInferiorStdinIsolated(
    session: RizinDebugSession,
    pid: string,
  ): Promise<void> {
    let inferiorStdin: Stats;
    try {
      inferiorStdin = await stat(`/proc/${pid}/fd/0`);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
      throw cause;
    }
    const commandStream = await stat(
      `/proc/${String(session.launched.process.pid)}/fd/0`,
    );
    if (
      inferiorStdin.dev === commandStream.dev &&
      inferiorStdin.ino === commandStream.ino
    )
      throw new Error(
        "Inferior stdin is the Rizin command stream rather than the selected TTY; detaching would let the target consume debugger commands.",
      );
  }

  async #synchronizeCleanup(session: RizinDebugSession): Promise<void> {
    const stdin = session.launched.process.stdin;
    if (
      stdin === null ||
      stdin === undefined ||
      stdin.destroyed ||
      !stdin.writable
    )
      throw new Error(
        "Rizin stdin is unavailable during cleanup synchronization.",
      );
    // Admission remains closed. Only cleanup can recover correlation, and then
    // it still obtains a fresh ptrace inventory and validates identity/output.
    session.ready = false;
    session.frames.length = 0;
    session.queuedFrameBytes = 0;
    const marker = `__REA_CLEANUP_SYNC_${randomUUID().replaceAll("-", "")}__`;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (cause?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        session.cleanupSynchronization = undefined;
        if (cause === undefined) {
          session.stopReason ??= session.protocolError;
          session.protocolError = undefined;
          session.commandOutputDropped = false;
          resolve();
        } else reject(cause);
      };
      const timer = setTimeout(
        () =>
          finish(
            new Error("Rizin cleanup synchronization marker was not observed."),
          ),
        CLEANUP_COMMAND_TIMEOUT_MS,
      );
      session.cleanupSynchronization = {
        marker,
        resolve: () => finish(),
        reject: (cause) => finish(cause),
      };
      try {
        stdin.write(`!echo ${marker}\n`, "utf8", (cause?: Error | null) => {
          if (cause) session.cleanupSynchronization?.reject(cause);
        });
      } catch (cause) {
        finish(
          cause instanceof Error
            ? cause
            : new Error("Rizin cleanup synchronization write failed.", {
                cause,
              }),
        );
      }
    });
  }

  async #runInternalCommand(
    session: RizinDebugSession,
    command: string,
  ): Promise<string> {
    if (hasUnclaimedRizinFrames(session))
      throw new Error(
        "Unsolicited Rizin output prevents correlated cleanup readback.",
      );
    const marker = `__REA_CLEANUP_COMPLETE_${randomUUID().replaceAll("-", "")}__`;
    const stdin = session.launched.process.stdin;
    if (
      stdin === null ||
      stdin === undefined ||
      stdin.destroyed ||
      !stdin.writable
    )
      throw new Error("Rizin stdin is unavailable during cleanup.");
    stdin.write(`${command}\n!echo ${marker}\n`);
    const captured = await waitForCommandFrames(
      session,
      marker,
      CLEANUP_COMMAND_TIMEOUT_MS,
      debuggerControlReplyOutput,
    );
    if (!captured.ok) throw captured.error.cause;
    if (captured.value.outputTruncated)
      throw new Error("Rizin cleanup readback was truncated.");
    return captured.value.output;
  }

  #finalizeCommandObservation(
    session: RizinDebugSession,
    observation: {
      readonly result: RizinDebugCommandResult;
      readonly evidence: Evidence;
    },
    stopped: Awaited<ReturnType<typeof stopOwnedDebuggerProcess>>,
    signal?: AbortSignal,
  ): Result<typeof observation, AnalysisError> {
    if (signal?.aborted) {
      const primary = rizinCancellation(
        "rizin_debug_command",
        signal,
        undefined,
        {
          capturedOutput: {
            stdout: observation.result.output,
            stderr: "",
            truncated: observation.result.output_truncated,
          },
          partialObservation: observation.evidence,
        },
      );
      return err(
        this.#finalizeFailure(
          session,
          "rizin_debug_command",
          primary,
          stopped,
          signal,
        ),
      );
    }
    return stopped.status === "incomplete"
      ? err(
          this.#retainCleanupFailure(
            session,
            "rizin_debug_command",
            stopped.reason,
            { partialObservation: observation.evidence },
          ),
        )
      : ok(observation);
  }

  #finalizeFailure(
    session: RizinDebugSession,
    operation: string,
    primary: AnalysisError,
    stopped: Awaited<ReturnType<typeof stopOwnedDebuggerProcess>>,
    signal?: AbortSignal,
  ): AnalysisError {
    if (signal?.aborted && !(primary instanceof AnalysisCancelledError))
      primary.retainSecondaryFailure(rizinCancellation(operation, signal), {
        finalization_cancelled: true,
      });
    if (stopped.status !== "incomplete") return primary;
    if (primary instanceof AnalysisCancelledError)
      return this.#retainCleanupFailure(session, operation, stopped.reason, {
        cause: primary,
      });
    const cleanup = this.#retainCleanupFailure(
      session,
      operation,
      stopped.reason,
    );
    const composed = analysisErrorWithCleanupFailure(
      primary,
      cleanup,
      operation,
    ).bindCleanupDependencies([cleanup]);
    session.cleanupFailures.add(composed);
    return composed;
  }

  #retainCleanupFailure(
    session: RizinDebugSession,
    operation: string,
    reason: string,
    options: AnalysisErrorOptions = {},
  ): AnalysisError {
    const cleanup = { reason, resources: [session.id] };
    const primary = options.cause;
    const failure =
      primary instanceof AnalysisCancelledError
        ? new AnalysisCancelledError(operation, {
            ...options,
            cause: primary.cause,
            capturedOutput: options.capturedOutput ?? primary.capturedOutput,
            partialObservation:
              options.partialObservation ?? primary.partialObservation,
            cleanup,
          })
        : new AnalysisCapabilityUnavailableError(
            "rizin",
            operation,
            `The owned Rizin process could not be confirmed stopped: ${reason}`,
            { ...options, cleanup },
          );
    session.cleanupFailures.add(failure);
    return failure;
  }

  async #stopAfterProtocolFailure(
    session: RizinDebugSession,
    protocolFailure: string,
    cause: unknown,
    options: {
      readonly commandTurnHeld?: boolean;
      readonly partialObservation?: Evidence;
      readonly signal?: AbortSignal | undefined;
    } = {},
  ): Promise<AnalysisError> {
    const stopped = await this.#stopDebuggerOnly(
      session,
      options.commandTurnHeld,
    );
    const errorOptions = {
      cause,
      ...(options.partialObservation === undefined
        ? {}
        : { partialObservation: options.partialObservation }),
    };
    const primary = new AnalysisCapabilityUnavailableError(
      "rizin",
      "rizin_debug_command",
      protocolFailure,
      errorOptions,
    );
    return this.#finalizeFailure(
      session,
      "rizin_debug_command",
      primary,
      stopped,
      options.signal,
    );
  }
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

const parseRizinPtraceRows = (output: string): Array<[string, string]> => {
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

/** @internal Reject a PID that changed identity during inferior detach. */
export const assertRizinProcessStartTimeStable = (
  before: string,
  after: string | null,
): void => {
  if (after !== before)
    throw new Error(
      "The inferior PID disappeared or was reused during detach verification.",
    );
};

const hasUnclaimedRizinFrames = (session: RizinDebugSession): boolean =>
  session.frames.length > 0 ||
  session.bufferedFrameBytes > 0 ||
  session.discardingOversizedFrame;

/** Parse the receiver's bounded bytes once for normal, startup and interrupted reads. */
const bufferedRizinFrame = (session: RizinDebugSession, truncated: boolean) => {
  const bytes = Buffer.concat(session.frameChunks, session.bufferedFrameBytes);
  const invalidUtf8 = !isUtf8(bytes);
  session.invalidUtf8Observed ||= invalidUtf8;
  return {
    bytes: bytes.length,
    frame: { text: bytes.toString("utf8"), truncated, invalidUtf8 },
  };
};

const rizinCaptureStoppedSentence = (
  limit: RizinOutputLimit | undefined,
  output: DebuggerAdmissionLimit,
  cleanupFailure: string | undefined,
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
    cleanupFailure === undefined
      ? " The owned debugger session was stopped."
      : ` The owned debugger session remains retained because cleanup could not be verified: ${cleanupFailure}`;
  const recovery =
    limit === "command_output_bytes"
      ? ` ${debuggerAdmissionRecovery(output)}`
      : " This release has no runtime override.";
  return `The Rizin command exceeded ${cap}.${recovery} Retained output is partial and command completion is unknown.${cleanup}`;
};

const waitForCommandFrames = async (
  session: RizinDebugSession,
  marker: string,
  timeoutMs: number,
  commandOutput: DebuggerAdmissionLimit,
  signal?: AbortSignal,
): Promise<Result<RizinCommandCapture, RizinCommandInterruption>> => {
  const maxCommandOutputBytes = commandOutput.value;
  const deadline = Date.now() + timeoutMs;
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
      const retained = truncateUtf8(text, remaining);
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
    for (;;) {
      const queued = session.frames.shift();
      if (queued === undefined) break;
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
        cause: new Error(session.protocolError),
        capture,
      });
    }
    const remaining = deadline - Date.now();
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
      session.protocolError = `Rizin emitted more than ${String(MAX_COMMAND_FRAMES)} frames for one command. This release has no runtime override. The session was stopped because output correlation is ambiguous.`;
      noteLimit("command_frames");
      return ok(snapshot());
    }
    const markerSeen = append(received);
    if (outputTruncated) {
      if (outputLimit === "command_output_bytes")
        session.protocolError ??=
          commandOutput === debuggerControlReplyOutput
            ? `Rizin control readback exceeded the ${String(maxCommandOutputBytes)} byte control-reply budget. That budget is separate from REA_DEBUGGER_MAX_COMMAND_OUTPUT_BYTES and has no runtime override.`
            : `Rizin command output exceeded the ${String(maxCommandOutputBytes)} byte command limit. ${debuggerAdmissionRecovery(commandOutput)}`;
      else if (outputLimit === "frame_bytes")
        session.protocolError ??= `Rizin emitted a NUL frame exceeding the ${String(MAX_FRAME_BYTES)} byte (16 MiB) protocol limit. This release has no runtime override.`;
      return ok(snapshot());
    }
    if (markerSeen) return ok(snapshot());
  }
};

const truncateUtf8 = (value: string, maximumBytes: number): string => {
  if (maximumBytes <= 0) return "";
  // A UTF-16 code unit needs at most three UTF-8 bytes. Buffer.write stops
  // before a partial character; only decode bytes it actually initialized.
  const bytes = Buffer.allocUnsafe(Math.min(value.length * 3, maximumBytes));
  const written = bytes.write(value, "utf8");
  return bytes.toString("utf8", 0, written);
};

const waitForFrame = (
  session: RizinDebugSession,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<RizinFrame> => {
  if (signal?.aborted)
    return Promise.reject(rizinCancellation("rizin_debug_command", signal));
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
      reject(rizinCancellation("rizin_debug_command", signal));
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

const waitForTurn = (
  previous: Promise<void>,
  signal?: AbortSignal,
): Promise<void> => {
  if (signal === undefined) return previous;
  return waitForAbortable(previous, signal).then((outcome) => {
    if (outcome === ABORTED)
      throw rizinCancellation("rizin_debug_command", signal);
  });
};
/** Translate only this transport's typed cancellation, preserving opaque/null caller reasons. */
const rizinCancellation = (
  operation: string,
  signal?: AbortSignal,
  cause?: unknown,
  options: AnalysisErrorOptions = {},
): AnalysisCancelledError =>
  new AnalysisCancelledError(operation, {
    ...options,
    cause: signal?.aborted
      ? signal.reason
      : cause instanceof AnalysisCancelledError
        ? cause.cause
        : cause,
  });
