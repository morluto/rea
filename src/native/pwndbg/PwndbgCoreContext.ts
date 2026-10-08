import { access, mkdir, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { ExecutionOptions } from "../../application/AnalysisProvider.js";
import type { AnalysisCapturedOutput } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import {
  recordedCrashDebuggerSchema,
  type RecordedCrash,
} from "../../domain/native/recordedCrash.js";
import { readStableArtifact } from "../../artifacts/readStableArtifact.js";
import { runOwnedCommand } from "../../process/OwnedCommand.js";
import {
  capturedPwntoolsOutput,
  pwntoolsDecoderFailure,
} from "../pwntools/PwntoolsFailures.js";
import { PWNTOOLS_LIMITS } from "../pwntools/PwntoolsRelease.js";
import { readPwntoolsFailureEvidence } from "../pwntools/PwntoolsResourceLimits.js";
import type { PwntoolsLauncher } from "../pwntools/PwntoolsDecoder.js";

const OPERATION = "inspect_recorded_crash";
const replySchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), value: recordedCrashDebuggerSchema }),
  z.strictObject({
    ok: z.literal(false),
    reason: z.enum([
      "unavailable",
      "unsupported",
      "decoder",
      "format",
      "output-limit",
    ]),
    message: z.string(),
  }),
]);

/** Add mapping candidates from an owned core-only debugger, using the existing snapshot. */
export const inspectPwndbgCore = async ({
  environment,
  rootPath,
  diagnostics,
  options,
  launcher,
}: {
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly rootPath: string;
  readonly diagnostics: AnalysisCapturedOutput;
  readonly options: ExecutionOptions | undefined;
  readonly launcher?: PwntoolsLauncher;
}): Promise<RecordedCrash["debugger"]> => {
  const gdb = environment.REA_PWNDBG_GDB ?? "/usr/bin/gdb";
  const entry = environment.REA_PWNDBG_GDBINIT ?? "";
  const venv = environment.REA_PWNDBG_VENV_PATH ?? "";
  const unavailable = (message: string, cause?: unknown) =>
    new AnalysisCapabilityUnavailableError("pwndbg-core", OPERATION, message, {
      ...(cause === undefined ? {} : { cause }),
      userMessage: message,
      capturedOutput: diagnostics,
    });
  for (const [key, path, kind] of [
    ["REA_PWNDBG_GDB", gdb, "file"],
    ["REA_PWNDBG_GDBINIT", entry, "file"],
    ["REA_PWNDBG_VENV_PATH", venv, "directory"],
  ] as const) {
    try {
      if (!isAbsolute(path))
        throw new Error("Expected an absolute caller-supplied path.");
      await access(
        path,
        key === "REA_PWNDBG_GDB" ? constants.X_OK : constants.R_OK,
      );
      const information = await stat(path);
      if (kind === "file" ? !information.isFile() : !information.isDirectory())
        throw new Error(`Expected a ${kind}.`);
    } catch (cause: unknown) {
      throw unavailable(
        `${key} is unavailable at ${path}: ${cause instanceof Error ? cause.message : String(cause)}. Configure the requested core-only context, or omit include_debugger_context for basic recorded evidence.`,
        cause,
      );
    }
  }
  const stage = join(rootPath, "debugger");
  await mkdir(stage, { mode: 0o700 });
  const requestPath = join(stage, "request.json");
  const replyPath = join(stage, "reply.json");
  await writeFile(
    requestPath,
    JSON.stringify({
      snapshot_path: join(rootPath, "object.snapshot"),
      reply_path: replyPath,
      gdb,
      gdbinit: entry,
      venv,
    }),
    { flag: "wx", mode: 0o600 },
  );
  let output: AnalysisCapturedOutput | undefined;
  try {
    options?.signal?.throwIfAborted();
    const execution = await runOwnedCommand(
      {
        command: environment.REA_PWNTOOLS_PYTHON ?? "",
        arguments: [
          "-I",
          fileURLToPath(
            new URL("../../../bridge/pwndbg/launch.py", import.meta.url),
          ),
          join(stage, "resource.failure"),
          requestPath,
        ],
        cwd: stage,
        runId: `rea-recorded-core-debugger-${randomUUID()}`,
        hostEnvironment: {
          ...environment,
          PWNDBG_NO_AUTOUPDATE: "1",
          PWNDBG_VENV_PATH: venv,
          PWNLIB_NOTERM: "1",
          TERM: "dumb",
          HOME: stage,
          XDG_CACHE_HOME: join(stage, "cache"),
          XDG_CONFIG_HOME: join(stage, "config"),
          PYTHONNOUSERSITE: "1",
          OPENBLAS_NUM_THREADS: "1",
          OMP_NUM_THREADS: "1",
        },
      },
      {
        timeoutMs: PWNTOOLS_LIMITS.timeoutMs,
        diagnosticBytes: PWNTOOLS_LIMITS.diagnosticBytes,
      },
      {
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
        ...(launcher === undefined ? {} : { launcher }),
      },
    );
    output = capturedPwntoolsOutput(execution);
    let reply: z.output<typeof replySchema>;
    try {
      const raw = await readStableArtifact(
        replyPath,
        PWNTOOLS_LIMITS.outputBytes,
        options?.signal,
      );
      reply = replySchema.parse(JSON.parse(raw.bytes.toString("utf8")));
    } catch (cause: unknown) {
      if (options?.signal?.aborted)
        throw new AnalysisCancelledError(OPERATION, {
          capturedOutput: recordedCrashStageOutput(diagnostics, output),
        });
      throw new AnalysisOutputError(
        OPERATION,
        `Core-only debugger reply failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        {
          cause,
          capturedOutput: recordedCrashStageOutput(diagnostics, output),
        },
      );
    }
    if (!reply.ok) {
      if (reply.reason === "unavailable" || reply.reason === "unsupported")
        throw new AnalysisCapabilityUnavailableError(
          "pwndbg-core",
          OPERATION,
          reply.message,
          {
            userMessage: reply.message,
            capturedOutput: recordedCrashStageOutput(diagnostics, output),
          },
        );
      if (reply.reason === "format" || reply.reason === "output-limit")
        throw new AnalysisOutputError(OPERATION, reply.message, {
          capturedOutput: recordedCrashStageOutput(diagnostics, output),
        });
      throw new ProviderAdapterError("pwndbg-core", OPERATION, {
        diagnostics: {
          stage: "debugger",
          reason: reply.message,
          captured_output: { ...recordedCrashStageOutput(diagnostics, output) },
        },
      });
    }
    if (reply.value.status !== "available")
      throw new AnalysisOutputError(
        OPERATION,
        "Requested debugger context returned no core evidence.",
        { capturedOutput: recordedCrashStageOutput(diagnostics, output) },
      );
    return { ...reply.value, diagnostics: output };
  } catch (cause: unknown) {
    if (
      options?.signal?.aborted &&
      (cause === options.signal.reason ||
        (cause instanceof Error && cause.name === "AbortError"))
    )
      throw new AnalysisCancelledError(OPERATION, {
        capturedOutput: recordedCrashStageOutput(diagnostics, output),
      });
    throw pwntoolsDecoderFailure(
      cause,
      "debugger",
      gdb,
      environment.REA_PWNTOOLS_PYTHON ?? "",
      await readPwntoolsFailureEvidence(cause, stage),
      {
        operation: OPERATION,
        providerId: "pwndbg-core",
        precedingOutput: diagnostics,
      },
    );
  }
};

/** Preserve both stages' exact text and their independently observed truncation state. */
export const recordedCrashStageOutput = (
  basic: AnalysisCapturedOutput,
  debuggerOutput?: AnalysisCapturedOutput,
): AnalysisCapturedOutput =>
  debuggerOutput === undefined
    ? basic
    : {
        stdout: `[core decoder]\n${basic.stdout}\n[debugger]\n${debuggerOutput.stdout}`,
        stderr: `[core decoder]\n${basic.stderr}\n[debugger]\n${debuggerOutput.stderr}`,
        truncated: basic.truncated || debuggerOutput.truncated,
      };
