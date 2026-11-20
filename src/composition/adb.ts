import type { AdbDeviceAnalysisPort } from "../application/adb/AdbDeviceAnalysisPort.js";
import { AdbProvider } from "../adb/AdbProvider.js";
import { HOST_PLATFORM } from "../platform/HostPlatform.js";

/** Construct one ADB provider bound to the caller-selected binary. */
export const createAdbDeviceAnalysisProvider = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = HOST_PLATFORM.platform,
): AdbDeviceAnalysisPort => new AdbProvider({ environment, platform });
