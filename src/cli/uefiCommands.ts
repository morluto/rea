import type { Logger } from "pino";
import { z } from "zod";

import { createUefiAnalysisService } from "../application/ProviderOperationServices.js";
import { createUefiAnalysisProvider } from "../composition/uefi.js";
import { UEFI_TOOL_CONTRACTS } from "../contracts/uefi/uefiToolContracts.js";
import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { UefiOperation } from "../domain/uefi/uefiFirmwareAnalysis.js";
import { UEFI_PROVIDER_IDENTITY } from "../uefi/UefiProviderIdentity.js";
import { contractNamed } from "./contractCliDescription.js";
import { registerContractCommand } from "./contractCommand.js";
import { inspectWithService } from "./contractCommandRunners.js";
import { cliDecimalField } from "./options.js";
import type { CliInstance } from "./types.js";

const FLASH_PATH = { description: "Local UEFI firmware image" };
const OFFSET_OPTIONS = {
  volumeOffset: "volume",
  fileOffset: "ffs-file",
  sectionOffset: "section",
} as const;
const targetOffset = cliDecimalField(z.number().int().nonnegative().optional());

/** One-shot UEFI firmware CLI commands backed by the same workflows as MCP. */
export const registerUefiCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  const service = createUefiAnalysisService(createUefiAnalysisProvider());
  const run = (operation: UefiOperation) =>
    inspectWithService(
      () => ({
        inspect: (input, options) => service.execute(operation, input, options),
        close: () => service.close(),
      }),
      UEFI_PROVIDER_IDENTITY.id,
    );

  registerContractCommand(
    cli,
    logger,
    contractNamed(UEFI_TOOL_CONTRACTS, "inspect_uefi_firmware"),
    {
      description:
        "Map UEFI firmware volumes, FFS files and sections of a flash image",
      positionals: ["path"],
      callerPaths: ["path"],
      fields: { path: FLASH_PATH },
    },
    run("inspect_uefi_firmware"),
  );
  registerContractCommand(
    cli,
    logger,
    contractNamed(UEFI_TOOL_CONTRACTS, "inspect_uefi_nvram"),
    {
      description:
        "Map AMI NVRAM variable stores (for example StdDefaults) of a flash image",
      positionals: ["path"],
      callerPaths: ["path"],
      fields: { path: FLASH_PATH },
    },
    run("inspect_uefi_nvram"),
  );

  const extraction = contractNamed(
    UEFI_TOOL_CONTRACTS,
    "extract_uefi_firmware",
  );
  const extract = run(extraction.name);
  registerContractCommand(
    cli,
    logger,
    extraction,
    {
      description:
        "Extract selected UEFI firmware bytes with provenance and decode gaps",
      positionals: ["path", "output_directory"],
      callerPaths: ["path", "output_directory"],
      fields: {
        path: FLASH_PATH,
        output_directory: {
          description: "Absent output directory; parent must exist",
        },
      },
      handlerFields: ["target"],
      cliOptions: {
        volumeOffset: targetOffset.describe(
          "Extract one firmware volume at this byte offset",
        ),
        fileOffset: targetOffset.describe(
          "Extract one FFS file at this byte offset",
        ),
        sectionOffset: targetOffset.describe(
          "Extract one section at this byte offset",
        ),
        sourceStream: z
          .string()
          .optional()
          .describe(
            "Carrier logical path for a decoded offset, or flash for the original image. Requires one target offset.",
          ),
      },
    },
    async (input, context) => {
      const options = context.cliOptions;
      const selectors = (
        Object.keys(OFFSET_OPTIONS) as (keyof typeof OFFSET_OPTIONS)[]
      ).flatMap((key) => {
        const offset = options[key];
        return offset === undefined
          ? []
          : [{ kind: OFFSET_OPTIONS[key], offset }];
      });
      const selected = selectors[0];
      const source = options.sourceStream;
      const refuse = (key: string, message: string) =>
        projectAnalysisError(
          new AnalysisInputError(extraction.name, undefined, [
            { path: [key], reason: "invalid_value", message },
          ]),
        );

      if (selectors.length > 1)
        return refuse(
          "volumeOffset",
          "--volume-offset, --file-offset and --section-offset are mutually exclusive.",
        );
      if (source !== undefined && selected === undefined)
        return refuse(
          "sourceStream",
          "--source-stream requires one target offset.",
        );

      return extract(
        {
          ...input,
          target:
            selected === undefined
              ? { kind: "whole-image" }
              : {
                  kind: selected.kind,
                  offset: selected.offset,
                  ...(source === undefined
                    ? {}
                    : { source_stream: source === "flash" ? null : source }),
                },
        },
        context,
      );
    },
  );
};
