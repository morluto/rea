import type { Logger } from "pino";

import type { PacketCaptureService } from "../application/captures/PacketCaptureService.js";
import { createPacketCaptureService } from "../composition/captures.js";
import { CAPTURE_TOOL_CONTRACTS } from "../contracts/captures/captureToolContracts.js";
import { contractNamed } from "./contractCliDescription.js";
import { registerContractCommand } from "./contractCommand.js";
import {
  analyzeWithService,
  inspectWithService,
} from "./contractCommandRunners.js";
import { PRODUCER_LIMITS_HELP } from "./producerLimitsOption.js";
import type { CliInstance } from "./types.js";

export const registerCaptureCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<NodeJS.ProcessEnv>,
  service: Pick<
    PacketCaptureService,
    "inspect" | "inspectFields" | "close"
  > = createPacketCaptureService(environment),
): void => {
  const close = () => service.close();
  registerContractCommand(
    cli,
    logger,
    contractNamed(CAPTURE_TOOL_CONTRACTS, "inspect_packet_fields"),
    {
      description: "Search installed TShark protocol and field definitions",
      jsonText: ["producer_limits"],
      nullFlags: {
        limit: {
          key: "all",
          description: "Return all remaining matches within resource limits",
        },
      },
      fields: {
        producer_limits: { description: PRODUCER_LIMITS_HELP },
        limit: {
          description: "Maximum matching records to return; defaults to 50",
        },
      },
    },
    analyzeWithService(
      () => ({
        inspect: (input, options) => service.inspectFields(input, options),
        close,
      }),
      "tshark-capture",
    ),
  );
  registerContractCommand(
    cli,
    logger,
    contractNamed(CAPTURE_TOOL_CONTRACTS, "inspect_packet_capture"),
    {
      description:
        "Inspect an existing packet capture with caller-supplied TShark",
      positionals: ["path"],
      callerPaths: ["path"],
      jsonText: ["producer_limits"],
      nullFlags: {
        match_limit: {
          key: "all_matches",
          description:
            "Return all remaining matching frames instead of a bounded page",
        },
      },
      crossFieldRules: "argv",
      fields: {
        path: { description: "Local packet capture" },
        producer_limits: { description: PRODUCER_LIMITS_HELP },
        display_filter: { name: "display_filter" },
        decode_as: { name: "decode_as" },
        packet_limit: { name: "packet_limit" },
        two_pass: { name: "two_pass" },
        match_offset: { name: "match_offset" },
        match_limit: {
          name: "match_limit",
          description: "Returned matching frames per page; default 50",
        },
      },
    },
    inspectWithService(
      () => ({
        inspect: (input, options) => service.inspect(input, options),
        close,
      }),
      "tshark-capture",
    ),
  );
};
