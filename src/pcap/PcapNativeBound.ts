import { basename } from "node:path";
import { BOUNDED_PRODUCER_LIMITS } from "../domain/producerResourceLimits.js";
import {
  pcapCaptureHostSupported,
  PCAP_CAPTURE_UNSUPPORTED_HOST_REASON,
} from "../domain/pcap/pcapAnalysis.js";
import { AnalysisCapabilityUnavailableError } from "../domain/analysisErrorCore.js";
import type { ArtifactAnalysisResources } from "../process/ArtifactAnalysisResources.js";
import {
  prepareLinuxLimiter,
  type LimiterProbe,
} from "../process/LinuxLimiterAdmission.js";
import type { runPcapCommand } from "./PcapCommand.js";

/** Which stage an unsuccessful limited capture command's exit belongs to. */
export type PcapLimitedExitStage =
  | { readonly stage: "tool" }
  | { readonly stage: "tool-launch"; readonly refusal: "missing" | "denied" }
  | { readonly stage: "limiter" };

/**
 * Attribute an unsuccessful exit of a command run through util-linux prlimit.
 * prlimit sets the limits and then replaces itself with the tool (execvp), so
 * once that succeeds the exit status and output are the tool's own. Before
 * that, prlimit reports its own failure through err(3) on stderr, prefixed
 * with its invocation name: a failed exec exits 127 (ENOENT) or 126, any
 * other prlimit failure exits 1. Commands run with LC_ALL=C, so the message
 * is untranslated.
 */
export const attributePcapLimitedExit = (
  limiterInvocationPath: string,
  exit: {
    readonly exitCode: number | null | undefined;
    readonly signal: string | null | undefined;
    readonly stderr: string;
  },
): PcapLimitedExitStage => {
  const prefix = `${basename(limiterInvocationPath)}: `;
  // A signal or output without prlimit's own prefix belongs to the tool.
  if (
    (exit.signal !== null && exit.signal !== undefined) ||
    !exit.stderr.startsWith(prefix)
  )
    return { stage: "tool" };
  if (
    (exit.exitCode === 126 || exit.exitCode === 127) &&
    exit.stderr.startsWith(`${prefix}failed to execute `)
  )
    return {
      stage: "tool-launch",
      refusal: exit.exitCode === 127 ? "missing" : "denied",
    };
  return exit.exitCode === 1 ? { stage: "limiter" } : { stage: "tool" };
};

/** Capture CPU ceiling, in seconds. */
const PCAP_CPU_SECONDS = 300;

/** Own native capture admission and the exact enforced resource profile. */
export const preparePcapNativeBound = async (
  platform: NodeJS.Platform,
  environment: Readonly<Record<string, string | undefined>>,
  resources: ArtifactAnalysisResources,
  probe: LimiterProbe,
  signal?: AbortSignal,
  operation:
    | "inspect_pcap_client"
    | "inspect_pcap_capture" = "inspect_pcap_capture",
): Promise<{
  nativeBound: NonNullable<Parameters<typeof runPcapCommand>[0]["nativeBound"]>;
  limitations: readonly string[];
}> => {
  if (platform === "win32") {
    return {
      nativeBound: {
        memoryLimitBytes: BOUNDED_PRODUCER_LIMITS.address_space_bytes,
      },
      limitations: [
        "Each owned Windows tool tree has a 1 GiB Job Object committed-memory limit; this is not a machine-wide quota.",
      ],
    };
  }
  if (!pcapCaptureHostSupported(platform)) {
    const reason = PCAP_CAPTURE_UNSUPPORTED_HOST_REASON;
    throw new AnalysisCapabilityUnavailableError("pcap", operation, reason, {
      userMessage: reason,
    });
  }
  const limiter = await prepareLinuxLimiter({
    environment,
    resources,
    probe,
    signal,
    operation,
    ceilings: {
      address_space_bytes: BOUNDED_PRODUCER_LIMITS.address_space_bytes,
      file_bytes: BOUNDED_PRODUCER_LIMITS.file_bytes,
      cpu_seconds: PCAP_CPU_SECONDS,
    },
    provider: "pcap",
  });
  const { limits } = limiter;
  return {
    nativeBound: {
      limiter: { command: limiter.command, arguments: limiter.arguments },
    },
    limitations: [
      `Linux prlimit preserves stricter inherited ceilings: ${limits.address_space_bytes} bytes of per-process address space, ${limits.file_bytes} bytes per file and ${limits.cpu_seconds} CPU seconds; core dumps are disabled. These are not aggregate machine quotas.`,
    ],
  };
};
