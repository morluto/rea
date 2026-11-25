import type { RequestAnalysisPort } from "../ports/AnalysisProvider.js";
import type { AdbRequest } from "../domain/adb/adbDeviceAnalysis.js";
import type { Evidence } from "../domain/evidence.js";
import { AdbProvider } from "../adb/AdbProvider.js";
import { HOST_PLATFORM } from "../platform/HostPlatform.js";

/** Construct one ADB provider bound to the caller-selected binary. */
export const createAdbDeviceAnalysisProvider = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = HOST_PLATFORM.platform,
  onLateUiEvidence?: (evidence: Evidence) => void,
): RequestAnalysisPort<AdbRequest> =>
  new AdbProvider({
    platform,
    environment,
    ...(onLateUiEvidence === undefined ? {} : { onLateUiEvidence }),
  });
