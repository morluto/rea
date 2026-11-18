import { z } from "zod";
import type { ContractCommandContext } from "./contractCommand.js";
import type { AnalysisViewRequest } from "../domain/analysisView/analysisViewRequest.js";
import { publishCliAnalysisEvidence } from "./analysisEvidenceDelivery.js";
import { JAVASCRIPT_APPLICATION_PROVIDER } from "../domain/investigationProviders.js";
import { createProgressReporter } from "../ports/ProgressReporter.js";
import {
  ArtifactReaderFailure,
  ArtifactResourceScope,
} from "../resources/index.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { completeProviderEvidence } from "../application/ProviderOperationExecution.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";
import { javaScriptSourcePathsSchema } from "../domain/javascript/javascriptSourceSelection.js";
import { parseCliJsonInput } from "./cliJsonInput.js";
import { writeCliProgressLine } from "./cliProgress.js";
import { ownCliProcessResource } from "./cliResources.js";

const OPERATION = "analyze_javascript_application";

/**
 * Combine repeated `--source-path` values with `--source-paths-json`, an inline
 * JSON array or a JSON file. A file keeps large selections below the host
 * command-line limit; entries remain exact application-relative paths and are
 * not resolved against the working directory.
 */
export const cliJavaScriptSourcePaths = async (
  sourcePath: readonly string[] | undefined,
  sourcePathsJson: string | undefined,
  signal?: AbortSignal,
): Promise<
  | { readonly ok: true; readonly value: readonly string[] | undefined }
  | { readonly ok: false; readonly error: JsonValue }
> => {
  if (sourcePathsJson === undefined) return { ok: true, value: sourcePath };
  const input = await parseCliJsonInput(sourcePathsJson, OPERATION, signal);
  if (!input.ok) return input;
  const parsed = javaScriptSourcePathsSchema.safeParse(input.value);
  if (!parsed.success)
    return {
      ok: false,
      error: cliError(
        analysisInputErrorFromIssues(
          OPERATION,
          parsed.error.issues.map((issue) => ({
            ...issue,
            path: ["source_paths_json", ...issue.path],
          })),
          { source_paths_json: input.value },
        ),
      ),
    };
  return { ok: true, value: [...(sourcePath ?? []), ...parsed.data] };
};

/**
 * One parked JavaScript worker for one CLI host. A healthy worker stays
 * parked between that host's commands. Independent hosts do not share it.
 */
export class CliJavaScriptAnalysisHost {
  #retainedScope: ArtifactResourceScope | undefined;
  /** One shutdown shared by the exit callback and the dispatch `finally`. */
  #closing: Promise<void> | undefined;

  scope(): ArtifactResourceScope {
    this.#retainedScope ??= new ArtifactResourceScope();
    return this.#retainedScope;
  }

  /**
   * Stop this host's worker. Overlapping callers share the attempt in flight.
   * The scope stays owned when shutdown fails, so the next call retries.
   */
  close(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing;
    const scope = this.#retainedScope;
    if (scope === undefined) return Promise.resolve();
    let published: Promise<void>;
    published = scope
      .close()
      .then(() => {
        if (this.#retainedScope === scope) this.#retainedScope = undefined;
      })
      .finally(() => {
        if (this.#closing === published) this.#closing = undefined;
      });
    this.#closing = published;
    return published;
  }
}

/** Process CLI host used when a caller does not pass its own host. */
const processJavaScriptAnalysis = new CliJavaScriptAnalysisHost();

ownCliProcessResource("javascript-analysis", () =>
  processJavaScriptAnalysis.close(),
);

/** Execute the shared CLI boundary for static JavaScript analysis. */
export const runCliJavaScriptApplicationAnalysis = async (
  input: unknown,
  environment: Readonly<Record<string, string | undefined>>,
  signal?: AbortSignal,
  delivery?: {
    readonly detail: "complete" | "summary";
    readonly evidenceOutput: string | undefined;
    readonly view?: AnalysisViewRequest;
  },
  host: CliJavaScriptAnalysisHost = processJavaScriptAnalysis,
): Promise<JsonValue> => {
  const [{ analyzeJavaScriptApplication }, { javascriptSourceAnalysis }] =
    await Promise.all([
      import("../application/javascript/JavaScriptApplicationService.js"),
      import("../composition/javascriptSourceAnalysis.js"),
    ]);
  const progress = createProgressReporter(
    async (update) => {
      writeCliProgressLine(update);
    },
    { minimumIntervalMs: 0 },
  );
  const resources = host.scope();
  const result = await analyzeJavaScriptApplication(input, resources, {
    sourceAnalysis: javascriptSourceAnalysis,
    environment,
    progress,
    ...(signal === undefined ? {} : { signal }),
  });
  try {
    // Retry failed owners without stopping a healthy parked worker.
    await resources.retryCleanup();
  } catch (cause: unknown) {
    const cleanup = ArtifactReaderFailure.cleanupObservation(
      cause,
      "JavaScript application resources",
    );
    const failure = new ProviderCleanupError(
      JAVASCRIPT_APPLICATION_PROVIDER.id,
      cleanup.resources,
      { reason: cleanup.reason },
      { cause, operation: "analyze_javascript_application" },
    );
    const completed = result.ok
      ? completeProviderEvidence(result.value, signal)
      : result;
    if (completed.ok) failure.retainPartialObservation(completed.value);
    return cliError(
      completed.ok
        ? failure
        : analysisErrorWithCleanupFailure(
            completed.error,
            failure,
            "analyze_javascript_application",
          ),
    );
  }
  const completed = result.ok
    ? completeProviderEvidence(result.value, signal)
    : result;
  const finalized = completed.ok
    ? completed
    : { ok: false as const, error: cliError(completed.error) };
  return delivery === undefined
    ? finalized.ok
      ? finalized.value
      : finalized.error
    : publishCliAnalysisEvidence(finalized, {
        ...delivery,
        operation: "analyze_javascript_application",
        signal: signal ?? new AbortController().signal,
      });
};

const cliError = (
  error: Parameters<typeof projectAnalysisError>[0],
): JsonValue => ({
  error: "JavaScript application analysis failed",
  ...projectAnalysisError(error),
});

/**
 * How the CLI spells `analyze_javascript_application` beyond its contract:
 * the target positional, the artifact-format and source-path names, and the
 * options whose values may be JSON files rather than argv text.
 */
export const javaScriptApplicationCliProjection = (target: string) =>
  ({
    positionals: ["input_path"],
    callerPaths: ["input_path"],
    fields: {
      input_path: { name: "path", description: target },
      format: {
        name: "artifactFormat",
        description: "Application artifact format",
      },
      source_paths: { name: "sourcePath" },
      integrity_policy: {
        description:
          "Behavior when declared application integrity does not match",
      },
      semantic_precision: {
        description:
          "Inline JSON or JSON file with per-source semantic_precision evaluator budgets; independent of graph retention and worker memory.",
      },
    },
    jsonInputs: {
      semantic_precision:
        "semanticPrecision must be inline JSON or a JSON file path",
    },
    cliOptions: {
      sourcePathsJson: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Inline JSON array or JSON file path of exact inventoried file paths relative to the application root, selected after any --source-path values. Use a file for selections that exceed the host command-line limit.",
        ),
    },
  }) as const;

/**
 * Run `analyze_javascript_application` on its admitted contract input,
 * adding the file-backed source selection and
 * delivering Evidence as the caller selected.
 */
export const runJavaScriptApplicationCommand =
  (environment: Readonly<Record<string, string | undefined>>) =>
  async (
    input: object & { readonly source_paths?: readonly string[] | undefined },
    {
      signal,
      delivery,
      cliOptions,
    }: ContractCommandContext<{
      readonly sourcePathsJson?: string | undefined;
    }>,
  ): Promise<JsonValue> => {
    const sourcePaths = await cliJavaScriptSourcePaths(
      input.source_paths,
      cliOptions.sourcePathsJson,
      signal,
    );
    if (!sourcePaths.ok) return sourcePaths.error;
    return runCliJavaScriptApplicationAnalysis(
      {
        ...input,
        ...(sourcePaths.value === undefined
          ? {}
          : { source_paths: sourcePaths.value }),
      },
      environment,
      signal,
      delivery,
    );
  };
