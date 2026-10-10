import { z } from "zod";

import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import {
  analyzeJavaScriptApplicationInputSchema,
  parseOwnedJavaScriptApplicationAnalysisSteps,
} from "../../domain/javascript/javascriptApplicationAnalysis.js";
import {
  AnalysisAccessDeniedError,
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisUnsupportedTargetError,
} from "../../domain/analysisErrorCore.js";
import { ArtifactOperationError } from "../../domain/artifactOperationError.js";
import { type AnalysisError } from "../../domain/analysisErrorBase.js";
import type { Evidence } from "../../domain/evidence.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import { err, ok, type Result } from "../../domain/result.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import type { ExecutionOptions } from "../AnalysisProvider.js";
import { createOwnedJavaScriptApplicationEvidenceCooperatively } from "./JavaScriptApplicationEvidence.js";
import {
  assertJavaScriptAnalysisActive,
  checkpointJavaScriptAnalysis,
  completeJavaScriptAnalysisSteps,
} from "./JavaScriptAnalysisControl.js";
import { reconstructJavaScriptArtifact } from "./JavaScriptArtifactReconstruction.js";
import { JAVASCRIPT_APPLICATION_PROVIDER } from "../InvestigationProviders.js";

const OPERATION = "analyze_javascript_application" as const;

/** Statically analyze one local JavaScript/Electron application. */
export const analyzeJavaScriptApplication = async (
  rawInput: unknown,
  options: ExecutionOptions = {},
): Promise<Result<Evidence, AnalysisError>> => {
  const parsed = analyzeJavaScriptApplicationInputSchema.safeParse(rawInput);
  if (!parsed.success)
    return err(
      analysisInputErrorFromIssues(OPERATION, parsed.error.issues, rawInput),
    );
  return analyzeJavaScriptApplicationValidated(parsed.data, options);
};

/** Analyze input already parsed by a trusted adapter boundary. */
export const analyzeJavaScriptApplicationValidated = async (
  input: z.output<typeof analyzeJavaScriptApplicationInputSchema>,
  options: ExecutionOptions = {},
): Promise<Result<Evidence, AnalysisError>> => {
  try {
    assertJavaScriptAnalysisActive(options.signal);
    await options.progress?.report({
      phase: "analyze_javascript_application",
      completed: 0,
      total: 1,
      message: "Inventorying and parsing application artifacts",
    });
    await checkpointJavaScriptAnalysis(options.signal);
    const reconstructed = await reconstructJavaScriptArtifact(
      {
        input_path: input.input_path,
        format: input.format,
        integrity_policy: input.integrity_policy,
      },
      options.signal,
      options.progress,
    );
    const { electron_summary: summary, ...application } = reconstructed;
    await options.progress?.report({
      phase: "validate_javascript_application_result",
      completed: 0,
      total: 1,
      message: "Validating result metadata and cross-graph bindings",
    });
    await checkpointJavaScriptAnalysis(options.signal);
    const result = await completeJavaScriptAnalysisSteps(
      parseOwnedJavaScriptApplicationAnalysisSteps({
        ...application,
        summary,
        limitations: reconstructed.graph.limitations,
      }),
      options.signal,
    );
    await options.progress?.report({
      phase: "create_javascript_application_evidence",
      completed: 0,
      total: 1,
      message: "Creating and hashing application analysis Evidence",
    });
    await checkpointJavaScriptAnalysis(options.signal);
    const evidence =
      await createOwnedJavaScriptApplicationEvidenceCooperatively(
        input,
        result,
        options.signal,
        options.progress,
      );
    await checkpointJavaScriptAnalysis(options.signal);
    await options.progress?.report({
      phase: "analyze_javascript_application",
      completed: 1,
      total: 1,
      message: "Application graph and Electron boundaries reconstructed",
      terminal: true,
    });
    assertJavaScriptAnalysisActive(options.signal);
    return ok(evidence);
  } catch (cause: unknown) {
    // Input selection failures are already typed by their cause.
    if (
      cause instanceof AnalysisInputError ||
      cause instanceof AnalysisUnsupportedTargetError ||
      cause instanceof AnalysisAccessDeniedError
    )
      return err(cause);
    if (cause instanceof ArtifactReaderFailure)
      return err(
        new ArtifactOperationError(
          OPERATION,
          cause.reason,
          cause.details,
          cause.message,
        ),
      );
    if (cause instanceof z.ZodError)
      return err(
        new AnalysisOutputError(OPERATION, describeResultSchemaFailure(cause), {
          cause,
        }),
      );
    if (
      cause instanceof Error &&
      "code" in cause &&
      typeof cause.code === "string" &&
      FILESYSTEM_ERROR_CODES.has(cause.code)
    )
      return err(new ArtifactOperationError(OPERATION, "io"));
    return err(
      new ProviderAdapterError(JAVASCRIPT_APPLICATION_PROVIDER.id, OPERATION, {
        cause,
        diagnostics: {
          input_path: input.input_path,
          error_name: cause instanceof Error ? cause.name : "UnknownError",
          error_message:
            cause instanceof Error
              ? cause.message
              : typeof cause === "string"
                ? cause
                : "JavaScript analysis failed with a non-Error value",
        },
      }),
    );
  }
};

const describeResultSchemaFailure = (cause: z.ZodError): string => {
  const issue = cause.issues[0];
  if (issue === undefined) return "Result schema rejected an unknown issue";
  const path = issue.path.flatMap((part) =>
    typeof part === "string" || typeof part === "number" ? [part] : [],
  );
  const pointer =
    path.length === 0
      ? "/"
      : `/${path.map((part) => escapePointerPart(String(part))).join("/")}`;
  return `Result schema rejected ${String(cause.issues.length)} ${cause.issues.length === 1 ? "issue" : "issues"} at ${pointer} (${issue.code})`;
};

const escapePointerPart = (part: string): string =>
  part.replaceAll("~", "~0").replaceAll("/", "~1");

const FILESYSTEM_ERROR_CODES = new Set([
  "ENOENT",
  "EACCES",
  "EPERM",
  "ENOTDIR",
  "EISDIR",
  "EIO",
  "ELOOP",
  "ENAMETOOLONG",
  "EMFILE",
  "ENFILE",
  "ENOSPC",
  "EROFS",
]);
