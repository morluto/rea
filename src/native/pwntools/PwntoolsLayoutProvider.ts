import {
  pwntoolsLayoutFailure,
  pwntoolsUnavailable,
  capturedPwntoolsOutput,
} from "./PwntoolsFailures.js";
import { randomUUID } from "node:crypto";
import { access, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { ExecutionOptions } from "../../application/AnalysisProvider.js";
import type { BinaryLayoutPort } from "../../application/binaryDiagnostics/BinaryLayoutPort.js";
import { readStableArtifact } from "../../artifacts/readStableArtifact.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisResourceConstraintError,
} from "../../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import { err, ok, type Result } from "../../domain/result.js";
import {
  binaryLayoutPayloadSchema,
  binaryLayoutSchema,
  type BinaryLayout,
  type InspectBinaryLayoutInput,
} from "../../domain/native/binaryLayout.js";
import { runOwnedCommand } from "../../process/OwnedCommand.js";
import { OwnedCommandFailure } from "../../process/OwnedCommand.js";
import {
  pwntoolsResourceLimitsSchema,
  type PwntoolsLimitReport,
  type PwntoolsFailureEvidence,
} from "./PwntoolsResourceLimits.js";
import { PrivateRuntimeRoot } from "../../process/PrivateRuntimeRoot.js";
import {
  PWNTOOLS_PROVIDER_IDENTITY,
  PWNTOOLS_LIMITS,
  PWNTOOLS_FILE_SIZE_FAILURE_EXIT,
  PWNTOOLS_MEMORY_FAILURE_EXIT,
} from "./PwntoolsRelease.js";

const OPERATION = "inspect_binary_layout";
const decoded = binaryLayoutPayloadSchema;
const replySchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    profile: z.literal(PWNTOOLS_PROVIDER_IDENTITY.version),
    value: decoded,
  }),
  z.strictObject({
    ok: z.literal(false),
    reason: z.enum([
      "format",
      "unsupported",
      "unavailable",
      "resource-limit",
      "output-limit",
      "decoder",
    ]),
    message: z.string(),
    reported_limits: pwntoolsResourceLimitsSchema.nullable().optional(),
  }),
]);

type Launcher = NonNullable<Parameters<typeof runOwnedCommand>[2]>["launcher"];

/** Thin owned-process adapter; all ELF parsing and heuristics come from unchanged upstream code. */
export class PwntoolsLayoutProvider implements BinaryLayoutPort {
  readonly identity = PWNTOOLS_PROVIDER_IDENTITY;
  constructor(
    readonly environment: Readonly<NodeJS.ProcessEnv>,
    readonly launcher?: Launcher,
    readonly createRuntime: () => Promise<
      Pick<PrivateRuntimeRoot, "path" | "close">
    > = () => PrivateRuntimeRoot.create({ prefix: "rea-elf-layout-" }),
  ) {}

  /** Snapshot one explicit artifact and return complete static observations without launching the selected object as a host process. */
  async inspect(
    input: InspectBinaryLayoutInput,
    options?: ExecutionOptions,
  ): Promise<Result<BinaryLayout, AnalysisError>> {
    let root: Pick<PrivateRuntimeRoot, "path" | "close"> | undefined;
    let result: Result<BinaryLayout, AnalysisError>;
    let phase: "configuration" | "artifact-read" | "decoder" = "configuration";
    const executablePath = this.environment.REA_PWNTOOLS_PYTHON ?? "";
    let selectedPath = executablePath;
    try {
      if (options?.signal?.aborted) throw new AnalysisCancelledError(OPERATION);
      if (process.platform !== "linux" || process.arch !== "x64")
        throw new AnalysisCapabilityUnavailableError(
          this.identity.id,
          OPERATION,
          "The real-verified pwntools layout profile currently supports Linux x64 only.",
        );
      if (!isAbsolute(selectedPath))
        throw pwntoolsUnavailable(
          "Set REA_PWNTOOLS_PYTHON to an absolute caller-supplied Python executable with pwntools 4.15.0, pyelftools 0.33 and Unicorn 2.1.2; REA never installs Python or packages.",
          selectedPath,
        );
      await access(selectedPath, constants.X_OK);
      if (!(await stat(selectedPath)).isFile())
        throw pwntoolsUnavailable(
          "Selected Python executable must be a regular executable file, not a directory: " +
            selectedPath,
          selectedPath,
        );
      phase = "artifact-read";
      selectedPath = input.path;
      const snapshot = await readStableArtifact(
        input.path,
        PWNTOOLS_LIMITS.inputBytes,
        options?.signal,
      );
      phase = "decoder";
      root = await this.createRuntime();
      const requestPath = join(root.path, "request.json");
      const snapshotPath = join(root.path, "object.snapshot");
      const replyPath = join(root.path, "reply.json");
      await writeFile(snapshotPath, snapshot.bytes, {
        flag: "wx",
        mode: 0o600,
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      });
      await writeFile(
        requestPath,
        JSON.stringify({ snapshot_path: snapshotPath, reply_path: replyPath }),
        { flag: "wx", mode: 0o600 },
      );
      const execution = await runOwnedCommand(
        {
          command: this.environment.REA_PWNTOOLS_PYTHON ?? "",
          arguments: [
            "-I",
            fileURLToPath(
              new URL("../../../bridge/pwntools/layout.py", import.meta.url),
            ),
            join(root.path, "resource.failure"),
            requestPath,
          ],
          cwd: root.path,
          runId: `rea-elf-layout-${randomUUID()}`,
          hostEnvironment: {
            ...this.environment,
            PWNLIB_NOTERM: "1",
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
          ...(this.launcher === undefined ? {} : { launcher: this.launcher }),
        },
      );
      const capturedOutput = capturedPwntoolsOutput(execution);
      let reply: z.output<typeof replySchema>;
      try {
        const file = await readStableArtifact(
          replyPath,
          PWNTOOLS_LIMITS.outputBytes,
          options?.signal,
        );
        reply = replySchema.parse(JSON.parse(file.bytes.toString("utf8")));
      } catch (cause: unknown) {
        if (options?.signal?.aborted)
          throw new AnalysisCancelledError(OPERATION, { capturedOutput });
        throw new AnalysisOutputError(
          OPERATION,
          `Owned ELF decoder reply failed for ${input.path}: ${cause instanceof z.ZodError ? cause.issues[0]?.message + " at " + (cause.issues[0]?.path.map(String).join(".") ?? "root") : cause instanceof Error ? cause.message : String(cause)}`,
          { cause, capturedOutput },
        );
      }
      if (!reply.ok) {
        if (reply.reason === "resource-limit")
          throw new AnalysisResourceConstraintError(
            OPERATION,
            "memory",
            reply.message,
            reply.reported_limits ?? null,
            { capturedOutput },
          );
        if (reply.reason === "format")
          throw new AnalysisInputError(OPERATION, { capturedOutput }, [
            {
              path: ["path"],
              reason: "invalid_format",
              message: reply.message,
            },
          ]);
        if (reply.reason === "unavailable")
          throw pwntoolsUnavailable(
            reply.message,
            this.environment.REA_PWNTOOLS_PYTHON ?? "",
            undefined,
            capturedOutput,
          );
        if (reply.reason === "unsupported")
          throw new AnalysisCapabilityUnavailableError(
            this.identity.id,
            OPERATION,
            reply.message,
            { userMessage: reply.message, capturedOutput },
          );
        if (reply.reason === "output-limit")
          throw new AnalysisOutputError(OPERATION, reply.message, {
            capturedOutput,
          });
        throw new ProviderAdapterError(this.identity.id, OPERATION, {
          diagnostics: {
            phase,
            failure_kind: reply.reason,
            reason: reply.message,
            stdout: execution.stdout.text,
            stderr: execution.stderr.text,
            captured_output: { ...capturedOutput },
          },
        });
      }
      const validated = binaryLayoutSchema.safeParse({
        ...reply.value,
        artifact: {
          path: input.path,
          sha256: snapshot.sha256,
          bytes: snapshot.bytes.length,
        },
        diagnostics: {
          stdout: execution.stdout.text,
          stderr: execution.stderr.text,
          truncated: capturedOutput.truncated,
        },
      });
      if (!validated.success)
        throw new AnalysisOutputError(
          OPERATION,
          `ELF reply contains invalid source ranges or value meanings: ${validated.error.issues[0]?.message ?? "schema mismatch"}`,
          { capturedOutput },
        );
      for (const table of validated.data.packed_relative_relocations) {
        const start = Number(BigInt(table.location.offset));
        const length = Number(BigInt(table.location.bytes));
        if (
          !Buffer.from(table.encoded_bytes_base64, "base64").equals(
            snapshot.bytes.subarray(start, start + length),
          )
        )
          throw new AnalysisOutputError(
            OPERATION,
            "Reported packed relocation bytes differ from the selected snapshot at their original file range.",
            { capturedOutput },
          );
      }
      result = ok(validated.data);
    } catch (cause: unknown) {
      let limitReport: PwntoolsLimitReport | undefined;
      let marker: PwntoolsFailureEvidence["marker"];
      if (
        cause instanceof OwnedCommandFailure &&
        cause.snapshot?.signal === null &&
        (cause.snapshot.exitCode === PWNTOOLS_MEMORY_FAILURE_EXIT ||
          cause.snapshot.exitCode === PWNTOOLS_FILE_SIZE_FAILURE_EXIT) &&
        root !== undefined
      ) {
        try {
          const reported = await readStableArtifact(
            join(root.path, "resource.failure"),
            1,
          );
          const expected =
            cause.snapshot.exitCode === PWNTOOLS_MEMORY_FAILURE_EXIT
              ? "M"
              : "F";
          if (!reported.bytes.equals(Buffer.from(expected, "ascii")))
            throw new Error(
              "Private bridge failure marker does not match the observed exit status.",
            );
          marker = {
            resource: expected === "M" ? "memory" : "file-size",
            failure: null,
          };
        } catch (markerFailure: unknown) {
          marker = {
            resource: null,
            failure:
              markerFailure instanceof Error
                ? markerFailure.message
                : String(markerFailure),
          };
        }
      }
      if (
        cause instanceof OwnedCommandFailure &&
        (cause.snapshot?.signal === "SIGXCPU" ||
          cause.snapshot?.signal === "SIGXFSZ" ||
          ((cause.snapshot?.exitCode === PWNTOOLS_FILE_SIZE_FAILURE_EXIT ||
            cause.snapshot?.exitCode === PWNTOOLS_MEMORY_FAILURE_EXIT) &&
            cause.snapshot.signal === null)) &&
        root !== undefined
      ) {
        try {
          const reported = await readStableArtifact(
            join(root.path, "limits.json"),
            4096,
          );
          limitReport = {
            limits: pwntoolsResourceLimitsSchema.parse(
              JSON.parse(reported.bytes.toString("utf8")),
            ),
            failure: null,
          };
        } catch (reportFailure: unknown) {
          limitReport = {
            limits: null,
            failure:
              reportFailure instanceof Error
                ? reportFailure.message
                : String(reportFailure),
          };
        }
      }
      result = err(
        options?.signal?.aborted &&
          (cause === options.signal.reason ||
            (cause instanceof Error && cause.name === "AbortError"))
          ? new AnalysisCancelledError(OPERATION)
          : pwntoolsLayoutFailure(cause, phase, selectedPath, executablePath, {
              ...(limitReport === undefined ? {} : { limits: limitReport }),
              ...(marker === undefined ? {} : { marker }),
            }),
      );
    }
    if (root !== undefined) {
      try {
        await root.close();
      } catch (cause: unknown) {
        return err(
          new ProviderCleanupError(
            this.identity.id,
            [root.path],
            {
              reason: cause instanceof Error ? cause.message : String(cause),
              previous_error: result.ok
                ? null
                : projectAnalysisError(result.error),
              ...(result.ok
                ? {
                    captured_output: {
                      stdout: result.value.diagnostics.stdout,
                      stderr: result.value.diagnostics.stderr,
                      truncated: result.value.diagnostics.truncated,
                    },
                  }
                : {}),
            },
            { operation: OPERATION },
          ),
        );
      }
    }
    return result.ok && options?.signal?.aborted
      ? err(
          new AnalysisCancelledError(OPERATION, {
            capturedOutput: {
              stdout: result.value.diagnostics.stdout,
              stderr: result.value.diagnostics.stderr,
              truncated: result.value.diagnostics.truncated,
            },
          }),
        )
      : result;
  }
}
