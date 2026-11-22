import type { ApktoolResourceAnalysisPort } from "../application/apktool/ApktoolResourceAnalysisPort.js";
import { ApktoolProvider } from "../apktool/ApktoolProvider.js";
import { HOST_PLATFORM } from "../platform/HostPlatform.js";

/** Construct one Apktool provider bound to the caller-selected launcher. */
export const createApktoolResourceAnalysisProvider = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = HOST_PLATFORM.platform,
): ApktoolResourceAnalysisPort =>
  new ApktoolProvider({ environment, platform });
