import type { RequestAnalysisPort } from "../ports/AnalysisProvider.js";
import type { PcapRequest } from "../domain/pcap/pcapAnalysis.js";
import type { Logger } from "pino";

import { createPcapAnalysisService } from "../application/ProviderOperationServices.js";
import { createPcapAnalysisProvider } from "../composition/pcap.js";
import { PCAP_TOOL_CONTRACTS } from "../contracts/pcap/pcapToolContracts.js";
import type { PcapOperation } from "../domain/pcap/pcapAnalysis.js";
import { contractNamed } from "./contractCliDescription.js";
import { registerContractCommand } from "./contractCommand.js";
import {
  analyzeWithService,
  inspectWithService,
  type EvidenceInspectionService,
} from "./contractCommandRunners.js";
import type { CliInstance } from "./types.js";
import { PRODUCER_LIMITS_HELP } from "./producerLimitsOption.js";

/** Expose the same explicit pcap requests through one-shot CLI commands. */
export const registerPcapCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<Record<string, string | undefined>>,
  provider: RequestAnalysisPort<PcapRequest> = createPcapAnalysisProvider(
    environment,
  ),
): void => {
  const pcap = createPcapAnalysisService(provider);
  // Each command releases the shared provider's tools when it finishes.
  const service =
    (operation: PcapOperation) => (): EvidenceInspectionService => ({
      inspect: (input, options) => pcap.execute(operation, input, options),
      close: () => provider.close(),
    });
  registerContractCommand(
    cli,
    logger,
    contractNamed(PCAP_TOOL_CONTRACTS, "inspect_pcap_client"),
    {
      description:
        "Inspect the caller-selected tshark and capinfos binaries without reading a capture",
    },
    analyzeWithService(service("inspect_pcap_client"), "pcap"),
  );
  registerContractCommand(
    cli,
    logger,
    contractNamed(PCAP_TOOL_CONTRACTS, "inspect_pcap_capture"),
    {
      description:
        "Inspect one pcap/pcapng capture: endpoints, DNS, TLS SNI, and protocol distribution",
      positionals: ["path"],
      callerPaths: ["path"],
      jsonText: ["producer_limits"],
      fields: {
        path: { description: "Local pcap or pcapng capture file to inspect" },
        producer_limits: { description: PRODUCER_LIMITS_HELP },
      },
      omit: {
        detail:
          "The one-shot command returns complete Evidence; summaries are retained by MCP sessions.",
      },
    },
    inspectWithService(service("inspect_pcap_capture"), "pcap"),
  );
};
