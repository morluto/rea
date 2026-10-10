/**
 * Parsers for the exact adb and Package Manager output formats REA consumes.
 *
 * Each parser preserves what the tool actually printed: unparseable lines are
 * retained rather than silently dropped, and derived classifications carry
 * their evidence basis.
 */

/** One device exactly as `adb devices -l` reports it. */
export interface AdbDeviceEntry {
  readonly serial: string;
  readonly state: string;
  readonly transport: "usb" | "tcp" | "unknown";
  readonly product: string | null;
  readonly model: string | null;
  readonly device: string | null;
  readonly transport_id: number | null;
  readonly kind: "emulator" | "physical" | "unknown";
  readonly kind_basis: "emulator_serial_prefix" | "usb_transport" | "none";
}

/**
 * Device states adb prints after the serial, longest first so two-word
 * states match before their single-word prefixes. A line whose remainder
 * starts with none of them is not a device line.
 */
const DEVICE_STATES = [
  "no permissions",
  "unauthorized",
  "authorizing",
  "offline",
  "recovery",
  "sideload",
  "connecting",
  "bootloader",
  "device",
  "unknown",
  "host",
] as const;

const DEVICE_LINE = /^(\S+)\s+(.*)$/u;

const metadataValue = (remainder: string, key: string): string | null => {
  const match = new RegExp(`(?:^|\\s)${key}:(\\S+)`, "u").exec(remainder);
  return match === null ? null : match[1]!;
};

/**
 * Parse `adb devices -l` device lines. The banner, blank lines, and the
 * daemon startup notices adb prints on first use are recognized separately;
 * every other unrecognized line is returned for honest reporting.
 */
export const parseAdbDevicesOutput = (
  stdout: string,
): {
  devices: readonly AdbDeviceEntry[];
  unparsedLines: readonly string[];
  daemonStarted: boolean;
} => {
  const devices: AdbDeviceEntry[] = [];
  const unparsedLines: string[] = [];
  let daemonStarted = false;
  for (const rawLine of stdout.split(/\r?\n/u)) {
    const line = rawLine.trimEnd();
    if (line === "" || line.startsWith("List of devices attached")) continue;
    if (line.startsWith("* daemon")) {
      if (line.includes("started successfully")) daemonStarted = true;
      continue;
    }
    const match = DEVICE_LINE.exec(line);
    const state = DEVICE_STATES.find((candidate) =>
      match?.[2]?.startsWith(candidate),
    );
    if (match === null || state === undefined) {
      if (line.trim() !== "") unparsedLines.push(line);
      continue;
    }
    const serial = match[1]!;
    const remainder = match[2]!.slice(state.length);
    const usb = metadataValue(remainder, "usb");
    const transportIdText = metadataValue(remainder, "transport_id");
    const parsedTransportId =
      transportIdText === null || !/^\d+$/u.test(transportIdText)
        ? null
        : Number(transportIdText);
    const isEmulator = /^emulator-\d+$/u.test(serial);
    const kind = isEmulator
      ? ("emulator" as const)
      : usb !== null
        ? ("physical" as const)
        : ("unknown" as const);
    devices.push({
      serial,
      state,
      transport:
        usb !== null
          ? "usb"
          : isEmulator || serial.includes(":")
            ? "tcp"
            : "unknown",
      product: metadataValue(remainder, "product"),
      model: metadataValue(remainder, "model"),
      device: metadataValue(remainder, "device"),
      transport_id: parsedTransportId,
      kind,
      kind_basis:
        kind === "emulator"
          ? "emulator_serial_prefix"
          : kind === "physical"
            ? "usb_transport"
            : "none",
    });
  }
  return { devices, unparsedLines, daemonStarted };
};

/**
 * Properties projected from a `getprop` dump. The whitelist keeps device
 * inspection to build identity facts; a full dump is out of scope.
 */
const DEVICE_PROPERTY_WHITELIST = [
  "ro.build.version.release",
  "ro.build.version.sdk",
  "ro.build.version.security_patch",
  "ro.build.id",
  "ro.build.fingerprint",
  "ro.build.characteristics",
  "ro.debuggable",
  "ro.kernel.qemu",
  "ro.product.brand",
  "ro.product.device",
  "ro.product.manufacturer",
  "ro.product.model",
  "ro.product.cpu.abilist",
] as const;

export interface AdbDeviceProperty {
  readonly name: string;
  readonly value: string;
}

/** Parse a full `getprop` dump into `[name]: [value]` pairs. */
export const parseGetpropOutput = (
  stdout: string,
): {
  properties: readonly AdbDeviceProperty[];
  emulatorObserved: boolean | null;
} => {
  const values = new Map<string, string>();
  for (const rawLine of stdout.split(/\r?\n/u)) {
    const match = /^\[([^\]]+)\]:\s*\[(.*)\]$/u.exec(rawLine.trim());
    if (match === null) continue;
    values.set(match[1]!, match[2]!);
  }
  const properties = DEVICE_PROPERTY_WHITELIST.flatMap((name) => {
    const value = values.get(name);
    return value === undefined || value === ""
      ? []
      : [{ name, value } satisfies AdbDeviceProperty];
  });
  const qemu = values.get("ro.kernel.qemu");
  return {
    properties,
    emulatorObserved: qemu === undefined ? null : qemu === "1",
  };
};

/** One installed package exactly as `pm list packages -f` reports it. */
export interface AdbPackageEntry {
  readonly package_name: string;
  readonly base_apk_device_path: string;
}

const PACKAGE_LINE = /^package:(.+)=([^\s=]+)$/u;

/** Parse `pm list packages -f` lines, retaining unrecognized lines. */
export const parsePackageListOutput = (
  stdout: string,
): {
  packages: readonly AdbPackageEntry[];
  unparsedLines: readonly string[];
} => {
  const packages: AdbPackageEntry[] = [];
  const unparsedLines: string[] = [];
  for (const rawLine of stdout.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "") continue;
    const match = PACKAGE_LINE.exec(line);
    if (match === null) {
      unparsedLines.push(line);
      continue;
    }
    packages.push({
      package_name: match[2]!,
      base_apk_device_path: match[1]!,
    });
  }
  return { packages, unparsedLines };
};

/** One APK of an installed package exactly as `pm path` reports it. */
export interface AdbPackagePathEntry {
  readonly device_path: string;
  readonly file_name: string;
  readonly role: "base" | "split" | "unknown";
}

const fileNameOf = (devicePath: string): string => {
  const parts = devicePath.split(/\//u);
  return parts[parts.length - 1] ?? devicePath;
};

/**
 * Parse `pm path PACKAGE` lines. The base/split role is derived from the file
 * name (`base.apk`, `split_*.apk`), which is the only signal the output
 * carries; any other name reports an unknown role.
 */
export const parsePmPathOutput = (
  stdout: string,
): {
  paths: readonly AdbPackagePathEntry[];
  unparsedLines: readonly string[];
} => {
  const paths: AdbPackagePathEntry[] = [];
  const unparsedLines: string[] = [];
  for (const rawLine of stdout.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "") continue;
    const match = /^package:(\S+)$/u.exec(line);
    if (match === null) {
      unparsedLines.push(line);
      continue;
    }
    const devicePath = match[1]!;
    const fileName = fileNameOf(devicePath);
    paths.push({
      device_path: devicePath,
      file_name: fileName,
      role:
        fileName === "base.apk"
          ? "base"
          : fileName.startsWith("split_") && fileName.endsWith(".apk")
            ? "split"
            : "unknown",
    });
  }
  return { paths, unparsedLines };
};
