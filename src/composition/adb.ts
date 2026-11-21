import type { AdbDeviceAnalysisPort } from "../application/adb/AdbDeviceAnalysisPort.js";
import type { Evidence } from "../domain/evidence.js";
import { AdbProvider } from "../adb/AdbProvider.js";
import { HOST_PLATFORM } from "../platform/HostPlatform.js";

/** Construct one ADB provider bound to the caller-selected binary. */
export const createAdbDeviceAnalysisProvider = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = HOST_PLATFORM.platform,
  onLateUiEvidence?: (evidence: Evidence) => void,
): AdbDeviceAnalysisPort =>
  new AdbProvider({
    platform,
    environment,
    ...(onLateUiEvidence === undefined ? {} : { onLateUiEvidence }),
  });
