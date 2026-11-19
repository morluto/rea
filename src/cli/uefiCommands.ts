import { z } from "incur";
import { UefiAnalysisService } from "../application/uefi/UefiAnalysisService.js";
import { createUefiAnalysisProvider } from "../composition/uefi.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import {
  uefiInputSchemas,
  type UefiOperation,
} from "../domain/uefi/uefiFirmwareAnalysis.js";
import { localPathStringSchema } from "../domain/localPath.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import { finishAnalysisCommand } from "./finishAnalysisCommand.js";

const extractInput = uefiInputSchemas.extract_uefi_firmware.shape;
const targetOffset = z.number().int().nonnegative().safe().optional();

/** One-shot UEFI firmware CLI commands backed by the same workflows as MCP. */
export const registerUefiCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  const service = new UefiAnalysisService(createUefiAnalysisProvider());
  const execute = (name: string, operation: UefiOperation, input: unknown) =>
    withCommandCancellation((signal) =>
      logCliCommand(logger, name, () =>
        finishAnalysisCommand(
          () => service.execute(operation, input, { signal }),
          service,
          "rea-uefi",
          operation,
          signal,
        ),
      ),
    );
  const path = uefiInputSchemas.inspect_uefi_firmware.shape.path;
  cli.command(CLI_COMMANDS.inspectUefiFirmware, {
    description:
      "Map UEFI firmware volumes, FFS files and sections of a flash image",
    args: z.object({ path }),
    options: z.object({
      maxDepth: uefiInputSchemas.inspect_uefi_firmware.shape.max_depth,
      maxVolumes: uefiInputSchemas.inspect_uefi_firmware.shape.max_volumes,
      maxFiles: uefiInputSchemas.inspect_uefi_firmware.shape.max_files,
    }),
    run: ({ args, options }) =>
      execute(CLI_COMMANDS.inspectUefiFirmware, "inspect_uefi_firmware", {
        // CLI paths are operator-relative; resolve before shared validation.
        path: absoluteCallerPath(args.path),
        max_depth: options.maxDepth,
        max_volumes: options.maxVolumes,
        max_files: options.maxFiles,
      }),
  });
  cli.command(CLI_COMMANDS.extractUefiFirmware, {
    description:
      "Extract selected UEFI firmware bytes with provenance and decode gaps",
    args: z.object({
      path,
      outputDirectory: localPathStringSchema.describe(
        "Absent output directory; parent must exist",
      ),
    }),
    options: z
      .object({
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
            "Carrier logical path for a decoded offset, or flash for the original image",
          ),
        maxDepth: extractInput.max_depth,
        maxOutputBytes: extractInput.max_output_bytes,
        maxOutputFiles: extractInput.max_output_files,
        includeCompressed: z
          .boolean()
          .default(true)
          .describe(
            "Publish recognized-but-undecodable compressed payloads as raw blobs",
          ),
      })
      .superRefine((options, context) => {
        const chosen = [
          options.volumeOffset,
          options.fileOffset,
          options.sectionOffset,
        ].filter((offset) => offset !== undefined);
        if (options.sourceStream !== undefined && chosen.length !== 1)
          context.addIssue({
            code: "custom",
            path: ["sourceStream"],
            message: "sourceStream requires exactly one target offset",
          });
        if (chosen.length > 1)
          context.addIssue({
            code: "custom",
            path: ["volumeOffset"],
            message:
              "volumeOffset, fileOffset and sectionOffset are mutually exclusive",
          });
      }),
    run: ({ args, options }) => {
      const source =
        options.sourceStream === undefined
          ? {}
          : {
              source_stream:
                options.sourceStream === "flash" ? null : options.sourceStream,
            };
      return execute(
        CLI_COMMANDS.extractUefiFirmware,
        "extract_uefi_firmware",
        {
          path: absoluteCallerPath(args.path),
          output_directory: absoluteCallerPath(args.outputDirectory),
          target:
            options.volumeOffset !== undefined
              ? { kind: "volume", offset: options.volumeOffset, ...source }
              : options.fileOffset !== undefined
                ? { kind: "ffs-file", offset: options.fileOffset, ...source }
                : options.sectionOffset !== undefined
                  ? {
                      kind: "section",
                      offset: options.sectionOffset,
                      ...source,
                    }
                  : { kind: "whole-image" },
          max_depth: options.maxDepth,
          max_output_bytes: options.maxOutputBytes,
          max_output_files: options.maxOutputFiles,
          include_compressed: options.includeCompressed,
        },
      );
    },
  });
  cli.command(CLI_COMMANDS.inspectUefiNvram, {
    description:
      "Map AMI NVRAM variable stores (for example StdDefaults) of a flash image",
    args: z.object({ path }),
    options: z.object({
      maxStores: uefiInputSchemas.inspect_uefi_nvram.shape.max_stores,
      maxDepth: uefiInputSchemas.inspect_uefi_nvram.shape.max_depth,
    }),
    run: ({ args, options }) =>
      execute(CLI_COMMANDS.inspectUefiNvram, "inspect_uefi_nvram", {
        // CLI paths are operator-relative; resolve before shared validation.
        path: absoluteCallerPath(args.path),
        max_stores: options.maxStores,
        max_depth: options.maxDepth,
      }),
  });
};
