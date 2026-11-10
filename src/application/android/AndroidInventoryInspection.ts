import type { z } from "zod";
import type { ExecutionOptions } from "../AnalysisProvider.js";
import type { AndroidAnalysisService } from "./AndroidAnalysisService.js";
import {
  requireAnalysisViewRetention,
  projectRetainedAnalysis,
  type AnalysisViewRetention,
} from "../analysisView/AnalysisViewService.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { androidInventoryInspectionInputSchemas } from "../../domain/android/androidAnalysis.js";
import type { Evidence } from "../../domain/evidence.js";
import type { Result } from "../../domain/result.js";
import { parseAnalysisInput } from "../AnalysisInput.js";

type Operation = keyof typeof androidInventoryInspectionInputSchemas;
type Input = z.infer<
  (typeof androidInventoryInspectionInputSchemas)[Operation]
>;

/**
 * Complete delivery is unchanged. Summary retains the complete inventory and
 * delivers only the requested summary or page, so large APKs do not repeat
 * every row in the caller's context.
 */
export const inspectAndroidInventory = async (
  service: AndroidAnalysisService,
  operation: Operation,
  rawInput: unknown,
  retention: AnalysisViewRetention,
  options?: ExecutionOptions,
): Promise<Result<Evidence, AnalysisError>> => {
  const parsed = parseAnalysisInput<Input>(
    operation,
    rawInput,
    androidInventoryInspectionInputSchemas[operation],
    options?.signal,
  );
  if (!parsed.ok) return parsed;
  const { detail, view, ...input } = parsed.value;
  if (detail === "summary") {
    const ready = requireAnalysisViewRetention(operation, retention);
    if (!ready.ok) return ready;
  }
  const executed = await service.execute(operation, input, options);
  return !executed.ok || detail !== "summary"
    ? executed
    : projectRetainedAnalysis(
        executed.value,
        retention,
        view ?? { kind: "summary" },
      );
};
