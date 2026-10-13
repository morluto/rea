import { z } from "incur";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { PcapAnalysisService } from "../application/pcap/PcapAnalysisService.js";
import type { PcapAnalysisPort } from "../application/pcap/PcapAnalysisPort.js";
import { createPcapAnalysisProvider } from "../composition/pcap.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { PcapOperation } from "../domain/pcap/pcapAnalysis.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";

/** Expose the same explicit pcap requests through one-shot CLI commands. */
export const registerPcapCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<Record<string, string | undefined>>,
  provider: PcapAnalysisPort = createPcapAnalysisProvider(environment),
): void => {
  const service = new PcapAnalysisService(provider);
  const execute = (name: string, operation: PcapOperation, input: unknown) =>
    withCommandCancellation((signal) =>
      logCliCommand(logger, name, async () => {
        const result = await service.execute(operation, input, { signal });
        try {
          await provider.close();
        } catch (cause) {
          if (cause instanceof AnalysisError) {
            if (result.ok) cause.retainPartialObservation(result.value);
            return projectAnalysisError(
              result.ok
                ? cause
                : analysisErrorWithCleanupFailure(
                    result.error,
                    cause,
                    operation,
                  ),
            );
          }
          throw cause;
        }
        return result.ok ? result.value : projectAnalysisError(result.error);
      }),
    );

  cli.command(CLI_COMMANDS.inspectPcapClient, {
    description:
      "Inspect the caller-selected tshark and capinfos binaries without reading a capture",
    args: z.object({}),
    run: () =>
      execute(CLI_COMMANDS.inspectPcapClient, "inspect_pcap_client", {}),
  });
  cli.command(CLI_COMMANDS.inspectPcapCapture, {
    description:
      "Inspect one pcap/pcapng capture: endpoints, DNS, TLS SNI, and protocol distribution",
    args: z.object({
      path: z
        .string()
        .min(1)
        .describe("Local pcap or pcapng capture file to inspect"),
    }),
    run: ({ args }) =>
      execute(CLI_COMMANDS.inspectPcapCapture, "inspect_pcap_capture", {
        path: args.path,
      }),
  });
};
