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

/** One flutter command: CLI shape and the request it produces. */
interface FlutterCommandSpec {
  readonly command: string;
  readonly description: string;
  readonly argumentSchema: z.ZodObject<z.ZodRawShape>;
  readonly optionSchema?: z.ZodObject<z.ZodRawShape>;
  readonly operation: FlutterOperation;
  readonly toInput: (
    arguments_: Record<string, unknown>,
    options: Record<string, unknown>,
  ) => unknown;
}

/** Expose the same explicit Flutter requests through one-shot CLI commands. */
export const registerFlutterCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<Record<string, string | undefined>>,
  provider: FlutterBuildAnalysisPort = createFlutterBuildAnalysisProvider(
    environment,
  ),
): void => {
  const specs: readonly FlutterCommandSpec[] = [
    {
      command: CLI_COMMANDS.identifyFlutterBuild,
      description:
        "Identify a Flutter build's Dart snapshot hash and engine facts by pure APK parsing",
      argumentSchema: z.object({
        path: z.string().min(1).describe("Local APK file to inspect"),
      }),
      operation: "identify_flutter_build",
      toInput: (arguments_) => arguments_,
    },
    {
      command: CLI_COMMANDS.inspectDartAot,
      description:
        "Inspect one ABI's Dart AOT snapshot: sections, headers, and the string pool",
      argumentSchema: z.object({
        path: z
          .string()
          .min(1)
          .describe("Local APK carrying a Flutter payload"),
      }),
      optionSchema: z.object({
        abi: z
          .string()
          .min(2)
          .max(16)
          .optional()
          .describe("ABI under lib/ to inspect; defaults to the preferred one"),
      }),
      operation: "inspect_dart_aot",
      toInput: (arguments_, options) => ({
        path: arguments_.path,
        ...(options.abi === undefined ? {} : { abi: options.abi }),
      }),
    },
  ];
  for (const spec of specs) {
    cli.command(spec.command, {
      description: spec.description,
      ...(spec.optionSchema === undefined
        ? { args: spec.argumentSchema }
        : { args: spec.argumentSchema, options: spec.optionSchema }),
      run: ({ args, options }) =>
        withCommandCancellation((signal) =>
          logCliCommand(logger, spec.command, async () => {
            const settled = await new FlutterBuildAnalysisService(
              provider,
            ).execute(spec.operation, spec.toInput(args, options ?? {}), {
              signal,
            });
            try {
              await provider.close();
            } catch (cause) {
              if (cause instanceof AnalysisError)
                return projectAnalysisError(cause);
              throw cause;
            }
            return settled.ok
              ? settled.value
              : projectAnalysisError(settled.error);
          }),
        ),
    });
  }
};
