import { selectArtifactCommandPath } from "../process/ArtifactCommandPath.js";
import {
  pcapCaptureHostSupported,
  PCAP_CAPTURE_UNSUPPORTED_HOST_REASON,
} from "../domain/pcap/pcapAnalysis.js";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute } from "node:path";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { AnalysisCapabilityUnavailableError } from "../domain/analysisErrorCore.js";
import type { ArtifactAnalysisResources } from "../process/ArtifactAnalysisResources.js";
import {
  BOUNDED_PRODUCER_LIMITS,
  prlimitCeilingArguments,
} from "../process/LinuxResourceLimits.js";
import type { runPcapCommand } from "./PcapCommand.js";

const PRLIMIT_COMMAND_ENV = "REA_TSHARK_PRLIMIT_COMMAND";
/** Capture CPU ceiling, in seconds. */
const PCAP_CPU_SECONDS = 300;

/** Own native capture admission and the exact enforced resource profile. */
export const preparePcapNativeBound = async (
  environment: Readonly<Record<string, string | undefined>>,
  resources: ArtifactAnalysisResources,
): Promise<{
  nativeBound: NonNullable<Parameters<typeof runPcapCommand>[0]["nativeBound"]>;
  limitations: readonly string[];
}> => {
  if (process.platform === "win32") {
    return {
      nativeBound: {
        memoryLimitBytes: BOUNDED_PRODUCER_LIMITS.address_space_bytes,
      },
      limitations: [
        "Each owned Windows tool tree has a 1 GiB Job Object committed-memory limit; this is not a machine-wide quota.",
      ],
    };
  }
  if (!pcapCaptureHostSupported(process.platform)) {
    const reason = PCAP_CAPTURE_UNSUPPORTED_HOST_REASON;
    throw new AnalysisCapabilityUnavailableError(
      "pcap",
      "inspect_pcap_capture",
      reason,
      { userMessage: reason },
    );
  }
  const configured = environment[PRLIMIT_COMMAND_ENV] ?? "/usr/bin/prlimit";
  try {
    if (!isAbsolute(configured))
      throw new Error(`${PRLIMIT_COMMAND_ENV} must be absolute.`);
    const selection = await selectArtifactCommandPath(configured);
    await access(selection.resolvedPath, constants.X_OK);
    const limits = await resources.readLimits({
      address_space_bytes: BOUNDED_PRODUCER_LIMITS.address_space_bytes,
      file_bytes: BOUNDED_PRODUCER_LIMITS.file_bytes,
      cpu_seconds: PCAP_CPU_SECONDS,
    });
    const nativeBound = {
      limiter: {
        command: selection,
        arguments: prlimitCeilingArguments(limits),
      },
    };
    const limitations = [
      `Linux prlimit preserves stricter inherited ceilings: ${limits.address_space_bytes} bytes of per-process address space, ${limits.file_bytes} bytes per file and ${limits.cpu_seconds} CPU seconds; core dumps are disabled. These are not aggregate machine quotas.`,
    ];
    return { nativeBound, limitations };
  } catch (cause) {
    if (cause instanceof AnalysisError) throw cause;
    const reason =
      "Cannot establish the selected Linux resource limiter before processing capture bytes.";
    throw new AnalysisCapabilityUnavailableError(
      "pcap",
      "inspect_pcap_capture",
      reason,
      {
        cause,
        userMessage: `${reason} (${cause instanceof Error ? cause.message : String(cause)}) Check that ${PRLIMIT_COMMAND_ENV} (default /usr/bin/prlimit) names an absolute, executable util-linux prlimit.`,
      },
    );
  }
};
