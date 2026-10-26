import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import type {
  AnalysisError,
  AnalysisCapturedOutput,
} from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
} from "../domain/analysisErrorCore.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  OwnedCommandFailure,
  runOwnedCommand,
} from "../process/OwnedCommand.js";
import type {
  OwnedProviderProcessSpawnOptions,
  ProviderProcessSnapshot,
} from "../process/ProviderProcess.js";
import { UNICORN_LIMITS, UNICORN_PYTHON_ENV_VAR } from "./UnicornRelease.js";

export const UNICORN_OPERATION = "emulate_function";

/** Wire reply for a completed run, as produced by bridge/unicorn/. */
export const unicornBridgeSuccessReplySchema = z.strictObject({
  ok: z.literal(true),
  stop_reason: z.enum([
    "returned",
    "unmapped_access",
    "unsupported_instruction",
    "stubbed_call",
    "instruction_budget_exhausted",
    "timeout",
    "escaped_code_region",
  ]),
  return_value: z.number().int().nullable(),
  registers: z.record(z.string(), z.number().int()),
  memory_writes: z.array(
    z.strictObject({
      address: z.number().int().nonnegative(),
      before: z.string(),
      after: z.string(),
    }),
  ),
  memory_diff_truncated: z.boolean(),
  calls_hit: z.array(
    z.strictObject({
      kind: z.enum(["import", "syscall"]),
      address: z.number().int().nullable(),
      number: z.number().int().nullable(),
      arguments: z.record(
        z.string(),
        z.union([z.number().int(), z.array(z.number().int())]),
      ),
      stubbed: z.literal(true),
      returned: z.number().int(),
    }),
  ),
  instructions_executed: z.number().int().nonnegative(),
  engine: z.strictObject({
    name: z.literal("unicorn"),
    version: z.literal("2.1.2"),
  }),
});

export type UnicornBridgeSuccessReply = z.output<
  typeof unicornBridgeSuccessReplySchema
>;

const unicornBridgeProbeReplySchema = z.strictObject({
  ok: z.literal(true),
  probe: z.strictObject({
    engine: z.strictObject({
      name: z.literal("unicorn"),
      version: z.literal("2.1.2"),
    }),
  }),
});

const unicornBridgeFailureReplySchema = z.strictObject({
  ok: z.literal(false),
  reason: z.enum(["format", "unavailable", "decoder", "version_mismatch"]),
  message: z.string(),
});

const unicornBridgeReplySchema = z.union([
  unicornBridgeSuccessReplySchema,
  unicornBridgeProbeReplySchema,
  unicornBridgeFailureReplySchema,
]);

type UnicornBridgeReply = z.output<typeof unicornBridgeReplySchema>;

/** Injectable process launch, mirroring the pwntools launcher seam. */
export type UnicornBridgeLauncher = (
  spawn: OwnedProviderProcessSpawnOptions,
  timeoutMs: number,
  signal: AbortSignal | undefined,
) => Promise<ProviderProcessSnapshot>;

const defaultLauncher: UnicornBridgeLauncher = (spawn, timeoutMs, signal) =>
  runOwnedCommand(
    spawn,
    { diagnosticBytes: UNICORN_LIMITS.diagnosticBytes, timeoutMs },
    { signal },
  );

export interface UnicornBridgeRunOptions {
  readonly pythonPath: string;
  readonly bridgePath: string;
  /** Request fields; reply_path is added by the runner. */
  readonly request: Readonly<Record<string, unknown>>;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly launcher?: UnicornBridgeLauncher;
  /** Test hook: parent directory for the per-run directory. */
  readonly runtimeDirBase?: string;
}

const captured = (
  snapshot: ProviderProcessSnapshot,
): AnalysisCapturedOutput => ({
  stdout: snapshot.stdout.text,
  stderr: snapshot.stderr.text,
  truncated: snapshot.diagnosticTruncated === true,
  stdout_bytes: snapshot.stdout.bytes,
  stderr_bytes: snapshot.stderr.bytes,
  ...(snapshot.exitCode === undefined ? {} : { exit_code: snapshot.exitCode }),
  ...(snapshot.signal === undefined ? {} : { signal: snapshot.signal }),
});

const mapFailureReply = (
  reply: z.output<typeof unicornBridgeFailureReplySchema>,
  capturedOutput?: AnalysisCapturedOutput,
): AnalysisError => {
  switch (reply.reason) {
    case "version_mismatch":
      return new AnalysisCapabilityUnavailableError(
        "unicorn",
        UNICORN_OPERATION,
        reply.message,
        {
          userMessage: reply.message,
          remediationAction:
            "Use a caller-supplied Python with unicorn 2.1.2 in the pwntools profile.",
          capturedOutput,
        },
      );
    case "format":
      return new AnalysisInputError(UNICORN_OPERATION, { capturedOutput }, [
        {
          path: [],
          reason: "invalid_format",
          message: reply.message,
        },
      ]);
    case "unavailable":
      return new AnalysisCapabilityUnavailableError(
        "unicorn",
        UNICORN_OPERATION,
        reply.message,
        {
          userMessage: reply.message,
          remediationAction: `Set ${UNICORN_PYTHON_ENV_VAR} to an absolute caller-supplied Python executable with pwntools 4.15.0, pyelftools 0.33 and Unicorn 2.1.2; REA never installs Python or packages.`,
          capturedOutput,
        },
      );
    case "decoder":
      return new AnalysisOutputError(UNICORN_OPERATION, reply.message, {
        capturedOutput,
      });
  }
};

/**
 * Run one bridge invocation in its own directory and return the parsed
 * reply. The directory is removed afterwards, including on bridge crash,
 * timeout, and cancellation. Bridge resource exits 75/76 map to resource
 * constraint errors; any other nonzero exit without a reply is an output
 * error carrying the bounded captured output.
 */
export const runUnicornBridge = async (
  options: UnicornBridgeRunOptions,
): Promise<Result<UnicornBridgeReply, AnalysisError>> => {
  if (options.signal?.aborted)
    return err(
      new AnalysisCancelledError(UNICORN_OPERATION, {
        cause: options.signal.reason,
      }),
    );
  const runDir = await mkdtemp(
    join(options.runtimeDirBase ?? tmpdir(), "rea-unicorn-"),
  );
  try {
    const requestPath = join(runDir, "request.json");
    const replyPath = join(runDir, "reply.json");
    const failureMarkerPath = join(runDir, "failure.marker");
    await writeFile(
      requestPath,
      JSON.stringify({ ...options.request, reply_path: replyPath }),
      { flag: "wx", mode: 0o600 },
    );
    const launcher = options.launcher ?? defaultLauncher;
    let snapshot: ProviderProcessSnapshot;
    try {
      snapshot = await launcher(
        {
          command: options.pythonPath,
          arguments: ["-I", options.bridgePath, failureMarkerPath, requestPath],
          runId: randomUUID(),
        },
        options.timeoutMs,
        options.signal,
      );
    } catch (error) {
      if (error instanceof OwnedCommandFailure) {
        if (error.reason === "cancelled")
          return err(
            new AnalysisCancelledError(UNICORN_OPERATION, {
              cause: error.cancellation?.reason,
            }),
          );
        if (error.reason === "timeout")
          return err(
            new AnalysisTimeoutError(UNICORN_OPERATION, options.timeoutMs, {
              userMessage: `Unicorn emulation exceeded its ${String(options.timeoutMs)} ms budget.`,
            }),
          );
        return err(
          new AnalysisOutputError(
            UNICORN_OPERATION,
            `Unicorn bridge failed: ${error.message}`,
            {
              capturedOutput:
                error.snapshot === null ? undefined : captured(error.snapshot),
            },
          ),
        );
      }
      throw error;
    }
    const output = captured(snapshot);
    if (snapshot.exitCode === 75)
      return err(
        new AnalysisResourceConstraintError(
          UNICORN_OPERATION,
          "memory",
          "Unicorn bridge ran out of memory (exit 75).",
          null,
          {
            capturedOutput: output,
            remediationAction:
              "Reduce the function size, memory image, or stack size and retry.",
          },
        ),
      );
    if (snapshot.exitCode === 76)
      return err(
        new AnalysisResourceConstraintError(
          UNICORN_OPERATION,
          "file-size",
          "Unicorn bridge exceeded its output size (exit 76).",
          null,
          {
            capturedOutput: output,
            remediationAction:
              "Reduce the function size, memory image, or stack size and retry.",
          },
        ),
      );
    if (snapshot.exitCode !== 0)
      return err(
        new AnalysisOutputError(
          UNICORN_OPERATION,
          `Unicorn bridge exited ${String(snapshot.exitCode)} without writing a reply.`,
          { capturedOutput: output },
        ),
      );
    let replyText: string;
    try {
      replyText = await readFile(replyPath, "utf8");
    } catch {
      return err(
        new AnalysisOutputError(
          UNICORN_OPERATION,
          "Unicorn bridge exited 0 without writing a reply.",
          { capturedOutput: output },
        ),
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(replyText);
    } catch {
      return err(
        new AnalysisOutputError(
          UNICORN_OPERATION,
          "Unicorn bridge did not write a valid JSON reply.",
          { capturedOutput: output },
        ),
      );
    }
    const reply = unicornBridgeReplySchema.safeParse(parsed);
    if (!reply.success)
      return err(
        new AnalysisOutputError(
          UNICORN_OPERATION,
          "Unicorn bridge reply failed schema validation.",
          { capturedOutput: output },
        ),
      );
    if (reply.data.ok === false)
      return err(mapFailureReply(reply.data, output));
    return ok(reply.data);
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
};
