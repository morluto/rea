import { z } from "zod";
import type { Logger } from "pino";

import { AdbDeviceAnalysisService } from "../application/adb/AdbDeviceAnalysisService.js";
import type { AdbDeviceAnalysisPort } from "../application/adb/AdbDeviceAnalysisPort.js";
import { createAdbDeviceAnalysisProvider } from "../composition/adb.js";
import { ADB_TOOL_CONTRACTS } from "../contracts/adb/adbToolContracts.js";
import { cliCommandFor } from "../contracts/cliCommandNames.js";
import {
  activityExtraCliEntrySchema,
  MAX_ADB_ACTIVITY_EXTRAS,
  type AdbOperation,
} from "../domain/adb/adbDeviceAnalysis.js";
import { publishArgvInput } from "./options.js";
import type { CliInstance } from "./types.js";
import { contractNamed } from "./contractCliDescription.js";
import type {
  CliContractProjection,
  ContractField,
} from "./contractCliDescriptionTypes.js";
import {
  analyzeWithService,
  registerContractCommand,
  type EvidenceInspectionService,
} from "./contractCommand.js";

type AdbContract<Name extends AdbOperation> = Extract<
  (typeof ADB_TOOL_CONTRACTS)[number],
  { readonly name: Name }
>;

/** The CLI spelling of each ADB contract; argv order follows the device. */
type AdbProjection<Name extends AdbOperation> = Omit<
  CliContractProjection<ContractField<AdbContract<Name>>>,
  "command"
>;

const serialFirst = <const Rest extends readonly string[]>(...rest: Rest) =>
  ["serial", ...rest] as const;

/**
 * Commands whose contract fields map onto argv without CLI-only options.
 * Path fields keep their established kebab-case keys.
 */
const ADB_COMMANDS: {
  readonly [Name in Exclude<AdbOperation, "start_adb_activity">]: readonly [
    command: string,
    projection: AdbProjection<Name>,
  ];
} = {
  inspect_adb_client: [
    cliCommandFor("inspect_adb_client"),
    {
      description:
        "Inspect the caller-selected adb client without contacting devices",
    },
  ],
  list_adb_devices: [
    cliCommandFor("list_adb_devices"),
    {
      description:
        "List attached devices with serial, state, transport, and inferred kind",
    },
  ],
  inspect_adb_device: [
    cliCommandFor("inspect_adb_device"),
    {
      description:
        "Inspect one device's build identity through a fixed getprop whitelist",
      positionals: serialFirst(),
    },
  ],
  list_adb_packages: [
    cliCommandFor("list_adb_packages"),
    {
      description:
        "List installed packages on one device with base APK device paths",
      positionals: serialFirst(),
    },
  ],
  pull_adb_package: [
    cliCommandFor("pull_adb_package"),
    {
      description:
        "Pull one installed package's complete APK set with SHA-256 digests",
      positionals: serialFirst("package"),
      fields: {
        output_directory: { name: "output-directory" },
      },
    },
  ],
  read_adb_logcat: [
    cliCommandFor("read_adb_logcat"),
    {
      description: "Read a bounded dump of the device log for one buffer",
      positionals: serialFirst(),
    },
  ],
  inspect_adb_package: [
    cliCommandFor("inspect_adb_package"),
    {
      description:
        "Inspect one installed package's version, installer, and flags through dumpsys",
      positionals: serialFirst("package"),
    },
  ],
  pull_adb_file: [
    cliCommandFor("pull_adb_file"),
    {
      description: "Pull one device file to a local copy with a SHA-256 digest",
      positionals: serialFirst("device_path"),
      fields: {
        device_path: { name: "device-path" },
        output_directory: { name: "output-directory" },
      },
    },
  ],
  push_adb_file: [
    cliCommandFor("push_adb_file"),
    {
      description:
        "Push one local file to the device; refuses existing targets without --overwrite",
      positionals: serialFirst("local_path", "device_path"),
      fields: {
        local_path: { name: "local-path" },
        device_path: { name: "device-path" },
      },
    },
  ],
  capture_adb_screen: [
    cliCommandFor("capture_adb_screen"),
    {
      description: "Capture one screen frame as a digested PNG",
      positionals: serialFirst(),
      fields: {
        output_directory: { name: "output-directory" },
      },
    },
  ],
  list_adb_processes: [
    cliCommandFor("list_adb_processes"),
    {
      description: "List running processes exactly as ps -A reports them",
      positionals: serialFirst(),
    },
  ],
  list_adb_directory: [
    cliCommandFor("list_adb_directory"),
    {
      description:
        "List one device directory with kinds, permissions, and sizes",
      positionals: serialFirst("device_path"),
      fields: {
        device_path: { name: "device-path" },
      },
    },
  ],
  list_adb_features: [
    cliCommandFor("list_adb_features"),
    {
      description: "List the device's declared hardware and software features",
      positionals: serialFirst(),
    },
  ],
  list_adb_services: [
    cliCommandFor("list_adb_services"),
    {
      description: "List the device's binder services and interfaces",
      positionals: serialFirst(),
    },
  ],
  inspect_adb_display: [
    cliCommandFor("inspect_adb_display"),
    {
      description: "Report the display's declared size and density",
      positionals: serialFirst(),
    },
  ],
  inspect_adb_window: [
    cliCommandFor("inspect_adb_window"),
    {
      description: "Report the window manager's current focus declarations",
      positionals: serialFirst(),
    },
  ],
  read_adb_setting: [
    cliCommandFor("read_adb_setting"),
    {
      description: "Read one settings value from system, secure, or global",
      positionals: serialFirst("namespace", "key"),
    },
  ],
  collect_adb_bugreport: [
    cliCommandFor("collect_adb_bugreport"),
    {
      description: "Collect and digest one device-generated bugreport archive",
      positionals: serialFirst(),
      fields: {
        output_directory: { name: "output-directory" },
      },
    },
  ],
  resolve_adb_packages: [
    cliCommandFor("resolve_adb_packages"),
    {
      description: "Find installed packages by case-insensitive name substring",
      positionals: serialFirst("query"),
    },
  ],
  install_adb_package: [
    cliCommandFor("install_adb_package"),
    {
      description:
        "Install one local APK; --replace requests reinstall mode to keep existing app data",
      positionals: serialFirst("apk_path"),
      fields: {
        apk_path: { name: "apk-path" },
      },
    },
  ],
  uninstall_adb_package: [
    cliCommandFor("uninstall_adb_package"),
    {
      description: "Uninstall one package and its data from the device",
      positionals: serialFirst("package"),
    },
  ],
  start_adb_app: [
    cliCommandFor("start_adb_app"),
    {
      description:
        "Start one installed app by resolving and launching its launcher activity",
      positionals: serialFirst("package"),
    },
  ],
  stop_adb_app: [
    cliCommandFor("stop_adb_app"),
    {
      description: "Force-stop every process of one package",
      positionals: serialFirst("package"),
    },
  ],
};

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
  const run = (operation: AdbOperation) => (): EvidenceInspectionService => ({
    inspect: (input, { signal }) =>
      service.execute(operation, input, { signal }),
    close: () => provider.close(),
  });

  // Each entry's projection is checked against its own contract above.
  for (const [name, [command, projection]] of Object.entries(ADB_COMMANDS))
    registerContractCommand(
      cli,
      logger,
      contractNamed(ADB_TOOL_CONTRACTS, name as AdbOperation),
      { command, ...projection } as never,
      analyzeWithService(run(name as AdbOperation), "adb"),
    );

  const startActivity = analyzeWithService(run("start_adb_activity"), "adb");
  registerContractCommand(
    cli,
    logger,
    contractNamed(ADB_TOOL_CONTRACTS, "start_adb_activity"),
    {
      description:
        "Start an intent with am start (action, URI, component, extras)",
      positionals: serialFirst("action"),
      fields: { data_uri: { name: "data-uri" } },
      omit: {
        extras: "Each extra is a repeatable --extra type:key:value option",
      },
      cliOptions: {
        extra: publishArgvInput(
          z
            .array(activityExtraCliEntrySchema)
            .max(MAX_ADB_ACTIVITY_EXTRAS)
            .default([])
            .describe(
              "Typed extra as type:key:value (string, boolean, int, long, float), repeatable",
            ),
        ),
      },
    },
    (input, context) =>
      startActivity({ ...input, extras: context.cliOptions.extra }, context),
  );
};
