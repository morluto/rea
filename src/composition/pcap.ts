import type { PcapAnalysisPort } from "../application/pcap/PcapAnalysisPort.js";
import { PcapProvider } from "../pcap/PcapProvider.js";
import { HOST_PLATFORM } from "../platform/HostPlatform.js";

/** Construct one pcap provider bound to the caller-selected tools. */
export const createPcapAnalysisProvider = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = HOST_PLATFORM.platform,
): PcapAnalysisPort => new PcapProvider({ environment, platform });
