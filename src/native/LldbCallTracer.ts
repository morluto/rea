import { snapshotEnvironment } from "../process/snapshotEnvironment.js";
import { randomUUID } from "node:crypto";
import { open, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisTimeoutError,
} from "../domain/analysisErrorCore.js";
import { EvidenceIntegrityError } from "../domain/evidenceErrors.js";
import type {
  AnalysisCleanupObservation,
  AnalysisError,
} from "../domain/analysisErrorBase.js";
import type { NativeCallPartialObservation } from "../domain/native/nativeCallPartialObservation.js";
import {
  nativeCallEventSchema,
  nativeCodeLocationSchema,
  type NativeCallObservationInput,
} from "../domain/native/nativeCallObservation.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { err, ok, type Result } from "../domain/result.js";
import { safeParseJson } from "../domain/safeJson.js";
import {
  ProviderProcessSupervisor,
  spawnOwnedProviderProcess,
} from "../process/ProviderProcess.js";
import { cleanupOwnedProcessGroup } from "../process/ProcessOwnership.js";
import {
  observeProcessStartIdentity,
  prepareProcessOwnershipInspection,
  signalProcessWithStartIdentity,
} from "../process/ProcessOwnershipObservation.js";
import type { ProcessIdentityObservation } from "../process/ProcessOwnership.js";
import {
  ProviderStartupDeadline,
  waitForAbortableDelay,
} from "../process/ProviderDeadline.js";
import { PrivateRuntimeRoot } from "../process/PrivateRuntimeRoot.js";
import { resolveXcrunTool, type ResolvedTool } from "./CommandRunner.js";
import {
  readLldbObservationJournal,
  readBoundedPrefix,
  readPartialCapture,
  projectLldbPartialObservation,
} from "./LldbRetainedObservations.js";

const OPERATION = "observe_native_calls";
const PROVIDER = "native-macos";
const LLDB_REQUIREMENT =
  "LLDB from Xcode or the Command Line Tools is not available";
/** Captured target output kept per stream; the rest is counted, not stored. */
const MAX_OUTPUT_BYTES = 1024 * 1024;
/** LLDB startup, symbol loading and teardown beyond the observation window. */
const DEADLINE_GRACE_MS = 60_000;
const DIAGNOSTIC_BYTES = 16 * 1024;

const BRIDGE = fileURLToPath(
  new URL("../../bridge/native/rea_lldb_tracer.py", import.meta.url),
);

/** JSON the LLDB bridge writes after a completed run. */
const tracedSchema = z.strictObject({
  status: z.literal("traced"),
  version: z.string(),
  pid: z.number().int().positive(),
  outcome: z.enum([
    "exited",
    "duration-elapsed",
    "event-limit",
    "stop-limit",
    "resource-limit",
  ]),
  exit_status: z.number().int().nullable(),
  exit_description: z.string().nullable(),
  killed: z.boolean(),
  terminated: z.boolean(),
  target_identity: z.strictObject({
    loaded_image_sha256: z.null(),
    selected_file_sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .nullable(),
    file_device: z.string().nullable(),
    file_inode: z.string().nullable(),
    module_path: z.string().nullable(),
    module_uuid: z.string().nullable(),
    stable: z.boolean(),
  }),
  resource_limit_reached: z.boolean(),
  breakpoint_locations_truncated: z.boolean().optional(),
  target_output: z.strictObject({
    stdout_bytes: z.number().int().nonnegative(),
    stderr_bytes: z.number().int().nonnegative(),
    stdout_truncated: z.boolean(),
    stderr_truncated: z.boolean(),
    stdout_complete: z.boolean(),
    stderr_complete: z.boolean(),
  }),
  elapsed_ms: z.number().nonnegative(),
  breakpoints: z.array(
    z.strictObject({
      index: z.number().int().nonnegative(),
      location_count: z.number().int().nonnegative(),
      locations: z.array(nativeCodeLocationSchema),
    }),
  ),
  events: z.array(nativeCallEventSchema),
  other_stops: z.array(z.string()),
});

const tracerOutputSchema = z.discriminatedUnion("status", [
  tracedSchema,
  z.strictObject({
    status: z.enum([
      "target-error",
      "target-integrity-error",
      "target-identity-unavailable",
      "launch-error",
      "tracer-error",
    ]),
    error: z.string().nullable(),
  }),
]);

/** Bounded text of one target output stream. */
export interface CapturedOutput {
  readonly text: string;
  /** Bytes drained from the target, which may exceed the retained prefix. */
  readonly bytes: number;
  readonly truncated: boolean;
  /** Whether the bridge confirms it drained the stream through EOF. */
  readonly complete: boolean;
}

/** One completed LLDB observation, before projection into the result contract. */
export interface NativeCallTrace {
  readonly debugger: ResolvedTool & { readonly version: string | null };
  readonly run: z.infer<typeof tracedSchema>;
  readonly stdout: CapturedOutput;
  readonly stderr: CapturedOutput;
  /** REA confirmed the traced process no longer exists. */
  readonly terminated: boolean;
}

/** Launch one owned process under a debugger and record calls. */
export interface NativeCallTracer {
  trace(
    request: {
      readonly executable: string;
      readonly architecture: string;
      readonly expectedSha256: string;
      readonly input: NativeCallObservationInput;
    },
    signal?: AbortSignal,
  ): Promise<Result<NativeCallTrace, AnalysisError>>;
}

/** Remediation for a target LLDB may not debug. */
const ATTACH_REMEDIATION =
  "Allow debugging for this user (Developer Tools access: `DevToolsSecurity -enable`, or membership in the _developer group). A hardened-runtime target is debuggable only with the com.apple.security.get-task-allow entitlement; see inspect_signature's debugger-attach facet.";

/** Production tracer: `lldb --batch` running the REA LLDB bridge. */
export class LldbCallTracer implements NativeCallTracer {
  private readonly environment: NodeJS.ProcessEnv;
  constructor(
    environment: Readonly<NodeJS.ProcessEnv>,
    private readonly launch: typeof runLldb = runLldb,
    private readonly resolveTool: (
      tool: string,
      signal?: AbortSignal,
    ) => ReturnType<typeof resolveXcrunTool> = (tool, signal) =>
      resolveXcrunTool(tool, this.environment, signal),
  ) {
    this.environment = snapshotEnvironment(environment);
  }

  async trace(
    request: Parameters<NativeCallTracer["trace"]>[0],
    signal?: AbortSignal,
  ): Promise<Result<NativeCallTrace, AnalysisError>> {
    const lldb = await this.resolveTool("lldb", signal);
    if (!lldb.ok)
      return err(
        lldb.error.reason === "cancelled"
          ? new AnalysisCancelledError(OPERATION)
          : new AnalysisCapabilityUnavailableError(
              PROVIDER,
              OPERATION,
              LLDB_REQUIREMENT,
              { userMessage: LLDB_REQUIREMENT },
            ),
      );
    const root = await PrivateRuntimeRoot.create({ prefix: "rea-lldb-" });
    try {
      return await this.#run(lldb.value, root.path, request, signal);
    } finally {
      await root.close();
    }
  }

  async #run(
    lldb: ResolvedTool,
    directory: string,
    request: Parameters<NativeCallTracer["trace"]>[0],
    signal?: AbortSignal,
  ): Promise<Result<NativeCallTrace, AnalysisError>> {
    const paths = {
      config: join(directory, "config.json"),
      result: join(directory, "result.json"),
      pid: join(directory, "pid"),
      identityAck: join(directory, "identity.ack"),
      stdout: join(directory, "stdout"),
      stderr: join(directory, "stderr"),
      stdoutCapture: join(directory, "stdout.capture"),
      stderrCapture: join(directory, "stderr.capture"),
      observations: join(directory, "observations.jsonl"),
    };
    const { input } = request;
    await writeFile(
      paths.config,
      JSON.stringify({
        executable: request.executable,
        architecture: request.architecture,
        expected_sha256: request.expectedSha256,
        arguments: input.arguments,
        environment: input.environment,
        working_directory: input.working_directory ?? null,
        breakpoints: input.breakpoints.map((breakpoint) =>
          breakpoint.kind === "function"
            ? { ...breakpoint, module: breakpoint.module ?? null }
            : { ...breakpoint, class_name: breakpoint.class_name ?? null },
        ),
        duration_ms: input.duration_ms,
        max_events: input.max_events,
        argument_registers: input.argument_registers,
        backtrace_frames: input.backtrace_frames,
        max_output_bytes: MAX_OUTPUT_BYTES,
        stdout_path: paths.stdout,
        stderr_path: paths.stderr,
        stdout_capture_path: paths.stdoutCapture,
        stderr_capture_path: paths.stderrCapture,
        result_path: paths.result,
        pid_path: paths.pid,
        identity_ack_path: paths.identityAck,
        observation_path: paths.observations,
      }),
      { mode: 0o600 },
    );
    await prepareProcessOwnershipInspection(signal);
    const exited = await this.launch(
      lldb.path,
      [
        "--batch",
        "--no-lldbinit",
        "--no-use-colors",
        "-o",
        `command script import ${quote(BRIDGE)}`,
        "-o",
        `rea_trace ${paths.config}`,
      ],
      {
        deadlineMs: input.duration_ms + DEADLINE_GRACE_MS,
        pidPath: paths.pid,
        identityAckPath: paths.identityAck,
        environment: this.environment,
        ...(signal === undefined ? {} : { signal }),
      },
    );
    const output =
      exited.kind === "exited"
        ? await readTracerOutput(paths.result)
        : undefined;
    let targetTermination = await ensureTerminated(
      paths.pid,
      exited.targetIdentity,
      true,
    );
    // These two bridge outcomes are emitted before a target process exists.
    // Other missing-PID cases, including a missing result, remain unknown.
    if (
      output !== undefined &&
      (output.status === "target-error" || output.status === "launch-error") &&
      (await readTargetPid(paths.pid)) === undefined
    )
      targetTermination = "terminated";
    const terminated = targetTermination === "terminated";
    const cleanupDetails = [
      exited.cleanupFailure,
      ...(terminated ? [] : [targetTerminationReason(targetTermination)]),
    ].filter((detail): detail is string => detail !== undefined);
    const lifecycleCleanup =
      cleanupDetails.length === 0
        ? undefined
        : {
            reason: cleanupDetails.join("; "),
            resources: [
              ...(exited.cleanupFailure === undefined
                ? []
                : ["lldb-process-group"]),
              ...(terminated
                ? []
                : [
                    `native-target:${String((await readTargetPid(paths.pid)) ?? "unknown")}`,
                  ]),
            ],
          };
    const partialReason =
      exited.kind === "cancelled"
        ? "cancelled"
        : exited.kind === "timeout"
          ? "timeout"
          : exited.cleanupFailure !== undefined
            ? "cleanup-failure"
            : "tracer-failure";
    const getPartialObservation = (
      reason: NativeCallPartialObservation["coverage"]["reason"] = partialReason,
    ): Promise<NativeCallPartialObservation> =>
      partialNativeObservation({
        request,
        pidPath: paths.pid,
        stdoutPath: paths.stdoutCapture,
        stderrPath: paths.stderrCapture,
        observationPath: paths.observations,
        version: output?.status === "traced" ? output.version : null,
        reason,
      });
    if (exited.kind === "cancelled")
      return err(
        new AnalysisCancelledError(OPERATION, {
          ...(lifecycleCleanup === undefined
            ? {}
            : { cleanup: lifecycleCleanup }),
          partialObservation: await getPartialObservation(),
        }),
      );
    if (exited.kind === "timeout")
      return err(
        new AnalysisTimeoutError(
          OPERATION,
          input.duration_ms + DEADLINE_GRACE_MS,
          {
            ...(lifecycleCleanup === undefined
              ? {}
              : { cleanup: lifecycleCleanup }),
            partialObservation: await getPartialObservation(),
          },
        ),
      );
    if (output !== undefined && output.status !== "traced")
      return err(
        tracerFailure(output, lifecycleCleanup, await getPartialObservation()),
      );
    if (exited.cleanupFailure !== undefined)
      return err(
        new ProviderAdapterError(PROVIDER, OPERATION, {
          cleanup: lifecycleCleanup ?? {
            reason: exited.cleanupFailure,
            resources: ["lldb-process-group"],
          },
          diagnostics: {
            reason: "LLDB process-group cleanup could not be verified",
            cleanup_failure: exited.cleanupFailure,
            ...(lifecycleCleanup === undefined
              ? {}
              : { target_cleanup: lifecycleCleanup }),
          },
          partialObservation: await getPartialObservation(),
        }),
      );
    if (output === undefined)
      return err(
        new ProviderAdapterError(PROVIDER, OPERATION, {
          diagnostics: {
            reason: "LLDB exited without a tracer result",
            exit_code: exited.exitCode,
            lldb_output: exited.output,
            ...(lifecycleCleanup === undefined
              ? {}
              : { target_cleanup: lifecycleCleanup }),
          },
          partialObservation: await getPartialObservation(),
          ...(lifecycleCleanup === undefined
            ? {}
            : { cleanup: lifecycleCleanup }),
        }),
      );
    const stdout = await capturedOutput(
      paths.stdoutCapture,
      output.target_output.stdout_bytes,
      output.target_output.stdout_truncated,
      output.target_output.stdout_complete,
    );
    const stderr = await capturedOutput(
      paths.stderrCapture,
      output.target_output.stderr_bytes,
      output.target_output.stderr_truncated,
      output.target_output.stderr_complete,
    );
    if (!stdout.ok || !stderr.ok) {
      const partial = await getPartialObservation("capture-failure");
      return err(
        new ProviderAdapterError(PROVIDER, OPERATION, {
          partialObservation: partial,
          diagnostics: {
            reason: "LLDB target output capture could not be read",
            ...(stdout.ok ? {} : { stdout_capture_error: stdout.error }),
            ...(stderr.ok ? {} : { stderr_capture_error: stderr.error }),
            ...(lifecycleCleanup === undefined
              ? {}
              : { target_cleanup: lifecycleCleanup }),
          },
          ...(lifecycleCleanup === undefined
            ? {}
            : { cleanup: lifecycleCleanup }),
        }),
      );
    }
    return ok({
      debugger: { ...lldb, version: output.version },
      run: output,
      stdout: stdout.value,
      stderr: stderr.value,
      terminated,
    });
  }
}

/** LLDB command arguments are quoted; the bridge path is REA's own install path. */
const quote = (value: string): string =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

/** Preserve a decoded bridge failure's type independently of cleanup outcome. */
const tracerFailure = (
  output: {
    readonly status:
      | "target-error"
      | "target-integrity-error"
      | "target-identity-unavailable"
      | "launch-error"
      | "tracer-error";
    readonly error: string | null;
  },
  cleanup?: AnalysisCleanupObservation,
  partialObservation?: NativeCallPartialObservation,
): AnalysisError => {
  const options = {
    ...(cleanup === undefined ? {} : { cleanup }),
    ...(partialObservation === undefined ? {} : { partialObservation }),
  };
  const message = output.error ?? "no LLDB error text";
  if (output.status === "target-integrity-error")
    return new EvidenceIntegrityError(
      message || "The launched native target did not match its session digest",
      options,
    );
  if (output.status === "target-identity-unavailable")
    return new ProviderAdapterError(PROVIDER, OPERATION, {
      ...options,
      diagnostics: {
        reason: message,
        constraint: "target process start identity could not be verified",
      },
    });
  if (output.status === "tracer-error")
    return new ProviderAdapterError(PROVIDER, OPERATION, {
      ...options,
      diagnostics: { reason: `LLDB bridge failed: ${message}` },
    });
  if (output.status === "target-error")
    return new AnalysisCapabilityUnavailableError(
      PROVIDER,
      OPERATION,
      `lldb-target-unloadable: ${message}`,
      options,
    );
  // debugserver reports denied task access as an attach failure.
  return /attach|not allowed|permission|denied|debugserver/iu.test(message)
    ? new AnalysisCapabilityUnavailableError(
        PROVIDER,
        OPERATION,
        `debugger-attach-denied: ${message}`,
        { userMessage: ATTACH_REMEDIATION, ...options },
      )
    : new AnalysisCapabilityUnavailableError(
        PROVIDER,
        OPERATION,
        `launch-failed: ${message}`,
        options,
      );
};

const partialNativeObservation = async (options: {
  readonly request: Parameters<NativeCallTracer["trace"]>[0];
  readonly pidPath: string;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly observationPath: string;
  readonly version: string | null;
  readonly reason: NativeCallPartialObservation["coverage"]["reason"];
}): Promise<NativeCallPartialObservation> => {
  const [journal, pid, stdout, stderr] = await Promise.all([
    readLldbObservationJournal(options.observationPath),
    readTargetPid(options.pidPath),
    readPartialCapture(options.stdoutPath),
    readPartialCapture(options.stderrPath),
  ]);
  return projectLldbPartialObservation({
    target: {
      path: options.request.executable,
      sha256: options.request.expectedSha256,
      architecture: options.request.architecture,
      arguments: options.request.input.arguments,
      environment: options.request.input.environment,
      working_directory: options.request.input.working_directory ?? null,
    },
    pid,
    stdout: stdout?.capture ?? null,
    stderr: stderr?.capture ?? null,
    version: options.version,
    journal: journal.parsed,
    journalLimitations: journal.limitations,
    limitations: [
      ...(stdout?.limitations ?? []),
      ...(stderr?.limitations ?? []),
    ],
    reason: options.reason,
  });
};

const readTracerOutput = async (
  path: string,
): Promise<z.infer<typeof tracerOutputSchema> | undefined> => {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  const parsed = safeParseJson(text);
  if (!parsed.ok) return undefined;
  const output = tracerOutputSchema.safeParse(parsed.value);
  return output.success ? output.data : undefined;
};

const capturedOutput = async (
  path: string,
  observedBytes: number,
  truncated: boolean,
  complete: boolean,
): Promise<Result<CapturedOutput, string>> => {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    const { size } = await handle.stat();
    const captureHandle = handle;
    const { buffer, bytesRead } = await readBoundedPrefix(
      Math.min(size, MAX_OUTPUT_BYTES),
      async (target, offset, length, position) =>
        (await captureHandle.read(target, offset, length, position)).bytesRead,
    );
    const captured = {
      text: buffer.subarray(0, bytesRead).toString("utf8"),
      bytes: observedBytes,
      truncated: truncated || size > MAX_OUTPUT_BYTES,
      complete:
        complete && bytesRead >= Math.min(observedBytes, MAX_OUTPUT_BYTES),
    } satisfies CapturedOutput;
    await handle.close();
    handle = undefined;
    return ok(captured);
  } catch (cause: unknown) {
    const failure = cause instanceof Error ? cause.message : String(cause);
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch (closeCause: unknown) {
        return err(
          `${failure}; closing capture file failed: ${closeCause instanceof Error ? closeCause.message : String(closeCause)}`,
        );
      }
    }
    return err(failure);
  }
};

type LldbExit =
  | {
      readonly kind: "exited";
      readonly exitCode: number | null;
      readonly output: string;
      readonly targetIdentity: string | undefined;
      readonly cleanupFailure: string | undefined;
    }
  | {
      readonly kind: "cancelled";
      readonly targetIdentity: string | undefined;
      readonly cleanupFailure: string | undefined;
    }
  | {
      readonly kind: "timeout";
      readonly targetIdentity: string | undefined;
      readonly cleanupFailure: string | undefined;
    };

/** Supervise LLDB as an owned process group while observing its target PID identity. */
const runLldb = async (
  executable: string,
  arguments_: readonly string[],
  options: {
    readonly signal?: AbortSignal;
    readonly deadlineMs: number;
    readonly pidPath: string;
    readonly identityAckPath: string;
    readonly environment: Readonly<NodeJS.ProcessEnv>;
  },
): Promise<LldbExit> => {
  if (options.signal?.aborted === true)
    return {
      kind: "cancelled",
      targetIdentity: undefined,
      cleanupFailure: undefined,
    };
  const deadline = new ProviderStartupDeadline(
    options.deadlineMs,
    options.signal,
  );
  let targetIdentity: string | undefined;
  let supervisor: ProviderProcessSupervisor | undefined;
  try {
    const launched = await spawnOwnedProviderProcess({
      command: executable,
      arguments: arguments_,
      runId: randomUUID(),
      expectedCommand: executable,
      signal: deadline.signal,
      hostEnvironment: options.environment,
    });
    supervisor = new ProviderProcessSupervisor(
      {
        ...launched,
        ownsProcessLifetime: true,
        cleanup: () => cleanupOwnedProcessGroup(launched.ownership),
      },
      { maxDiagnosticBytes: DIAGNOSTIC_BYTES },
    );
    let identityAckWritten = false;
    while (!(await supervisor.waitForOutputClose(20))) {
      const pid = await readTargetPid(options.pidPath);
      if (pid !== undefined && !identityAckWritten) {
        let observation: ProcessIdentityObservation | undefined;
        try {
          observation = await observeProcessStartIdentity(pid);
        } catch {
          observation = undefined;
        }
        if (observation?.state === "readable")
          targetIdentity = observation.identity;
        await writeFile(
          options.identityAckPath,
          observation?.state === "readable" ? "readable" : "unavailable",
          { mode: 0o600 },
        );
        identityAckWritten = true;
      }
      const interruption = deadline.interruption;
      if (interruption !== undefined) {
        const stopped = await supervisor.stop();
        const cleanupFailure =
          stopped.status === "incomplete" ? stopped.reason : undefined;
        return interruption === "cancelled"
          ? { kind: "cancelled", targetIdentity, cleanupFailure }
          : { kind: "timeout", targetIdentity, cleanupFailure };
      }
      await waitForAbortableDelay(20, deadline.signal);
    }
    const snapshot = supervisor.snapshot();
    const stopped = await supervisor.stop();
    const cleanupFailure =
      stopped.status === "incomplete" ? stopped.reason : undefined;
    const interruption = deadline.interruption;
    if (interruption === "cancelled")
      return { kind: "cancelled", targetIdentity, cleanupFailure };
    if (interruption === "timeout")
      return { kind: "timeout", targetIdentity, cleanupFailure };
    return {
      kind: "exited",
      exitCode: snapshot.exitCode ?? null,
      output: `${snapshot.stdout.text}${snapshot.stderr.text}`.slice(
        -DIAGNOSTIC_BYTES,
      ),
      targetIdentity,
      cleanupFailure,
    };
  } catch (cause: unknown) {
    const interruption = deadline.interruption;
    const stopped = await supervisor?.stop();
    const cleanupFailure =
      stopped?.status === "incomplete" ? stopped.reason : undefined;
    return interruption === "timeout"
      ? { kind: "timeout", targetIdentity, cleanupFailure }
      : interruption === "cancelled"
        ? { kind: "cancelled", targetIdentity, cleanupFailure }
        : {
            kind: "exited",
            exitCode: null,
            output: cause instanceof Error ? cause.message : String(cause),
            targetIdentity,
            cleanupFailure,
          };
  } finally {
    supervisor?.dispose();
    deadline.dispose();
  }
};

/**
 * Confirm target exit, and signal a survivor only when its OS start identity
 * still matches the one captured while it was stopped at entry.
 */
const readTargetPid = async (pidPath: string): Promise<number | undefined> => {
  try {
    const pid = Number.parseInt(await readFile(pidPath, "utf8"), 10);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
};

type TargetTermination =
  | "terminated"
  | "identity-unavailable"
  | "identity-changed"
  | "signal-did-not-stop";

/** Only signal a surviving target when its captured OS start identity still matches. */
const ensureTerminated = async (
  pidPath: string,
  identity: string | undefined,
  missingPidIsUnknown: boolean,
): Promise<TargetTermination> => {
  const pid = await readTargetPid(pidPath);
  if (pid === undefined)
    return missingPidIsUnknown ? "identity-unavailable" : "terminated";
  if (!Number.isSafeInteger(pid) || pid <= 0) return "identity-unavailable";
  let signalDisposition: Exclude<TargetTermination, "terminated"> | undefined;
  for (let attempt = 0; attempt < 20; attempt++) {
    if (!alive(pid)) return "terminated";
    if (attempt === 10) {
      if (identity === undefined) signalDisposition = "identity-unavailable";
      else {
        const result = await signalProcessWithStartIdentity(
          pid,
          identity,
          "SIGKILL",
        );
        if (result === "gone") return "terminated";
        if (result === "identity-changed")
          signalDisposition = "identity-changed";
        else if (result === "unverified")
          signalDisposition = "identity-unavailable";
        else if (result === "signaled")
          signalDisposition = "signal-did-not-stop";
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !alive(pid)
    ? "terminated"
    : (signalDisposition ?? "identity-unavailable");
};

const targetTerminationReason = (termination: TargetTermination): string => {
  switch (termination) {
    case "terminated":
      return "target process terminated";
    case "identity-unavailable":
      return "target process start identity was unavailable; survivor was left untouched";
    case "identity-changed":
      return "target PID start identity changed; replacement process was left untouched";
    case "signal-did-not-stop":
      return "verified target did not exit after SIGKILL";
  }
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause: unknown) {
    return !(
      cause instanceof Error &&
      "code" in cause &&
      cause.code === "ESRCH"
    );
  }
};
