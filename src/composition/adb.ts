import type { AdbDeviceAnalysisPort } from "../application/adb/AdbDeviceAnalysisPort.js";
import type { Evidence } from "../domain/evidence.js";
import { AdbProvider } from "../adb/AdbProvider.js";

/** Construct one ADB provider bound to the caller-selected binary. */
export const createAdbDeviceAnalysisProvider = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
  onLateUiEvidence?: (evidence: Evidence) => void,
): AdbDeviceAnalysisPort =>
  new AdbProvider({
    environment,
    ...(onLateUiEvidence === undefined ? {} : { onLateUiEvidence }),
  });
