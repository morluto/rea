import type { AnalysisError } from "../domain/errors.js";
import type { Evidence } from "../domain/evidence.js";
import {
  androidApplicationProjectionInputSchema,
  projectAndroidApplication,
} from "../domain/androidApplication.js";
import type { Result } from "../domain/result.js";
import { ANDROID_APPLICATION_PROVIDER } from "./InvestigationProviders.js";
import { projectInventoryEvidence } from "./InventoryProjectionEvidence.js";

const OPERATION = "project_android_application_graph" as const;

/** Project authenticated APK inventory Evidence into Android application Evidence. */
export const projectAndroidApplicationEvidence = (
  rawInput: unknown,
): Result<Evidence, AnalysisError> => {
  return projectInventoryEvidence({
    rawInput,
    schema: androidApplicationProjectionInputSchema,
    project: projectAndroidApplication,
    operation: OPERATION,
    predicateType: "rea.android-application-graph/v1",
    provider: ANDROID_APPLICATION_PROVIDER,
    subjectFormat: () => "apk",
    protocolError: "Android application projection produced an invalid result",
  });
};
