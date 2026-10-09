import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat as statPath } from "node:fs/promises";
import { resolve } from "node:path";

import {
  AnalysisAccessDeniedError,
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisTimeoutError,
} from "../../domain/analysisErrorCore.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import { err, ok, type Result } from "../../domain/result.js";
import {
  objdumpInputSchema,
  rizinInputSchema,
} from "../../domain/reverseEngineering.js";
import { objdumpCommand } from "../../objdump/ObjdumpCommand.js";
import { OBJDUMP_PROVIDER_IDENTITY } from "../../objdump/ObjdumpCommand.js";
import {
  execFileOutput,
  execFileOutputFailure,
} from "../../process/ExecFileOutput.js";
import { rizinCommand } from "../../rizin/RizinCommand.js";
import { RIZIN_PROVIDER_IDENTITY } from "../../rizin/RizinCommand.js";

export type ReverseEngineeringOperation =
  | "inspect_with_objdump"
  | "execute_rizin_command";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES_PER_STREAM = 16 * 1024 * 1024;

/** Shared application workflow for caller-selected local analysis commands. */
export class ReverseEngineeringService {
  readonly #environment: Readonly<NodeJS.ProcessEnv>;
  readonly #run: typeof execFileOutput;

  constructor(
    options: {
      readonly environment?: Readonly<NodeJS.ProcessEnv>;
      readonly run?: typeof execFileOutput;
    } = {},
  ) {
    this.#environment = options.environment ?? process.env;
    this.#run = options.run ?? execFileOutput;
  }

  inspectWithObjdump(
    rawInput: unknown,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<Result<Evidence, AnalysisError>> {
    const parsed = objdumpInputSchema.safeParse(rawInput);
    if (!parsed.success)
      return Promise.resolve(
        err(new AnalysisInputError("inspect_with_objdump")),
      );
    const input = parsed.data;
    return this.#observe(
      "inspect_with_objdump",
      this.#environment.REA_OBJDUMP_COMMAND ?? "objdump",
      objdumpCommand(input),
      input.path,
      input,
      options.signal,
      { DEBUGINFOD_URLS: "" },
    );
  }

  executeRizinCommand(
    rawInput: unknown,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<Result<Evidence, AnalysisError>> {
    const parsed = rizinInputSchema.safeParse(rawInput);
    if (!parsed.success)
      return Promise.resolve(
        err(new AnalysisInputError("execute_rizin_command")),
      );
    const input = parsed.data;
    return this.#observe(
      "execute_rizin_command",
      this.#environment.REA_RIZIN_COMMAND ?? "rizin",
      rizinCommand(input),
      input.path,
      input,
      options.signal,
    );
  }

  async #observe(
    operation: ReverseEngineeringOperation,
    command: string,
    args: readonly string[],
    path: string,
    parameters: Readonly<Record<string, JsonValue>>,
    signal?: AbortSignal,
    environmentOverrides: Readonly<NodeJS.ProcessEnv> = {},
  ): Promise<Result<Evidence, AnalysisError>> {
    if (signal?.aborted) return err(new AnalysisCancelledError(operation));
    const absolutePath = resolve(path);
    let digest: string;
    try {
      digest = await digestFile(absolutePath, signal);
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (signal?.aborted)
        return err(new AnalysisCancelledError(operation, { cause }));
      if (code === "EACCES" || code === "EPERM")
        return err(
          new AnalysisAccessDeniedError(operation, absolutePath, code, {
            cause,
          }),
        );
      if (code === "ETIMEDOUT")
        return err(
          new AnalysisTimeoutError(operation, DEFAULT_TIMEOUT_MS, { cause }),
        );
      return err(new AnalysisInputError(operation, { cause }));
    }
    let stdout = "";
    let stderr = "";
    let exitCode: number | string | null = 0;
    let signalName: string | null = null;
    let outputTruncated = false;
    let completionStatus: "complete" | "unknown" = "complete";
    try {
      const output = await this.#run(command, args, {
        env: {
          ...process.env,
          ...this.#environment,
          ...environmentOverrides,
        },
        signal,
        timeout: DEFAULT_TIMEOUT_MS,
        stopSignal: "SIGTERM",
        maxBuffer: MAX_OUTPUT_BYTES_PER_STREAM,
      });
      stdout = output.stdout;
      stderr = output.stderr;
    } catch (cause) {
      const capture = execFileOutputFailure(cause);
      const code =
        capture?.code ?? (cause as NodeJS.ErrnoException).code ?? undefined;
      if (signal?.aborted || code === "ABORT_ERR")
        return err(new AnalysisCancelledError(operation, { cause }));
      if (code === "ETIMEDOUT")
        return err(
          new AnalysisTimeoutError(operation, DEFAULT_TIMEOUT_MS, { cause }),
        );
      if (code === "EACCES" || code === "EPERM")
        return err(
          new AnalysisAccessDeniedError(operation, command, code, { cause }),
        );
      if (capture === undefined || code === "ENOENT") {
        return err(
          new AnalysisCapabilityUnavailableError(
            operation === "inspect_with_objdump" ? "objdump" : "rizin",
            operation,
            `Unable to run configured command (${String(code ?? "unknown error")})`,
            { cause },
          ),
        );
      }
      stdout = capture.stdout;
      stderr = capture.stderr;
      exitCode = capture.code;
      signalName = capture.signal;
      outputTruncated = capture.outputTruncated;
      if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
        exitCode = null;
        completionStatus = "unknown";
      }
    }
    let digestAfter: string | null = null;
    try {
      digestAfter = await digestFile(absolutePath);
    } catch {
      // Preserve the provider's collected observations if the artifact vanished or became unreadable.
    }
    const artifactChanged =
      digestAfter === null ? null : digestAfter !== digest;
    const result = {
      stdout,
      stderr,
      exit_code: exitCode,
      signal: signalName,
      output_truncated: outputTruncated,
      completion_status: completionStatus,
      artifact_sha256_after: digestAfter,
      artifact_changed: artifactChanged,
    };
    const limitations = [
      "The executable version and supported formats are reported as unknown because no reliable version probe was performed.",
      "A non-zero process exit is preserved as an observed command result.",
      ...(completionStatus === "unknown"
        ? [
            "The output buffer limit terminated the child process; captured output is partial and command completion is unknown.",
          ]
        : []),
      "Pre-run and post-run digests detect artifact changes across the provider call but cannot prove the exact bytes consumed during the call.",
      ...(artifactChanged === true
        ? [
            "The provider command may have changed the artifact while analysis was running; pre-run and post-run digests are both reported.",
          ]
        : []),
      ...(digestAfter === null
        ? [
            "The post-run artifact digest is unknown because the artifact could not be read after the provider call.",
          ]
        : []),
    ];
    const evidence = createEvidence(
      { path: absolutePath, sha256: digest, format: "unknown" },
      operation === "inspect_with_objdump"
        ? OBJDUMP_PROVIDER_IDENTITY
        : RIZIN_PROVIDER_IDENTITY,
      {
        predicateType: "rea.reverse-engineering.command-observation",
        operation,
        parameters: { ...parameters, command, command_arguments: [...args] },
        rawResult: result,
        result,
        limitations,
        locations: [{ kind: "artifact-path", path: absolutePath }],
      },
    );
    return ok(evidence);
  }
}

const digestFile = async (
  path: string,
  signal?: AbortSignal,
): Promise<string> => {
  const info = await statPath(path);
  if (!info.isFile())
    throw Object.assign(new Error("Artifact digest requires a regular file"), {
      code: "EINVAL",
    });
  return new Promise<string>((resolveDigest, rejectDigest) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    const timer = setTimeout(
      () =>
        stream.destroy(
          Object.assign(new Error("Artifact digest timed out"), {
            code: "ETIMEDOUT",
          }),
        ),
      DEFAULT_TIMEOUT_MS,
    );
    const abort = (): void => {
      stream.destroy(new AnalysisCancelledError("artifact_digest"));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    if (signal?.aborted) {
      cleanup();
      stream.destroy();
      rejectDigest(new AnalysisCancelledError("artifact_digest"));
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    stream.on("data", (chunk: Buffer | string) => hash.update(chunk));
    stream.once("error", (cause: Error) => {
      cleanup();
      rejectDigest(cause);
    });
    stream.once("end", () => {
      cleanup();
      resolveDigest(hash.digest("hex"));
    });
  });
};
