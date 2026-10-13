import type { ExecutionOptions } from "../AnalysisProvider.js";
import type { FlutterBuildAnalysisService } from "./FlutterBuildAnalysisService.js";
import {
  requireAnalysisViewRetention,
  summarizeRetainedAnalysis,
  type AnalysisViewRetention,
} from "../analysisView/AnalysisViewService.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisCancelledError } from "../../domain/analysisErrorCore.js";
import { dartAotInspectionInputSchema } from "../../domain/flutter/flutterBuildAnalysis.js";
import type { Evidence } from "../../domain/evidence.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import { err, type Result } from "../../domain/result.js";

/** Keep the caller's ABI choice and complete analysis; select only its delivery. */
export const inspectDartAot = async (
  service: FlutterBuildAnalysisService,
  rawInput: unknown,
  retention: AnalysisViewRetention,
  options?: ExecutionOptions,
): Promise<Result<Evidence, AnalysisError>> => {
  const operation = "inspect_dart_aot";
  if (options?.signal?.aborted === true)
    return err(new AnalysisCancelledError(operation));
  const parsed = dartAotInspectionInputSchema.safeParse(rawInput);
  if (!parsed.success)
    return err(
      analysisInputErrorFromIssues(operation, parsed.error.issues, rawInput, {
        cause: parsed.error,
      }),
    );
  if (parsed.data.detail === "summary") {
    const ready = requireAnalysisViewRetention(operation, retention);
    if (!ready.ok) return ready;
  }
  const { detail, ...providerInput } = parsed.data;
  const executed = await service.execute(operation, providerInput, options);
  if (!executed.ok || detail !== "summary") return executed;
  return summarizeRetainedAnalysis(executed.value, retention);
};
