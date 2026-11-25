import type { RequestAnalysisPort } from "../ports/AnalysisProvider.js";
import type { ApktoolRequest } from "../domain/apktool/apktoolResourceAnalysis.js";
import { ApktoolProvider } from "../apktool/ApktoolProvider.js";
import { HOST_PLATFORM } from "../platform/HostPlatform.js";

/** Construct one Apktool provider bound to the caller-selected launcher. */
export const createApktoolResourceAnalysisProvider = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = HOST_PLATFORM.platform,
): RequestAnalysisPort<ApktoolRequest> =>
  new ApktoolProvider({ environment, platform });
