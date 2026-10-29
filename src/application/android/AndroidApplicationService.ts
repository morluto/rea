import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { projectAndroidInventory } from "../../domain/android/androidApplication.js";
import type { Result } from "../../domain/result.js";
import { ANDROID_APPLICATION_PROVIDER } from "../../domain/investigationProviders.js";
import {
  projectInventoryEvidence,
  type InventoryProjectionEvidenceResult,
} from "../InventoryProjectionEvidence.js";

const OPERATION = "project_android_application_graph" as const;

/** Project authenticated APK inventory Evidence into Android application Evidence. */
export const projectAndroidApplicationEvidence = (
  rawInput: unknown,
): Result<InventoryProjectionEvidenceResult, AnalysisError> => {
  return projectInventoryEvidence({
    rawInput,
    project: projectAndroidInventory,
    operation: OPERATION,
    predicateType: "rea.android-application-graph",
    provider: ANDROID_APPLICATION_PROVIDER,
    subjectFormat: () => "apk",
  });
};
