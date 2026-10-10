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
  cli.command(CLI_COMMANDS.readAdbLogcat, {
    description: "Read a bounded dump of the device log for one buffer",
    args: z.object({ serial }),
    options: z.object({
      count: z
        .number()
        .int()
        .min(1)
        .max(10_000)
        .default(500)
        .describe("Number of most recent lines to read"),
      buffer: z
        .enum(["main", "system", "radio", "events", "crash"])
        .default("main")
        .describe("Log buffer to read"),
      pid: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Restrict to one process id"),
    }),
    run: ({ args, options }) =>
      execute(CLI_COMMANDS.readAdbLogcat, "read_adb_logcat", {
        serial: args.serial,
        count: options.count,
        buffer: options.buffer,
        ...(options.pid === undefined ? {} : { pid: options.pid }),
      }),
  });
  cli.command(CLI_COMMANDS.inspectAdbPackage, {
    description:
      "Inspect one installed package's version, installer, and flags through dumpsys",
    args: z.object({ serial, package: z.string().min(1).describe("Package") }),
    run: ({ args }) =>
      execute(CLI_COMMANDS.inspectAdbPackage, "inspect_adb_package", {
        serial: args.serial,
        package: args.package,
      }),
  });
  cli.command(CLI_COMMANDS.pullAdbFile, {
    description: "Pull one device file to a local copy with a SHA-256 digest",
    args: z.object({
      serial,
      "device-path": z.string().min(1).describe("Absolute device path to pull"),
    }),
    options: z.object({
      "output-directory": z
        .string()
        .min(1)
        .describe("Local directory for the pulled file"),
    }),
    run: ({ args, options }) =>
      execute(CLI_COMMANDS.pullAdbFile, "pull_adb_file", {
        serial: args.serial,
        device_path: args["device-path"],
        output_directory: options["output-directory"],
      }),
  });
  cli.command(CLI_COMMANDS.pushAdbFile, {
    description:
      "Push one local file to the device; refuses existing targets without --overwrite",
    args: z.object({
      serial,
      "local-path": z.string().min(1).describe("Existing local file"),
      "device-path": z.string().min(1).describe("Absolute device destination"),
    }),
    options: z.object({
      overwrite: z
        .boolean()
        .default(false)
        .describe("Allow replacing an existing device file"),
    }),
    run: ({ args, options }) =>
      execute(CLI_COMMANDS.pushAdbFile, "push_adb_file", {
        serial: args.serial,
        local_path: args["local-path"],
        device_path: args["device-path"],
        overwrite: options.overwrite,
      }),
  });
  cli.command(CLI_COMMANDS.captureAdbScreen, {
    description: "Capture one screen frame as a digested PNG",
    args: z.object({ serial }),
    options: z.object({
      "output-directory": z
        .string()
        .min(1)
        .describe("Local directory for screen.png"),
    }),
    run: ({ args, options }) =>
      execute(CLI_COMMANDS.captureAdbScreen, "capture_adb_screen", {
        serial: args.serial,
        output_directory: options["output-directory"],
      }),
  });
  cli.command(CLI_COMMANDS.listAdbProcesses, {
    description: "List running processes exactly as ps -A reports them",
    args: z.object({ serial }),
    run: ({ args }) =>
      execute(CLI_COMMANDS.listAdbProcesses, "list_adb_processes", args),
  });
  cli.command(CLI_COMMANDS.listAdbDirectory, {
    description: "List one device directory with kinds, permissions, and sizes",
    args: z.object({
      serial,
      "device-path": z
        .string()
        .min(1)
        .describe("Absolute device directory path to list"),
    }),
    run: ({ args }) =>
      execute(CLI_COMMANDS.listAdbDirectory, "list_adb_directory", {
        serial: args.serial,
        device_path: args["device-path"],
      }),
  });
  cli.command(CLI_COMMANDS.listAdbFeatures, {
    description: "List the device's declared hardware and software features",
    args: z.object({ serial }),
    run: ({ args }) =>
      execute(CLI_COMMANDS.listAdbFeatures, "list_adb_features", args),
  });
  cli.command(CLI_COMMANDS.listAdbServices, {
    description: "List the device's binder services and interfaces",
    args: z.object({ serial }),
    run: ({ args }) =>
      execute(CLI_COMMANDS.listAdbServices, "list_adb_services", args),
  });
  cli.command(CLI_COMMANDS.inspectAdbDisplay, {
    description: "Report the display's declared size and density",
    args: z.object({ serial }),
    run: ({ args }) =>
      execute(CLI_COMMANDS.inspectAdbDisplay, "inspect_adb_display", args),
  });
  cli.command(CLI_COMMANDS.inspectAdbWindow, {
    description: "Report the window manager's current focus declarations",
    args: z.object({ serial }),
    run: ({ args }) =>
      execute(CLI_COMMANDS.inspectAdbWindow, "inspect_adb_window", args),
  });
  cli.command(CLI_COMMANDS.readAdbSetting, {
    description: "Read one settings value from system, secure, or global",
    args: z.object({
      serial,
      namespace: z
        .enum(["system", "secure", "global"])
        .describe("Settings namespace to read"),
      key: z.string().min(1).describe("Setting key to read"),
    }),
    run: ({ args }) =>
      execute(CLI_COMMANDS.readAdbSetting, "read_adb_setting", {
        serial: args.serial,
        namespace: args.namespace,
        key: args.key,
      }),
  });
  cli.command(CLI_COMMANDS.collectAdbBugreport, {
    description: "Collect and digest one device-generated bugreport archive",
    args: z.object({ serial }),
    options: z.object({
      "output-directory": z
        .string()
        .min(1)
        .describe("Local directory for the bugreport zip"),
    }),
    run: ({ args, options }) =>
      execute(CLI_COMMANDS.collectAdbBugreport, "collect_adb_bugreport", {
        serial: args.serial,
        output_directory: options["output-directory"],
      }),
  });
  cli.command(CLI_COMMANDS.resolveAdbPackages, {
    description: "Find installed packages by case-insensitive name substring",
    args: z.object({
      serial,
      query: z.string().min(2).describe("Package-name substring to find"),
    }),
    run: ({ args }) =>
      execute(CLI_COMMANDS.resolveAdbPackages, "resolve_adb_packages", {
        serial: args.serial,
        query: args.query,
      }),
  });
  cli.command(CLI_COMMANDS.installAdbPackage, {
    description:
      "Install one local APK; --replace re-installs keeping the app's data",
    args: z.object({
      serial,
      "apk-path": z.string().min(1).describe("Local APK file to install"),
    }),
    options: z.object({
      replace: z
        .boolean()
        .default(false)
        .describe("Replace an existing install and keep its data"),
    }),
    run: ({ args, options }) =>
      execute(CLI_COMMANDS.installAdbPackage, "install_adb_package", {
        serial: args.serial,
        apk_path: args["apk-path"],
        replace: options.replace,
      }),
  });
  cli.command(CLI_COMMANDS.uninstallAdbPackage, {
    description: "Uninstall one package and its data from the device",
    args: z.object({
      serial,
      package: z.string().min(1).describe("Installed package to uninstall"),
    }),
    run: ({ args }) =>
      execute(CLI_COMMANDS.uninstallAdbPackage, "uninstall_adb_package", {
        serial: args.serial,
        package: args.package,
      }),
  });
  cli.command(CLI_COMMANDS.startAdbApp, {
    description:
      "Start one installed app by resolving and launching its launcher activity",
    args: z.object({
      serial,
      package: z.string().min(1).describe("Installed package to start"),
    }),
    run: ({ args }) =>
      execute(CLI_COMMANDS.startAdbApp, "start_adb_app", {
        serial: args.serial,
        package: args.package,
      }),
  });
  cli.command(CLI_COMMANDS.startAdbActivity, {
    description:
      "Start an intent with am start (action, URI, component, extras)",
    args: z.object({
      serial,
      action: z.string().min(1).describe("Intent action to start"),
    }),
    options: z.object({
      "data-uri": z.string().min(1).optional().describe("Intent data URI (-d)"),
      component: z
        .string()
        .min(1)
        .optional()
        .describe("Explicit component in package/activity form (-n)"),
      extra: z
        .array(z.string().min(1))
        .default([])
        .describe(
          "Typed extra as type:key:value (string, boolean, int, long, float), repeatable",
        ),
    }),
    run: ({ args, options }) => {
      const extras = options.extra.map((entry) => {
        const first = entry.indexOf(":");
        const second = entry.indexOf(":", first + 1);
        if (first === -1 || second === -1)
          throw new Error(`--extra expects type:key:value, received: ${entry}`);
        return {
          type: entry.slice(0, first) as
            | "string"
            | "boolean"
            | "int"
            | "long"
            | "float",
          key: entry.slice(first + 1, second),
          value: entry.slice(second + 1),
        };
      });
      return execute(CLI_COMMANDS.startAdbActivity, "start_adb_activity", {
        serial: args.serial,
        action: args.action,
        ...(options["data-uri"] === undefined
          ? {}
          : { data_uri: options["data-uri"] }),
        ...(options.component === undefined
          ? {}
          : { component: options.component }),
        extras,
      });
    },
  });
  cli.command(CLI_COMMANDS.stopAdbApp, {
    description: "Force-stop every process of one package",
    args: z.object({
      serial,
      package: z.string().min(1).describe("Package to force-stop"),
    }),
    run: ({ args }) =>
      execute(CLI_COMMANDS.stopAdbApp, "stop_adb_app", {
        serial: args.serial,
        package: args.package,
      }),
  });
};
