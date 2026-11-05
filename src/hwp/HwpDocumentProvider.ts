import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute } from "node:path";
import { stat } from "node:fs/promises";

import {
  createAnalysisExecution,
  type AnalysisExecution,
  type ExecutionOptions,
} from "../application/AnalysisProvider.js";
import type { HwpDocumentPort } from "../application/hwp/HwpDocumentPort.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisAccessDeniedError,
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisResourceConstraintError,
} from "../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import {
  hwpDocumentSchema,
  type InspectHwpDocumentInput,
  HWP_PROVIDER_IDENTITY,
} from "../domain/hwp/hwpDocument.js";
import { err, ok, type Result } from "../domain/result.js";

const execFileAsync = promisify(execFile);

const OPERATION = "inspect_hwp_document";
/** Maximum HWP file size: 128 MiB. */
const INPUT_BYTES = 128 * 1024 * 1024;
/** Maximum JSON output from the parser: 32 MiB. */
const OUTPUT_BYTES = 32 * 1024 * 1024;
/** Subprocess deadline: 60 seconds. */
const TIMEOUT_MS = 60_000;

const resolveCommand = (
  environment: Readonly<NodeJS.ProcessEnv>,
): string | undefined => {
  const explicit = environment.REA_HWP_RS_COMMAND;
  if (explicit !== undefined && explicit !== "") return explicit;
  return undefined;
};

const failureFor = (
  cause: unknown,
  path: string,
  signal?: AbortSignal,
): AnalysisError => {
  if (cause instanceof AnalysisError) return cause;
  if (signal?.aborted) return new AnalysisCancelledError(OPERATION);
  if (cause instanceof Error && "code" in cause) {
    if (cause.code === "EACCES" || cause.code === "EPERM")
      return new AnalysisAccessDeniedError(OPERATION, path, cause.code, {
        cause,
      });
    if (
      ["ENOENT", "ENOTDIR", "ELOOP", "ENAMETOOLONG"].includes(
        String(cause.code),
      )
    )
      return new AnalysisInputError(OPERATION, { cause }, [
        {
          path: ["path"],
          reason: "invalid_value",
          message: `Selected document could not be read (${String(cause.code)}): ${path}.`,
        },
      ]);
  }
  return new ProviderAdapterError(HWP_PROVIDER_IDENTITY.id, OPERATION, {
    cause,
    diagnostics: {
      path,
      reason: cause instanceof Error ? cause.message : String(cause),
    },
  });
};

/** Spawn the hwp-rs json_dump binary to parse an HWP/HWPX document. */
export class HwpDocumentProvider implements HwpDocumentPort {
  readonly #command: string | undefined;

  constructor(readonly environment: Readonly<NodeJS.ProcessEnv> = process.env) {
    this.#command = resolveCommand(environment);
  }

  async inspect(
    input: InspectHwpDocumentInput,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(OPERATION));

    const command = this.#command;
    if (command === undefined)
      return err(
        new AnalysisCapabilityUnavailableError(
          HWP_PROVIDER_IDENTITY.id,
          OPERATION,
          "REA_HWP_RS_COMMAND is not configured. Set it to the absolute path of the hwp-rs json_dump binary.",
          {
            userMessage:
              "HWP document inspection requires the hwp-rs json_dump binary. Set REA_HWP_RS_COMMAND to its absolute path.",
          },
        ),
      );

    if (!isAbsolute(command))
      return err(
        new AnalysisCapabilityUnavailableError(
          HWP_PROVIDER_IDENTITY.id,
          OPERATION,
          `REA_HWP_RS_COMMAND must be an absolute path, got: ${command}`,
          {
            userMessage: `REA_HWP_RS_COMMAND must be an absolute path, got: ${command}`,
          },
        ),
      );

    try {
      return await this.#inspect(input, options);
    } catch (cause: unknown) {
      return err(failureFor(cause, input.path, options?.signal));
    }
  }

  async #inspect(
    input: InspectHwpDocumentInput,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    const command = this.#command!;

    // Validate file exists and is within size limits.
    const fileStat = await stat(input.path);
    if (!fileStat.isFile())
      throw new AnalysisInputError(OPERATION, undefined, [
        {
          path: ["path"],
          reason: "invalid_format",
          message: `Expected a regular file: ${input.path}`,
        },
      ]);
    if (fileStat.size > INPUT_BYTES)
      throw new AnalysisResourceConstraintError(
        OPERATION,
        "file-size",
        `Selected document exceeds ${String(INPUT_BYTES)} bytes: ${input.path}`,
        { maximum_input_bytes: INPUT_BYTES },
      );

    if (options?.signal?.aborted) throw new AnalysisCancelledError(OPERATION);

    // Spawn the Rust binary.
    let stdout: string;
    try {
      const result = await execFileAsync(command, [input.path], {
        maxBuffer: OUTPUT_BYTES,
        timeout: TIMEOUT_MS,
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      });
      stdout = result.stdout;
    } catch (cause: unknown) {
      if (cause instanceof Error && "killed" in cause && cause.killed)
        throw new AnalysisResourceConstraintError(
          OPERATION,
          "cpu",
          `HWP parser exceeded the ${String(TIMEOUT_MS)}ms deadline for ${input.path}`,
          { timeout_ms: TIMEOUT_MS },
          { cause },
        );
      if (
        cause instanceof Error &&
        "stderr" in cause &&
        typeof cause.stderr === "string" &&
        cause.stderr.length > 0
      ) {
        // Try to extract structured error from stderr JSON.
        try {
          const stderrJson = JSON.parse(cause.stderr) as {
            error?: string;
          };
          if (stderrJson.error !== undefined)
            throw new AnalysisOutputError(
              OPERATION,
              `HWP parser failed: ${stderrJson.error}`,
              { cause },
            );
        } catch {
          // stderr was not JSON; fall through.
        }
        throw new AnalysisOutputError(
          OPERATION,
          `HWP parser failed for ${input.path}: ${cause.stderr}`,
          { cause },
        );
      }
      throw cause;
    }

    if (options?.signal?.aborted) throw new AnalysisCancelledError(OPERATION);

    // Parse and validate the JSON output.
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch (cause: unknown) {
      throw new AnalysisOutputError(
        OPERATION,
        `HWP parser returned invalid JSON for ${input.path}`,
        { cause },
      );
    }

    const validated = hwpDocumentSchema.safeParse(parsed);
    if (!validated.success)
      throw new AnalysisOutputError(
        OPERATION,
        `HWP parser returned schema-invalid data for ${input.path}: ${validated.error.issues[0]?.message ?? "schema mismatch"}`,
        { cause: validated.error },
      );

    const report = validated.data;
    return ok(
      createAnalysisExecution(report, HWP_PROVIDER_IDENTITY, {
        rawResult: null,
        subject: {
          path: input.path,
          format: "file",
          sha256: report.artifact.sha256,
        },
        locations: [{ kind: "artifact-path", path: input.path }],
        limitations: report.limitations,
      }),
    );
  }
}
