import type { ExecutionOptions } from "../AnalysisProvider.js";
import type { AndroidAnalysisService } from "./AndroidAnalysisService.js";
import {
  requireAnalysisViewRetention,
  summarizeRetainedAnalysis,
  type AnalysisViewRetention,
} from "../analysisView/AnalysisViewService.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisCancelledError } from "../../domain/analysisErrorCore.js";
import { androidPackageInspectionInputSchema } from "../../domain/android/androidAnalysis.js";
import type { Evidence } from "../../domain/evidence.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import { err, type Result } from "../../domain/result.js";

/** Preserve the complete provider request; select retained delivery explicitly. */
export const inspectAndroidPackage = async (
  service: AndroidAnalysisService,
  rawInput: unknown,
  retention: AnalysisViewRetention,
  options?: ExecutionOptions,
): Promise<Result<Evidence, AnalysisError>> => {
  const operation = "inspect_android_package";
  if (options?.signal?.aborted === true)
    return err(new AnalysisCancelledError(operation));
  const parsed = androidPackageInspectionInputSchema.safeParse(rawInput);
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
  const executed = await service.execute(
    operation,
    { path: parsed.data.path },
    options,
  );
  if (!executed.ok || parsed.data.detail !== "summary") return executed;
  return summarizeRetainedAnalysis(executed.value, retention);
};
