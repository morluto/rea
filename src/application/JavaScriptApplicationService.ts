import { z } from "zod";

import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import {
  analyzeJavaScriptApplicationInputSchema,
  javascriptApplicationAnalysisResultSchema,
} from "../domain/javascriptApplicationAnalysis.js";
import {
  AnalysisInputError,
  AnalysisProtocolError,
} from "../domain/analysisErrorCore.js";
import { ArtifactOperationError } from "../domain/artifactOperationError.js";
import { type AnalysisError } from "../domain/analysisErrorBase.js";
import type { Evidence } from "../domain/evidence.js";
import { projectInputIssues } from "../domain/inputIssueProjection.js";
import { err, ok, type Result } from "../domain/result.js";
import type { ExecutionOptions } from "./AnalysisProvider.js";
import { createJavaScriptApplicationEvidence } from "./JavaScriptApplicationEvidence.js";
import { reconstructJavaScriptArtifact } from "./JavaScriptArtifactReconstruction.js";

const OPERATION = "analyze_javascript_application" as const;

/** Statically analyze one local JavaScript/Electron application. */
export const analyzeJavaScriptApplication = async (
  rawInput: unknown,
  options: ExecutionOptions = {},
): Promise<Result<Evidence, AnalysisError>> => {
  const parsed = analyzeJavaScriptApplicationInputSchema.safeParse(rawInput);
  if (!parsed.success)
    return err(
      new AnalysisInputError(
        OPERATION,
        undefined,
        projectInputIssues(parsed.error.issues, rawInput),
      ),
    );
  return analyzeJavaScriptApplicationValidated(parsed.data, options);
};

/** Analyze input already parsed by a trusted adapter boundary. */
export const analyzeJavaScriptApplicationValidated = async (
  input: z.output<typeof analyzeJavaScriptApplicationInputSchema>,
  options: ExecutionOptions = {},
): Promise<Result<Evidence, AnalysisError>> => {
  await options.progress?.report({
    phase: "analyze_javascript_application",
    completed: 0,
    total: 1,
    message: "Inventorying and parsing application artifacts",
  });
  try {
    const reconstructed = await reconstructJavaScriptArtifact(
      {
        input_path: input.input_path,
        format: input.format,
      },
      options.signal,
    );
    const { electron_summary: summary, ...application } = reconstructed;
    const result = javascriptApplicationAnalysisResultSchema.parse({
      ...application,
      summary,
      limitations: reconstructed.graph.limitations,
    });
    await options.progress?.report({
      phase: "analyze_javascript_application",
      completed: 1,
      total: 1,
      message: "Application graph and Electron boundaries reconstructed",
      terminal: true,
    });
    return ok(createJavaScriptApplicationEvidence(input, result));
  } catch (cause: unknown) {
    if (cause instanceof ArtifactReaderFailure)
      return err(
        new ArtifactOperationError(OPERATION, cause.reason, cause.details),
      );
    if (cause instanceof z.ZodError)
      return err(
        new AnalysisProtocolError(
          "JavaScript application analysis produced an invalid result",
          { cause },
        ),
      );
    return err(new ArtifactOperationError(OPERATION, "io"));
  }
};
