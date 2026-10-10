import { z } from "incur";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { ApktoolResourceAnalysisService } from "../application/apktool/ApktoolResourceAnalysisService.js";
import type { ApktoolResourceAnalysisPort } from "../application/apktool/ApktoolResourceAnalysisPort.js";
import { createApktoolResourceAnalysisProvider } from "../composition/apktool.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { ApktoolOperation } from "../domain/apktool/apktoolResourceAnalysis.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";

/** Expose the same explicit Apktool requests through one-shot CLI commands. */
export const registerApktoolCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<Record<string, string | undefined>>,
  provider: ApktoolResourceAnalysisPort = createApktoolResourceAnalysisProvider(
    environment,
  ),
): void => {
  const service = new ApktoolResourceAnalysisService(provider);
  const execute = (name: string, operation: ApktoolOperation, input: unknown) =>
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

  cli.command(CLI_COMMANDS.inspectApktoolClient, {
    description:
      "Inspect the caller-selected apktool launcher without decoding anything",
    args: z.object({}),
    run: () =>
      execute(CLI_COMMANDS.inspectApktoolClient, "inspect_apktool_client", {}),
  });
  cli.command(CLI_COMMANDS.decodeAndroidResources, {
    description:
      "Decode one APK's manifest, metadata, and string resources with apktool",
    args: z.object({
      path: z.string().min(1).describe("Local APK file to decode"),
    }),
    options: z.object({
      locale: z
        .string()
        .min(2)
        .max(16)
        .regex(
          /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/u,
          "Locale must look like de or pt-BR",
        )
        .optional()
        .describe(
          "Project strings from res/values-<locale> instead of the default",
        ),
      "no-strings": z
        .boolean()
        .default(false)
        .describe("Skip projecting string resources"),
    }),
    run: ({ args, options }) =>
      execute(CLI_COMMANDS.decodeAndroidResources, "decode_android_resources", {
        path: args.path,
        include_strings: !options["no-strings"],
        ...(options.locale === undefined ? {} : { locale: options.locale }),
      }),
  });
};
