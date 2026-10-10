import {
  adbInputSchemas,
  adbResultSchemas,
} from "../../domain/adb/adbDeviceAnalysis.js";
import type { ToolContract } from "../toolContractTypes.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";
import { toolContractMetadata } from "../toolEffects.js";

/** ADB device inspection and acquisition over a caller-supplied binary. */
export const ADB_TOOL_CONTRACTS = [
  {
    name: "inspect_adb_client",
    ...toolContractMetadata("inspect_adb_client"),
    description:
      "Inspect the caller-selected adb client: resolved binary, version, and install path. Never contacts devices and never starts the adb server. REA never installs platform tools; select a binary with REA_ADB_PATH (absolute) or adb on PATH.",
    kind: "adb-provider",
    inputSchema: adbInputSchemas.inspect_adb_client,
    outputSchema: evidenceResultOf(adbResultSchemas.inspect_adb_client),
    examples: [{ title: "Check the adb client", input: {} }],
  },
  {
    name: "list_adb_devices",
    ...toolContractMetadata("list_adb_devices"),
    description:
      "List attached devices exactly as `adb devices -l` reports them: serial, state, transport, model metadata, and an inferred emulator/physical kind with its evidence basis. Emulators and USB or network devices appear alike; REA neither starts nor manages them. May start the local adb server on first use.",
    kind: "adb-provider",
    inputSchema: adbInputSchemas.list_adb_devices,
    outputSchema: evidenceResultOf(adbResultSchemas.list_adb_devices),
    examples: [{ title: "List attached devices", input: {} }],
  },
  {
    name: "inspect_adb_device",
    ...toolContractMetadata("inspect_adb_device"),
    description:
      "Inspect one device's build identity through a fixed `getprop` whitelist: Android and SDK versions, security patch, fingerprint, product identity, CPU ABIs, and debuggable flag, plus the observed emulator indicator ro.kernel.qemu. Read-only with respect to the device.",
    kind: "adb-provider",
    inputSchema: adbInputSchemas.inspect_adb_device,
    outputSchema: evidenceResultOf(adbResultSchemas.inspect_adb_device),
    examples: [
      { title: "Inspect one device", input: { serial: "emulator-5554" } },
    ],
  },
  {
    name: "list_adb_packages",
    ...toolContractMetadata("list_adb_packages"),
    description:
      "List installed packages on one device with each base APK's device path, optionally scoped to third-party or system packages. Paths are device filesystem paths, not host-local. Read-only.",
    kind: "adb-provider",
    inputSchema: adbInputSchemas.list_adb_packages,
    outputSchema: evidenceResultOf(adbResultSchemas.list_adb_packages),
    examples: [
      {
        title: "List third-party packages",
        input: { serial: "emulator-5554", scope: "third_party" },
      },
    ],
  },
  {
    name: "pull_adb_package",
    ...toolContractMetadata("pull_adb_package"),
    description:
      "Pull one installed package's complete APK set (base plus every split, as `pm path` reports) from the device into a caller-selected output directory, creating a package-named subdirectory that must not already exist. Every pulled file is digested with SHA-256; partial pulls keep successful artifacts and per-file failure reasons. The device keeps the originals.",
    kind: "adb-provider",
    inputSchema: adbInputSchemas.pull_adb_package,
    outputSchema: evidenceResultOf(adbResultSchemas.pull_adb_package),
    examples: [
      {
        title: "Pull a package APK set",
        input: {
          serial: "emulator-5554",
          package: "com.example.app",
          output_directory: "/tmp/rea-pulls",
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
