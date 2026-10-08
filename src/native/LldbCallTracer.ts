import { spawn } from "node:child_process";
import { open, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisTimeoutError,
} from "../domain/analysisErrorCore.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  nativeCallEventSchema,
  nativeCodeLocationSchema,
  type NativeCallObservationInput,
} from "../domain/native/nativeCallObservation.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { err, ok, type Result } from "../domain/result.js";
import { safeParseJson } from "../domain/safeJson.js";
import { execFileOutput } from "../process/ExecFileOutput.js";
import { PrivateRuntimeRoot } from "../process/PrivateRuntimeRoot.js";
import { resolveXcrunTool, type ResolvedTool } from "./CommandRunner.js";

const OPERATION = "observe_native_calls";
const PROVIDER = "native-macos";
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
  outcome: z.enum(["exited", "duration-elapsed", "event-limit", "stop-limit"]),
  exit_status: z.number().int().nullable(),
  exit_description: z.string().nullable(),
  killed: z.boolean(),
  terminated: z.boolean(),
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
    status: z.enum(["target-error", "launch-error", "tracer-error"]),
    error: z.string().nullable(),
  }),
]);

/** Bounded text of one target output stream. */
export interface CapturedOutput {
  readonly text: string;
  readonly bytes: number;
  readonly truncated: boolean;
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
  async trace(
    request: Parameters<NativeCallTracer["trace"]>[0],
    signal?: AbortSignal,
  ): Promise<Result<NativeCallTrace, AnalysisError>> {
    const lldb = await resolveXcrunTool("lldb", signal);
    if (!lldb.ok)
      return err(
        lldb.error.reason === "cancelled"
          ? new AnalysisCancelledError(OPERATION)
          : new AnalysisCapabilityUnavailableError(
              PROVIDER,
              OPERATION,
              "LLDB from Xcode or the Command Line Tools is not available",
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
      stdout: join(directory, "stdout"),
      stderr: join(directory, "stderr"),
    };
    const { input } = request;
    await writeFile(
      paths.config,
      JSON.stringify({
        executable: request.executable,
        architecture: request.architecture,
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
        stdout_path: paths.stdout,
        stderr_path: paths.stderr,
        result_path: paths.result,
        pid_path: paths.pid,
      }),
      { mode: 0o600 },
    );
    const exited = await runLldb(
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
        ...(signal === undefined ? {} : { signal }),
      },
    );
    const terminated = await ensureTerminated(paths.pid, request.executable);
    if (exited.kind === "cancelled")
      return err(new AnalysisCancelledError(OPERATION));
    if (exited.kind === "timeout")
      return err(
        new AnalysisTimeoutError(
          OPERATION,
          input.duration_ms + DEADLINE_GRACE_MS,
        ),
      );
    const output = await readTracerOutput(paths.result);
    if (output === undefined)
      return err(
        new ProviderAdapterError(PROVIDER, OPERATION, {
          diagnostics: {
            reason: "LLDB exited without a tracer result",
            exit_code: exited.exitCode,
            lldb_output: exited.output,
          },
        }),
      );
    if (output.status !== "traced") return err(tracerFailure(output));
    return ok({
      debugger: { ...lldb, version: output.version },
      run: output,
      stdout: await capturedOutput(paths.stdout),
      stderr: await capturedOutput(paths.stderr),
      terminated,
    });
  }
}

/** LLDB command arguments are quoted; the bridge path is REA's own install path. */
const quote = (value: string): string =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

const tracerFailure = (output: {
  readonly status: "target-error" | "launch-error" | "tracer-error";
  readonly error: string | null;
}): AnalysisError => {
  const message = output.error ?? "no LLDB error text";
  if (output.status === "tracer-error")
    return new ProviderAdapterError(PROVIDER, OPERATION, {
      diagnostics: { reason: `LLDB bridge failed: ${message}` },
    });
  if (output.status === "target-error")
    return new AnalysisCapabilityUnavailableError(
      PROVIDER,
      OPERATION,
      `lldb-target-unloadable: ${message}`,
    );
  // debugserver reports denied task access as an attach failure.
  return /attach|not allowed|permission|denied|debugserver/iu.test(message)
    ? new AnalysisCapabilityUnavailableError(
        PROVIDER,
        OPERATION,
        `debugger-attach-denied: ${message}`,
        { userMessage: ATTACH_REMEDIATION },
      )
    : new AnalysisCapabilityUnavailableError(
        PROVIDER,
        OPERATION,
        `launch-failed: ${message}`,
      );
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

const capturedOutput = async (path: string): Promise<CapturedOutput> => {
  let handle;
  try {
    handle = await open(path, "r");
  } catch {
    return { text: "", bytes: 0, truncated: false };
  }
  try {
    const { size } = await handle.stat();
    const buffer = Buffer.alloc(Math.min(size, MAX_OUTPUT_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return {
      text: buffer.subarray(0, bytesRead).toString("utf8"),
      bytes: size,
      truncated: size > MAX_OUTPUT_BYTES,
    };
  } finally {
    await handle.close();
  }
};

type LldbExit =
  | {
      readonly kind: "exited";
      readonly exitCode: number | null;
      readonly output: string;
    }
  | { readonly kind: "cancelled" }
  | { readonly kind: "timeout" };

/** Run LLDB in its own process group so cancellation can stop it and debugserver. */
const runLldb = (
  executable: string,
  arguments_: readonly string[],
  options: { readonly signal?: AbortSignal; readonly deadlineMs: number },
): Promise<LldbExit> =>
  new Promise((resolve) => {
    if (options.signal?.aborted === true) {
      resolve({ kind: "cancelled" });
      return;
    }
    const child = spawn(executable, [...arguments_], {
      shell: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let stopped: "cancelled" | "timeout" | undefined;
    const keep = (chunk: Buffer): void => {
      output = (output + chunk.toString("utf8")).slice(-DIAGNOSTIC_BYTES);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const kill = (reason: "cancelled" | "timeout"): void => {
      stopped ??= reason;
      if (child.pid !== undefined)
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // The group already exited.
        }
    };
    const timer = setTimeout(() => {
      kill("timeout");
    }, options.deadlineMs);
    const onAbort = (): void => {
      kill("cancelled");
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (exitCode: number | null): void => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve(
        stopped === undefined
          ? { kind: "exited", exitCode, output }
          : { kind: stopped },
      );
    };
    child.on("error", () => {
      finish(null);
    });
    child.on("close", (code) => {
      finish(code);
    });
  });

/**
 * debugserver kills the traced process when LLDB exits. Confirm it, and kill a
 * survivor only when its executable is still the traced one.
 */
const ensureTerminated = async (
  pidPath: string,
  executable: string,
): Promise<boolean> => {
  let pid: number;
  try {
    pid = Number.parseInt(await readFile(pidPath, "utf8"), 10);
  } catch {
    // LLDB never launched the target.
    return true;
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  for (let attempt = 0; attempt < 20; attempt++) {
    if (!alive(pid)) return true;
    if (attempt === 10 && (await commandOf(pid)) === executable)
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // It exited between the checks.
      }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !alive(pid);
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

const commandOf = async (pid: number): Promise<string | undefined> => {
  try {
    const { stdout } = await execFileOutput(
      "/bin/ps",
      ["-o", "comm=", "-p", String(pid)],
      { timeout: 5_000 },
    );
    return stdout.trim();
  } catch {
    return undefined;
  }
};
