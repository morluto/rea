import { access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute } from "node:path";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { AnalysisCapabilityUnavailableError } from "../domain/analysisErrorCore.js";
import type { ArtifactAnalysisResources } from "../process/ArtifactAnalysisResources.js";
import type { runPcapCommand } from "./PcapCommand.js";

const PRLIMIT_COMMAND_ENV = "REA_TSHARK_PRLIMIT_COMMAND";

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
      nativeBound: { memoryLimitBytes: 1024 ** 3 },
      limitations: [
        "Each owned Windows tool tree has a 1 GiB Job Object committed-memory limit; this is not a machine-wide quota.",
      ],
    };
  }
  if (process.platform !== "linux") {
    const reason =
      "Packet summaries require an enforceable native memory bound: Linux with util-linux prlimit, or Windows with owned Job Objects. This host's capture boundary remains unsupported.";
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
    const limiter = await realpath(configured);
    await access(limiter, constants.X_OK);
    const limits = await resources.readLimits({
      address_space_bytes: 1024 ** 3,
      file_bytes: 64 * 1024 ** 2,
      cpu_seconds: 300,
    });
    const nativeBound = {
      limiter: {
        command: limiter,
        arguments: [
          `--as=${limits.address_space_bytes}:${limits.address_space_bytes}`,
          `--fsize=${limits.file_bytes}:${limits.file_bytes}`,
          `--cpu=${limits.cpu_seconds}:${limits.cpu_seconds}`,
          "--core=0:0",
          "--",
        ],
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
