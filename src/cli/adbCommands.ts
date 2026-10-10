import { z } from "incur";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { AdbDeviceAnalysisService } from "../application/adb/AdbDeviceAnalysisService.js";
import type { AdbDeviceAnalysisPort } from "../application/adb/AdbDeviceAnalysisPort.js";
import { createAdbDeviceAnalysisProvider } from "../composition/adb.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { AdbOperation } from "../domain/adb/adbDeviceAnalysis.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";

/** Expose the same explicit ADB requests through one-shot CLI commands. */
export const registerAdbCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<Record<string, string | undefined>>,
  provider: AdbDeviceAnalysisPort = createAdbDeviceAnalysisProvider(
    environment,
  ),
): void => {
  const service = new AdbDeviceAnalysisService(provider);
  const execute = (name: string, operation: AdbOperation, input: unknown) =>
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

  const serial = z
    .string()
    .min(1)
    .describe("Device serial exactly as `adb devices` reports it");

  cli.command(CLI_COMMANDS.inspectAdbClient, {
    description:
      "Inspect the caller-selected adb client without contacting devices",
    args: z.object({}),
    run: () => execute(CLI_COMMANDS.inspectAdbClient, "inspect_adb_client", {}),
  });
  cli.command(CLI_COMMANDS.listAdbDevices, {
    description:
      "List attached devices with serial, state, transport, and inferred kind",
    args: z.object({}),
    run: () => execute(CLI_COMMANDS.listAdbDevices, "list_adb_devices", {}),
  });
  cli.command(CLI_COMMANDS.inspectAdbDevice, {
    description:
      "Inspect one device's build identity through a fixed getprop whitelist",
    args: z.object({ serial }),
    run: ({ args }) =>
      execute(CLI_COMMANDS.inspectAdbDevice, "inspect_adb_device", args),
  });
  cli.command(CLI_COMMANDS.listAdbPackages, {
    description:
      "List installed packages on one device with base APK device paths",
    args: z.object({ serial }),
    options: z.object({
      scope: z
        .enum(["all", "third_party", "system"])
        .default("all")
        .describe("Restrict to third-party or system packages"),
    }),
    run: ({ args, options }) =>
      execute(CLI_COMMANDS.listAdbPackages, "list_adb_packages", {
        serial: args.serial,
        scope: options.scope,
      }),
  });
  cli.command(CLI_COMMANDS.pullAdbPackage, {
    description:
      "Pull one installed package's complete APK set with SHA-256 digests",
    args: z.object({
      serial,
      package: z.string().min(1).describe("Installed package name"),
    }),
    options: z.object({
      "output-directory": z
        .string()
        .min(1)
        .describe(
          "Local directory for the pulled APK set; a package-named subdirectory is created inside",
        ),
    }),
    run: ({ args, options }) =>
      execute(CLI_COMMANDS.pullAdbPackage, "pull_adb_package", {
        serial: args.serial,
        package: args.package,
        output_directory: options["output-directory"],
      }),
  });
};
