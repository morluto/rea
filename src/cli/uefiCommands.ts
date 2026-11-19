import { z } from "zod";
import { UefiAnalysisService } from "../application/uefi/UefiAnalysisService.js";
import { createUefiAnalysisProvider } from "../composition/uefi.js";
import { cliCommandFor } from "../contracts/cliCommandNames.js";
import { registerCliCommand } from "./commandRegistry.js";
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
import type { CallerInputPaths } from "../domain/evidence.js";
import { UEFI_PROVIDER_IDENTITY } from "../uefi/UefiProviderIdentity.js";
import { finishCliEvidenceCommand } from "./cliEvidenceCallerPath.js";
import { projectCliAnalysisResult } from "./projectCliAnalysisResult.js";

const extractInput = uefiInputSchemas.extract_uefi_firmware.shape;
const targetOffset = z.number().int().nonnegative().optional();

/** One-shot UEFI firmware CLI commands backed by the same workflows as MCP. */
export const registerUefiCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  const service = new UefiAnalysisService(createUefiAnalysisProvider());
  const execute = (
    operation: UefiOperation,
    callerPath: string,
    input: unknown,
    additionalPaths?: CallerInputPaths,
  ) =>
    withCommandCancellation((signal) =>
      logCliCommand(logger, cliCommandFor(operation), () =>
        finishCliEvidenceCommand(
          callerPath,
          () => service.execute(operation, input, { signal }),
          service,
          UEFI_PROVIDER_IDENTITY.id,
          operation,
          signal,
          additionalPaths,
        ).then(projectCliAnalysisResult),
      ),
    );
  const path = localPathStringSchema.describe(
    "Local UEFI firmware image. Relative paths resolve against the current directory",
  );
  registerCliCommand(
    cli,
    cliCommandFor("inspect_uefi_firmware"),
    {
      description:
        "Map UEFI firmware volumes, FFS files and sections of a flash image",
      args: z.object({ path }),
      options: z.object({
        maxDepth: uefiInputSchemas.inspect_uefi_firmware.shape.max_depth,
        maxVolumes: uefiInputSchemas.inspect_uefi_firmware.shape.max_volumes,
        maxFiles: uefiInputSchemas.inspect_uefi_firmware.shape.max_files,
      }),
      run: ({ args, options }) =>
        execute("inspect_uefi_firmware", args.path, {
          // CLI paths are operator-relative; resolve before shared validation.
          path: absoluteCallerPath(args.path),
          max_depth: options.maxDepth,
          max_volumes: options.maxVolumes,
          max_files: options.maxFiles,
        }),
    },
    {
      operations: [
        {
          name: "inspect_uefi_firmware",
          flags: {
            max_depth: "--max-depth",
            max_files: "--max-files",
            max_volumes: "--max-volumes",
          },
        },
      ],
    },
  );
  registerCliCommand(
    cli,
    cliCommandFor("extract_uefi_firmware"),
    {
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
                  options.sourceStream === "flash"
                    ? null
                    : options.sourceStream,
              };
        return execute(
          "extract_uefi_firmware",
          args.path,
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
          { output_directory: args.outputDirectory },
        );
      },
    },
    {
      operations: [
        {
          name: "extract_uefi_firmware",
          flags: {
            max_depth: "--max-depth",
            max_output_files: "--max-output-files",
            max_output_bytes: "--max-output-bytes",
            include_compressed: "--include-compressed",
            "target.source_stream": "--source-stream",
          },
        },
      ],
    },
  );
  registerCliCommand(
    cli,
    cliCommandFor("inspect_uefi_nvram"),
    {
      description:
        "Map AMI NVRAM variable stores (for example StdDefaults) of a flash image",
      args: z.object({ path }),
      options: z.object({
        maxStores: uefiInputSchemas.inspect_uefi_nvram.shape.max_stores,
        maxDepth: uefiInputSchemas.inspect_uefi_nvram.shape.max_depth,
      }),
      run: ({ args, options }) =>
        execute("inspect_uefi_nvram", args.path, {
          // CLI paths are operator-relative; resolve before shared validation.
          path: absoluteCallerPath(args.path),
          max_stores: options.maxStores,
          max_depth: options.maxDepth,
        }),
    },
    {
      operations: [
        {
          name: "inspect_uefi_nvram",
          flags: { max_depth: "--max-depth", max_stores: "--max-stores" },
        },
      ],
    },
  );
};
