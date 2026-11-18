import type { Logger } from "pino";

import { FirmwareAnalysisService } from "../application/firmware/FirmwareAnalysisService.js";
import { createFirmwareAnalysisProvider } from "../composition/firmware.js";
import { FIRMWARE_TOOL_CONTRACTS } from "../contracts/firmware/firmwareToolContracts.js";
import { FIRMWARE_OPERATION_ENGINES } from "../contracts/firmware/firmwareToolRequirements.js";
import type { FirmwareOperation } from "../domain/firmware/firmwareAnalysis.js";
import { contractNamed } from "./contractCliDescription.js";
import {
  inspectWithService,
  registerContractCommand,
} from "./contractCommand.js";
import type { CliInstance } from "./types.js";

const FIRMWARE_PATH_HELP = "Local firmware path; never executed";

/** One-shot firmware CLI commands backed by the same workflows as MCP. */
export const registerFirmwareCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<Record<string, string | undefined>>,
): void => {
  const service = new FirmwareAnalysisService(
    createFirmwareAnalysisProvider(environment),
  );
  const run = (operation: FirmwareOperation) =>
    inspectWithService(
      () => ({
        inspect: (input, options) => service.execute(operation, input, options),
        close: () => service.close(),
      }),
      FIRMWARE_OPERATION_ENGINES[operation],
    );
  registerContractCommand(
    cli,
    logger,
    contractNamed(FIRMWARE_TOOL_CONTRACTS, "inspect_firmware_regions"),
    {
      description:
        "Inspect firmware signature candidates without extracting them",
      positionals: ["path"],
      callerPaths: ["path"],
      fields: { path: { description: FIRMWARE_PATH_HELP } },
    },
    run("inspect_firmware_regions"),
  );
  registerContractCommand(
    cli,
    logger,
    contractNamed(FIRMWARE_TOOL_CONTRACTS, "extract_firmware"),
    {
      description:
        "Extract selected firmware bytes and return verified files and provenance",
      positionals: ["path", "output_directory"],
      callerPaths: ["path", "output_directory"],
      flatten: {
        range: {
          offset: { description: "Selected byte offset; requires length" },
          length: { description: "Selected byte length; requires offset" },
        },
      },
      fields: {
        path: { description: FIRMWARE_PATH_HELP },
        output_directory: {
          description: "Absent output directory; parent must exist",
        },
      },
    },
    run("extract_firmware"),
  );
};
