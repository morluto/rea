import type { ExecutionOptions } from "../AnalysisProvider.js";
import type { AndroidAnalysisService } from "./AndroidAnalysisService.js";
import {
  requireAnalysisViewRetention,
  projectRetainedAnalysis,
  type AnalysisViewRetention,
} from "../analysisView/AnalysisViewService.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { androidKotlinInspectionInputSchema } from "../../domain/android/androidAnalysis.js";
import { ANDROID_KOTLIN_METADATA_RETAINED_ROWS } from "../../domain/android/androidKotlinMetadata.js";
import type { Evidence } from "../../domain/evidence.js";
import { err, ok, type Result } from "../../domain/result.js";
import { parseAnalysisInput } from "../AnalysisInput.js";

const OPERATION = "inspect_android_kotlin_metadata";

/**
 * Split delivery from analysis once, for MCP and CLI alike. A retained summary
 * lists as many classes as the bridge's allowance holds unless the caller chose a
 * limit, so views can page the whole inventory without rerunning the reader.
 */
export const parseAndroidKotlinInspection = (
  rawInput: unknown,
  signal?: AbortSignal,
) => {
  const parsed = parseAnalysisInput(
    OPERATION,
    rawInput,
    androidKotlinInspectionInputSchema,
    signal,
  );
  if (!parsed.ok) return parsed;
  const { detail, view, ...input } = parsed.value;
  return ok({
    detail: detail ?? "complete",
    view,
    analysis:
      detail === "summary"
        ? {
            ...input,
            limit: input.limit ?? ANDROID_KOTLIN_METADATA_RETAINED_ROWS,
          }
        : input,
  });
};

/** Retain the complete inventory and deliver only the requested summary or page. */
export const inspectAndroidKotlinMetadata = async (
  service: AndroidAnalysisService,
  rawInput: unknown,
  retention: AnalysisViewRetention,
  options?: ExecutionOptions,
): Promise<Result<Evidence, AnalysisError>> => {
  const parsed = parseAndroidKotlinInspection(rawInput, options?.signal);
  if (!parsed.ok) return err(parsed.error);
  const { detail, view, analysis } = parsed.value;
  if (detail === "summary") {
    const ready = requireAnalysisViewRetention(OPERATION, retention);
    if (!ready.ok) return ready;
  }
  const executed = await service.execute(OPERATION, analysis, options);
  return !executed.ok || detail !== "summary"
    ? executed
    : projectRetainedAnalysis(
        executed.value,
        retention,
        view ?? { kind: "summary" },
      );
};
