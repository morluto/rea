import { z } from "incur";
import { FirmwareAnalysisService } from "../application/firmware/FirmwareAnalysisService.js";
import { createFirmwareAnalysisProvider } from "../composition/firmware.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { FirmwareOperation } from "../domain/firmware/firmwareAnalysis.js";
import type { Logger } from "../logger.js";
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
  const execute = (
    name: string,
    operation: FirmwareOperation,
    input: unknown,
  ) =>
    withCommandCancellation((signal) =>
      logCliCommand(logger, name, async () => {
        const result = await service.execute(operation, input, { signal });
        return result.ok ? result.value : projectAnalysisError(result.error);
      }),
    );
  const path = z.string().describe("Local firmware path; never executed");
  cli.command(CLI_COMMANDS.inspectFirmwareRegions, {
    description:
      "Inspect firmware signature candidates without extracting them",
    args: z.object({ path }),
    run: ({ args }) =>
      execute(
        CLI_COMMANDS.inspectFirmwareRegions,
        "inspect_firmware_regions",
        args,
      ),
  });
  cli.command(CLI_COMMANDS.extractFirmware, {
    description:
      "Extract selected firmware bytes and return verified files and provenance",
    args: z.object({
      path,
      outputDirectory: z
        .string()
        .describe("Absolute absent output directory; parent must exist"),
    }),
    options: z.object({
      offset: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Selected byte offset; requires length"),
      length: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Selected byte length; requires offset"),
      maxDepth: z
        .number()
        .int()
        .optional()
        .describe("Extraction depth, 1–10; default 3"),
      maxOutputBytes: z
        .number()
        .int()
        .optional()
        .describe("Staging byte budget; default 256 MiB, maximum 512 MiB"),
      maxOutputFiles: z
        .number()
        .int()
        .optional()
        .describe("Staging entry budget; default 10000"),
    }),
    run: ({ args, options }) =>
      execute(CLI_COMMANDS.extractFirmware, "extract_firmware", {
        path: args.path,
        output_directory: args.outputDirectory,
        ...(options.offset === undefined && options.length === undefined
          ? {}
          : { range: { offset: options.offset, length: options.length } }),
        ...(options.maxDepth === undefined
          ? {}
          : { max_depth: options.maxDepth }),
        ...(options.maxOutputBytes === undefined
          ? {}
          : { max_output_bytes: options.maxOutputBytes }),
        ...(options.maxOutputFiles === undefined
          ? {}
          : { max_output_files: options.maxOutputFiles }),
      }),
  });
};
