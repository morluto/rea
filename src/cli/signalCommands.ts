import type { Logger } from "pino";

import type { SignalRecordingService } from "../application/signals/SignalRecordingService.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { createSignalRecordingService } from "../composition/signals.js";
import { SIGNAL_TOOL_CONTRACTS } from "../contracts/signals/signalToolContracts.js";
import { contractNamed } from "./contractCliDescription.js";
import {
  analyzeWithService,
  inspectWithService,
  registerContractCommand,
} from "./contractCommand.js";
import { PRODUCER_LIMITS_HELP } from "./producerLimitsOption.js";
import type { CliInstance } from "./types.js";

export const registerSignalCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<NodeJS.ProcessEnv>,
  service: Pick<
    SignalRecordingService,
    "decode" | "inspectDecoders" | "close"
  > = createSignalRecordingService(environment),
): void => {
  const close = () => service.close();
  registerContractCommand(
    cli,
    logger,
    contractNamed(SIGNAL_TOOL_CONTRACTS, "inspect_signal_decoders"),
    {
      command: CLI_COMMANDS.inspectSignalDecoders,
      description: "Search installed sigrok decoders or selected decoder help",
      jsonText: ["producer_limits"],
      nullFlags: {
        limit: { key: "all", description: "Return all remaining matches" },
      },
      fields: {
        producer_limits: { description: PRODUCER_LIMITS_HELP },
        limit: {
          description:
            "Maximum matching decoders or help lines to return; defaults to 50",
        },
      },
    },
    analyzeWithService(
      () => ({
        inspect: (input, options) => service.inspectDecoders(input, options),
        close,
      }),
      "sigrok-recording",
    ),
  );
  registerContractCommand(
    cli,
    logger,
    contractNamed(SIGNAL_TOOL_CONTRACTS, "decode_signal_recording"),
    {
      command: CLI_COMMANDS.decodeSignalRecording,
      description:
        "Decode an existing signal recording with caller-supplied sigrok",
      positionals: ["path"],
      callerPaths: ["path"],
      jsonText: ["producer_limits"],
      nullFlags: {
        line_limit: {
          key: "all_lines",
          description:
            "Return all remaining output lines instead of a bounded page",
        },
      },
      crossFieldRules: "argv",
      fields: {
        path: { description: "Local signal recording" },
        producer_limits: { description: PRODUCER_LIMITS_HELP },
        input_format: { name: "input_format" },
        line_offset: { name: "line_offset" },
        line_limit: {
          name: "line_limit",
          description: "Returned output lines per page; default 50",
        },
      },
    },
    inspectWithService(
      () => ({
        inspect: (input, options) => service.decode(input, options),
        close,
      }),
      "sigrok-recording",
    ),
  );
};
