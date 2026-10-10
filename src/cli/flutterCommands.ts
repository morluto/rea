import { z } from "incur";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { FlutterBuildAnalysisService } from "../application/flutter/FlutterBuildAnalysisService.js";
import type { FlutterBuildAnalysisPort } from "../application/flutter/FlutterBuildAnalysisPort.js";
import { createFlutterBuildAnalysisProvider } from "../composition/flutter.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { FlutterOperation } from "../domain/flutter/flutterBuildAnalysis.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";

/** Expose the same explicit Flutter requests through one-shot CLI commands. */
export const registerFlutterCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<Record<string, string | undefined>>,
  provider: FlutterBuildAnalysisPort = createFlutterBuildAnalysisProvider(
    environment,
  ),
): void => {
  const service = new FlutterBuildAnalysisService(provider);
  const execute = (name: string, operation: FlutterOperation, input: unknown) =>
    withCommandCancellation((signal) =>
      logCliCommand(logger, name, async () => {
        const result = await service.execute(operation, input, { signal });
        try {
          await provider.close();
        } catch (cause) {
          if (cause instanceof AnalysisError)
            return projectAnalysisError(cause);
          throw cause;
        }
        return result.ok ? result.value : projectAnalysisError(result.error);
      }),
    );

  cli.command(CLI_COMMANDS.identifyFlutterBuild, {
    description:
      "Identify a Flutter build's Dart snapshot hash and engine facts by pure APK parsing",
    args: z.object({
      path: z.string().min(1).describe("Local APK file to inspect"),
    }),
    run: ({ args }) =>
      execute(CLI_COMMANDS.identifyFlutterBuild, "identify_flutter_build", {
        path: args.path,
      }),
  });
  cli.command(CLI_COMMANDS.inspectDartAot, {
    description:
      "Inspect one ABI's Dart AOT snapshot: sections, headers, and the string pool",
    args: z.object({
      path: z.string().min(1).describe("Local APK carrying a Flutter payload"),
    }),
    options: z.object({
      abi: z
        .string()
        .min(2)
        .max(16)
        .optional()
        .describe("ABI under lib/ to inspect; defaults to the preferred one"),
    }),
    run: ({ args, options }) =>
      execute(CLI_COMMANDS.inspectDartAot, "inspect_dart_aot", {
        path: args.path,
        ...(options.abi === undefined ? {} : { abi: options.abi }),
      }),
  });
};
