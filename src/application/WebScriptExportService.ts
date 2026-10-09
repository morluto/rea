import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

import { z } from "zod";

import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import { publishWebScripts } from "../browser/assets/PublishWebScripts.js";
import { selectScriptCapture } from "../browser/assets/ScriptCaptureAdapters.js";
import {
  AnalysisAccessDeniedError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../domain/analysisErrorCore.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { createEvidence, type Evidence } from "../domain/evidence.js";
import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { err, ok, type Result } from "../domain/result.js";
import { safeParseJson } from "../domain/safeJson.js";
import {
  exportWebScriptsInputSchema,
  type ExportWebScriptsInput,
} from "../domain/webScriptExport.js";
import { WebScriptExportError } from "../domain/webScriptExportError.js";
import type { ExecutionOptions } from "./AnalysisProvider.js";
import { WEB_SCRIPT_EXPORT_PROVIDER as PROVIDER } from "./InvestigationProviders.js";
import { NonRegularFileReadError, readRegularFile } from "./RegularFileRead.js";

const OPERATION = "export_web_scripts";

/** Export one local capture through the shared CLI/MCP application workflow. */
export const exportWebScripts = async (
  rawInput: unknown,
  options: ExecutionOptions = {},
): Promise<Result<Evidence, AnalysisError>> => {
  const input = exportWebScriptsInputSchema.safeParse(rawInput);
  return input.success
    ? exportWebScriptsValidated(input.data, options)
    : err(
        analysisInputErrorFromIssues(OPERATION, input.error.issues, rawInput),
      );
};

/** Publish input already parsed by a named adapter contract. */
export const exportWebScriptsValidated = async (
  input: ExportWebScriptsInput,
  options: ExecutionOptions = {},
): Promise<Result<Evidence, AnalysisError>> => {
  if (!isAbsolute(input.capture_path) || !isAbsolute(input.output_directory))
    return err(
      new AnalysisInputError(OPERATION, undefined, [
        {
          path: [],
          reason: "invalid_format",
          message:
            "capture_path and output_directory must be absolute filesystem paths on this host.",
        },
      ]),
    );
  try {
    options.signal?.throwIfAborted();
    const read = await readCapture(input.capture_path, options.signal);
    if (!read.ok) return read;
    const bytes = read.value;
    const loaded = parseCapture(bytes);
    if (!loaded.ok) return loaded;
    options.signal?.throwIfAborted();
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const result = await publishWebScripts(
      input,
      loaded.value,
      sha256,
      options.signal,
    );
    return ok(
      createEvidence(
        { path: input.capture_path, sha256, format: "file" },
        PROVIDER,
        {
          predicateType: "rea.web-script-export",
          operation: OPERATION,
          parameters: {
            capture_path: input.capture_path,
            output_directory: input.output_directory,
          },
          result: jsonValueSchema.parse(result),
          rawResult: null,
          confidence: "derived",
          authority: "historical-reference",
          limitations: result.limitations,
          locations: [{ kind: "artifact-path", path: result.manifest.path }],
          evidenceLinks:
            loaded.value.sourceEvidenceId === null
              ? []
              : [loaded.value.sourceEvidenceId],
        },
      ),
    );
  } catch (cause: unknown) {
    if (cause instanceof WebScriptExportError) return err(cause);
    if (options.signal?.aborted === true)
      return err(new AnalysisCancelledError(OPERATION));
    if (cause instanceof ArtifactReaderFailure)
      return err(
        new WebScriptExportError(
          cause.reason,
          input.output_directory,
          cause.message,
        ),
      );
    if (cause instanceof z.ZodError)
      return err(new AnalysisOutputError(OPERATION, cause.message, { cause }));
    if (
      cause instanceof Error &&
      "code" in cause &&
      typeof cause.code === "string"
    )
      return err(
        new WebScriptExportError(
          "io",
          `${input.capture_path} → ${input.output_directory}`,
          cause.message,
        ),
      );
    return err(
      new ProviderAdapterError(PROVIDER.id, OPERATION, {
        cause,
        diagnostics: {
          capture_path: input.capture_path,
          output_directory: input.output_directory,
          error_name: cause instanceof Error ? cause.name : "UnknownError",
          error_message:
            cause instanceof Error
              ? cause.message
              : typeof cause === "string"
                ? cause
                : "Unknown script export failure",
        },
      }),
    );
  }
};

/**
 * Read the caller-selected capture. A missing, non-file or unreadable
 * selection is a caller or host-permission failure, not an export failure.
 */
const readCapture = async (
  path: string,
  signal: AbortSignal | undefined,
): Promise<Result<Buffer, AnalysisError>> => {
  try {
    return ok(await readRegularFile(path, signal));
  } catch (cause: unknown) {
    const code =
      cause instanceof Error && "code" in cause ? String(cause.code) : "";
    if (code === "EACCES" || code === "EPERM")
      return err(
        new AnalysisAccessDeniedError(OPERATION, path, code, { cause }),
      );
    if (
      cause instanceof NonRegularFileReadError ||
      code === "ENOENT" ||
      code === "ENOTDIR" ||
      code === "EISDIR" ||
      code === "ENXIO"
    )
      return err(
        new AnalysisInputError(OPERATION, { cause }, [
          {
            path: ["capture_path"],
            reason: "invalid_value",
            message:
              cause instanceof NonRegularFileReadError && code !== "EISDIR"
                ? cause.message
                : code === "EISDIR"
                  ? `Selected capture is a directory, not a file: ${path}`
                  : `Selected capture could not be read (${code}): ${path}`,
          },
        ]),
      );
    throw cause;
  }
};

const parseCapture = (
  bytes: Buffer,
): Result<ReturnType<typeof selectScriptCapture>, AnalysisError> => {
  try {
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    const json = safeParseJson(text);
    if (!json.ok) throw new TypeError(json.error);
    return ok(selectScriptCapture(json.value));
  } catch (cause: unknown) {
    return err(
      new AnalysisInputError(OPERATION, { cause }, [
        {
          path: ["capture_path"],
          reason: "invalid_format",
          message:
            cause instanceof Error
              ? cause.message
              : "Capture is not valid UTF-8 JSON evidence.",
        },
      ]),
    );
  }
};
