import { z } from "incur";
import { resolve } from "node:path";
import { FirmwareAnalysisService } from "../application/firmware/FirmwareAnalysisService.js";
import { createFirmwareAnalysisProvider } from "../composition/firmware.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import { firmwareInputSchemas } from "../domain/firmware/firmwareAnalysis.js";
import { localPathStringSchema } from "../domain/localPath.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { FirmwareOperation } from "../domain/firmware/firmwareAnalysis.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";

/** One-shot firmware CLI commands backed by the same workflows as MCP. */
export const registerFirmwareCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<Record<string, string | undefined>>,
): void => {
  const service = new FirmwareAnalysisService(
    createFirmwareAnalysisProvider(environment),
  );
  const extractInput = firmwareInputSchemas.extract_firmware.shape;
  const range = extractInput.range.unwrap().shape;
  const execute = (
    name: string,
    operation: FirmwareOperation,
    input: unknown,
  ) =>
    withCommandCancellation((signal) =>
      logCliCommand(logger, name, async () => {
        try {
          const result = await service.execute(operation, input, { signal });
          return result.ok ? result.value : projectAnalysisError(result.error);
        } finally {
          await service.close();
        }
      }),
    );
  const path = localPathStringSchema.describe(
    "Local firmware path; never executed",
  );
  cli.command(CLI_COMMANDS.inspectFirmwareRegions, {
    description:
      "Inspect firmware signature candidates without extracting them",
    args: z.object({ path }),
    run: ({ args }) =>
      execute(
        CLI_COMMANDS.inspectFirmwareRegions,
        "inspect_firmware_regions",
        // CLI paths are operator-relative; resolve before shared validation.
        { path: resolve(args.path) },
      ),
  });
  cli.command(CLI_COMMANDS.extractFirmware, {
    description:
      "Extract selected firmware bytes and return verified files and provenance",
    args: z.object({
      path,
      outputDirectory: localPathStringSchema.describe(
        "Absent output directory; parent must exist",
      ),
    }),
    options: z.object({
      offset: range.offset
        .optional()
        .describe("Selected byte offset; requires length"),
      length: range.length
        .optional()
        .describe("Selected byte length; requires offset"),
      maxDepth: extractInput.max_depth,
      maxOutputBytes: extractInput.max_output_bytes,
      maxOutputFiles: extractInput.max_output_files,
    }),
    run: ({ args, options }) =>
      execute(CLI_COMMANDS.extractFirmware, "extract_firmware", {
        path: resolve(args.path),
        output_directory: resolve(args.outputDirectory),
        ...(options.offset === undefined && options.length === undefined
          ? {}
          : { range: { offset: options.offset, length: options.length } }),
        max_depth: options.maxDepth,
        max_output_bytes: options.maxOutputBytes,
        max_output_files: options.maxOutputFiles,
      }),
  });
};
