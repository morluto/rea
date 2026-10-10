import { z } from "zod";
import { localPathStringSchema } from "../localPath.js";

/**
 * Device serials as adb prints them: emulator-5554, USB identifiers, and
 * host:port transports. The pattern keeps arguments free of whitespace and
 * quotes; argv is positional in the provider, so this is admission hygiene
 * rather than injection defense.
 */
const deviceSerialSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(
    /^[^\x00\s"']+$/u,
    "Device serial cannot contain whitespace or quotes",
  );

/**
 * Android package names as Package Manager reports them. System entries can
 * be a single segment (`android`), so at least one identifier is required.
 */
const packageNameSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(
    /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)*$/u,
    "Package name must be dot-separated Java identifiers",
  );

/**
 * Caller intent for ADB-backed device inspection and acquisition.
 *
 * REA never installs platform tools, starts an emulator, or manages devices;
 * every operation addresses devices the caller already connected, through the
 * adb binary the caller selected.
 */
export const adbInputSchemas = {
  inspect_adb_client: z.strictObject({}),
  list_adb_devices: z.strictObject({}),
  inspect_adb_device: z.strictObject({
    serial: deviceSerialSchema.describe(
      "Device serial exactly as `adb devices` reports it",
    ),
  }),
  list_adb_packages: z.strictObject({
    serial: deviceSerialSchema.describe(
      "Device serial exactly as `adb devices` reports it",
    ),
    scope: z
      .enum(["all", "third_party", "system"])
      .default("all")
      .describe(
        "Package scope: all packages, third-party only (-3), or system only (-s)",
      ),
  }),
  pull_adb_package: z.strictObject({
    serial: deviceSerialSchema.describe(
      "Device serial exactly as `adb devices` reports it",
    ),
    package: packageNameSchema.describe(
      "Installed package name whose APK set is pulled",
    ),
    output_directory: localPathStringSchema.describe(
      "Local directory for the pulled APK set; REA creates a package-named subdirectory inside it",
    ),
  }),
} as const;

/** Supported ADB-backed operations. */
export type AdbOperation = keyof typeof adbInputSchemas;
/** Validated ADB requests carry their selected operation. */
export type AdbRequest = {
  [Name in AdbOperation]: {
    operation: Name;
    input: z.infer<(typeof adbInputSchemas)[Name]>;
  };
}[AdbOperation];

/** Validate operation and input together so their types remain correlated. */
export const adbRequestSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    operation: z.literal("inspect_adb_client"),
    input: adbInputSchemas.inspect_adb_client,
  }),
  z.strictObject({
    operation: z.literal("list_adb_devices"),
    input: adbInputSchemas.list_adb_devices,
  }),
  z.strictObject({
    operation: z.literal("inspect_adb_device"),
    input: adbInputSchemas.inspect_adb_device,
  }),
  z.strictObject({
    operation: z.literal("list_adb_packages"),
    input: adbInputSchemas.list_adb_packages,
  }),
  z.strictObject({
    operation: z.literal("pull_adb_package"),
    input: adbInputSchemas.pull_adb_package,
  }),
]);

const client = z.strictObject({
  binary_path: z.string().min(1),
  path_source: z.enum(["environment", "path"]),
  version: z.string().min(1).nullable(),
  installed_path: z.string().min(1).nullable(),
});

const device = z.strictObject({
  serial: z.string().min(1),
  state: z.string().min(1),
  transport: z.enum(["usb", "tcp", "unknown"]),
  product: z.string().nullable(),
  model: z.string().nullable(),
  device: z.string().nullable(),
  transport_id: z.number().int().positive().nullable(),
  /**
   * Inferred device kind with its evidence basis. The serial prefix and the
   * `device:` metadata line are observations; the kind itself is derived.
   */
  kind: z.enum(["emulator", "physical", "unknown"]),
  kind_basis: z.enum(["emulator_serial_prefix", "usb_transport", "none"]),
});

const pulledArtifact = z.strictObject({
  device_path: z.string().min(1),
  file_name: z.string().min(1),
  local_path: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  role: z.enum(["base", "split", "unknown"]),
  role_basis: z.literal("file_name"),
});

const pullFailure = z.strictObject({
  device_path: z.string().min(1).nullable(),
  stage: z.enum(["resolve_paths", "pull", "digest"]),
  message: z.string().min(1),
});

/** Portable ADB observations with explicit identity and coverage limitations. */
export const adbResultSchemas = {
  inspect_adb_client: z.strictObject({
    client,
    /**
     * `adb version` never contacts the adb server; this tool starts nothing.
     * Recorded explicitly so the session keeps the distinction observable.
     */
    contacted_adb_server: z.literal(false),
  }),
  list_adb_devices: z.strictObject({
    client,
    devices: z.array(device),
    /**
     * Starting the local adb server is an adb client behavior on first use;
     * REA observes whichever server state the caller's environment has.
     */
    may_have_started_adb_server: z.boolean(),
  }),
  inspect_adb_device: z.strictObject({
    client,
    serial: z.string().min(1),
    properties: z.array(
      z.strictObject({ name: z.string().min(1), value: z.string().min(1) }),
    ),
    property_count: z.number().int().nonnegative(),
    emulator_observed: z.boolean().nullable(),
  }),
  list_adb_packages: z.strictObject({
    client,
    serial: z.string().min(1),
    scope: z.enum(["all", "third_party", "system"]),
    packages: z.array(
      z.strictObject({
        package_name: packageNameSchema,
        /** Device filesystem path; not a host-local path. */
        base_apk_device_path: z.string().min(1),
      }),
    ),
    unparsed_lines: z.array(z.string().min(1)),
    coverage: z.enum(["complete", "partial"]),
  }),
  pull_adb_package: z.strictObject({
    client,
    serial: z.string().min(1),
    package_name: packageNameSchema,
    output_directory: z.string().min(1),
    artifacts: z.array(pulledArtifact),
    failures: z.array(pullFailure),
    coverage: z.enum(["complete", "partial"]),
  }),
} as const;
