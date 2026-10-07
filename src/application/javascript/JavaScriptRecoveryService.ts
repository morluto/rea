import { isAbsolute } from "node:path";

import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import {
  javascriptRecoveryInputSchema,
  javascriptRecoveryResultSchema,
} from "../../domain/javascriptRecovery.js";
import { jsonObjectSchema } from "../../domain/jsonValue.js";
import { projectInputIssues } from "../../domain/inputIssueProjection.js";
import { err, ok, type Result } from "../../domain/result.js";
import type { ExecutionOptions } from "../AnalysisProvider.js";
import type { JavaScriptRecoveryPort } from "./JavaScriptRecoveryPort.js";

const OPERATION = "recover_javascript_sources";

/** Shared CLI/MCP parsing and Evidence for derived JavaScript artifacts. */
export class JavaScriptRecoveryService {
  constructor(readonly provider: JavaScriptRecoveryPort) {}

  /** Recover sources and bind the result to its original immutable input. */
  async recover(
    input: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    if (options?.signal?.aborted === true)
      return err(new AnalysisCancelledError(OPERATION));
    const parsed = javascriptRecoveryInputSchema.safeParse(input);
    if (!parsed.success)
      return err(
        new AnalysisInputError(
          OPERATION,
          { cause: parsed.error },
          projectInputIssues(parsed.error.issues, input),
        ),
      );
    const invalidPaths = (["path", "output_directory"] as const).filter(
      (field) => !isAbsolute(parsed.data[field]),
    );
    if (invalidPaths.length > 0)
      return err(
        new AnalysisInputError(
          OPERATION,
          undefined,
          invalidPaths.map((field) => ({
            path: [field],
            reason: "invalid_format",
            message: `${field} must be an absolute filesystem path on this host.`,
          })),
        ),
      );
    const execution = await this.provider.recover(parsed.data, options);
    if (!execution.ok) return execution;
    const result = javascriptRecoveryResultSchema.safeParse(
      execution.value.result,
    );
    if (!result.success || execution.value.subject === null)
      return err(
        new AnalysisOutputError(
          OPERATION,
          "Recovery did not return a valid result bound to the original source",
        ),
      );
    if (
      result.data.source.path !== parsed.data.path ||
      execution.value.subject.path !== result.data.source.path ||
      execution.value.subject.sha256 !== result.data.source.sha256 ||
      execution.value.provider.id !== result.data.engine.id ||
      execution.value.provider.version !== result.data.engine.version
    )
      return err(
        new AnalysisOutputError(
          OPERATION,
          "Recovery source or engine identity disagrees with its Evidence binding",
        ),
      );
    return ok(
      createEvidence(execution.value.subject, execution.value.provider, {
        operation: OPERATION,
        parameters: jsonObjectSchema.parse(parsed.data),
        result: result.data,
        rawResult: execution.value.rawResult,
        locations: execution.value.locations,
        limitations: execution.value.limitations,
        confidence: "derived",
        authority: "shipped-artifact",
      }),
    );
  }
}
