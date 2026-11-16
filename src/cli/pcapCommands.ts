import type { Logger } from "pino";

import { PcapAnalysisService } from "../application/pcap/PcapAnalysisService.js";
import type { PcapAnalysisPort } from "../application/pcap/PcapAnalysisPort.js";
import { createPcapAnalysisProvider } from "../composition/pcap.js";
import { PCAP_TOOL_CONTRACTS } from "../contracts/pcap/pcapToolContracts.js";
import type { PcapOperation } from "../domain/pcap/pcapAnalysis.js";
import { contractNamed } from "./contractCliDescription.js";
import {
  analyzeWithService,
  inspectWithService,
  registerContractCommand,
  type EvidenceInspectionService,
} from "./contractCommand.js";
import type { CliInstance } from "./types.js";

/** Expose the same explicit pcap requests through one-shot CLI commands. */
export const registerPcapCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<Record<string, string | undefined>>,
  provider: PcapAnalysisPort = createPcapAnalysisProvider(environment),
): void => {
  const pcap = new PcapAnalysisService(provider);
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
      omit: {
        detail:
          "The one-shot command returns complete Evidence; summaries are retained by MCP sessions.",
      },
    },
    // The contract admits the path as typed, so the input is the caller's spelling.
    (input, context) =>
      inspectWithService(service("inspect_pcap_capture"), "pcap")(input, {
        ...context,
        callerInputs: { path: input.path },
      }),
  );
};
