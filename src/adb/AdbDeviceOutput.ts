/**
 * Parsers for the exact adb and Package Manager output formats REA consumes.
 *
 * Each parser preserves what the tool actually printed: unparseable lines are
 * sampled and counted rather than silently dropped, and derived
 * classifications carry their evidence basis.
 */

import {
  adbHostFileName,
  type AdbHostFileNameReason,
} from "./AdbHostFileName.js";
import {
  collectUnparsedLines,
  type AdbUnparsedLines,
} from "./AdbUnparsedLines.js";
import {
  ADB_DEVICE_STATES,
  type AdbDeviceObservation,
} from "../domain/adb/adbDeviceAnalysis.js";

import { parseAdbTransportIdentity } from "../domain/adb/adbTransportIdentity.js";

const DEVICE_LINE = /^(\S+)\s+(.*)$/u;

/**
 * adb prints a wireless-debugging transport's serial as the mDNS instance
 * `<instance>._adb._tcp` or `<instance>._adb-tls-connect._tcp`. That serial
 * has neither a colon nor a `usb:` field.
 */
const isAdbMdnsTcpSerial = (serial: string): boolean =>
  serial.endsWith("._adb._tcp") || serial.endsWith("._adb-tls-connect._tcp");

const normalizeAdbOutputLine = (rawLine: string): string => rawLine.trimEnd();

export const isSuccessfulDaemonStartNotice = (line: string): boolean =>
  line === "* daemon started successfully" ||
  line === "* daemon started successfully *";

/** Host-side startup line, shared by failure and successful probe parsing. */
export const isDaemonStartingNotice = (line: string): boolean =>
  /^\* daemon not running(?:; starting now at [^\r\n]*|\. starting it now on port \d+ \*)$/u.test(
    line,
  );

/** No diagnostics beyond a completed, recognized startup sequence. */
export const hasOnlySuccessfulAdbStartupNotices = (output: string): boolean => {
  let started = false;
  for (let offset = 0; offset < output.length;) {
    const newline = output.indexOf("\n", offset);
    const line = normalizeAdbOutputLine(
      output.slice(offset, newline === -1 ? output.length : newline),
    );
    if (isSuccessfulDaemonStartNotice(line)) started = true;
    else if (isDaemonStartingNotice(line)) started = false;
    else return false;
    offset = newline === -1 ? output.length : newline + 1;
  }
  return started;
};

const metadataValue = (remainder: string, key: string): string | null => {
  const match = new RegExp(`(?:^|\\s)${key}:(\\S+)`, "u").exec(remainder);
  return match === null ? null : match[1]!;
};

/**
 * Parse `adb devices -l` device lines. The banner, blank lines, and the
 * daemon startup notices adb prints on first use are recognized separately;
 * every other unrecognized line is sampled and counted for honest reporting.
 */
export const parseAdbDevicesOutput = (
  stdout: string,
  stderr = "",
): {
  devices: readonly AdbDeviceObservation[];
  unparsedLines: AdbUnparsedLines;
  daemonStarted: boolean;
} => {
  const devices: AdbDeviceObservation[] = [];
  const unparsed = collectUnparsedLines();
  let daemonStarted = false;
  for (const rawLine of stdout.split(/\r?\n/u)) {
    const line = normalizeAdbOutputLine(rawLine);
    if (isSuccessfulDaemonStartNotice(line)) {
      daemonStarted = true;
      continue;
    }
    if (line === "" || line.startsWith("List of devices attached")) continue;
    if (line.startsWith("* daemon")) continue;
    const match = DEVICE_LINE.exec(line);
    const state = ADB_DEVICE_STATES.find((candidate) => {
      const remainder = match?.[2];
      if (remainder === undefined || !remainder.startsWith(candidate))
        return false;
      const next = remainder[candidate.length];
      // adb prints no-permissions as `no permissions[ (reason)]; see [URL]` and
      // omits the reason on a host where it finds no udev problem to name,
      // such as one without a plugdev group, so `;` can follow it directly.
      return (
        next === undefined ||
        /\s/u.test(next) ||
        (candidate === "no permissions" && next === ";")
      );
    });
    if (match === null || state === undefined) {
      if (rawLine.trim() !== "") unparsed.add(rawLine);
      continue;
    }
    const serial = match[1]!;
    const remainder = match[2]!.slice(state.length);
    const usb = metadataValue(remainder, "usb");
    // AOSP appends the authoritative field last; earlier metadata may contain
    // the same spelling. Keep the exact source token before decimal admission.
    const transportToken =
      /(?:^|\s)transport_id:(\S*)$/u.exec(remainder)?.[1] ?? null;
    const transportIdentity = parseAdbTransportIdentity(
      transportToken,
      rawLine,
    );
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
          : isEmulator || serial.includes(":") || isAdbMdnsTcpSerial(serial)
            ? "tcp"
            : "unknown",
      product: metadataValue(remainder, "product"),
      model: metadataValue(remainder, "model"),
      device: metadataValue(remainder, "device"),
      transport_identity: transportIdentity,
      kind,
      kind_basis:
        kind === "emulator"
          ? "emulator_serial_prefix"
          : kind === "physical"
            ? "usb_transport"
            : "none",
    });
  }
  if (!daemonStarted && stderr !== "") {
    for (const rawLine of stderr.split(/\r?\n/u)) {
      const line = normalizeAdbOutputLine(rawLine);
      if (isSuccessfulDaemonStartNotice(line)) {
        daemonStarted = true;
        break;
      }
    }
  }
  return { devices, unparsedLines: unparsed.facts(), daemonStarted };
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
    return value === undefined
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

/** Parse `pm list packages -f` lines, sampling and counting unrecognized lines. */
export const parsePackageListOutput = (
  stdout: string,
): {
  packages: readonly AdbPackageEntry[];
  unparsedLines: AdbUnparsedLines;
} => {
  const packages: AdbPackageEntry[] = [];
  const unparsed = collectUnparsedLines();
  for (const rawLine of stdout.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "") continue;
    const match = PACKAGE_LINE.exec(line);
    if (match === null) {
      unparsed.add(rawLine);
      continue;
    }
    packages.push({
      package_name: match[2]!,
      base_apk_device_path: match[1]!,
    });
  }
  return { packages, unparsedLines: unparsed.facts() };
};

/** Quote raw device paths for prose without allowing bidi or invisible text. */
export const displayDevicePath = (devicePath: string): string => {
  let excerpt = "";
  let count = 0;
  for (const character of devicePath) {
    if (count === 160) break;
    excerpt += character;
    count += 1;
  }
  const quoted = JSON.stringify(excerpt).replace(
    /[\p{C}\p{Z}\p{Default_Ignorable_Code_Point}\u2800]/gu,
    (character) =>
      character === " "
        ? character
        : `\\u{${character.codePointAt(0)!.toString(16).toUpperCase()}}`,
  );
  return excerpt.length === devicePath.length ? quoted : `${quoted} (excerpt)`;
};

/** One APK of an installed package exactly as `pm path` reports it. */
export interface AdbPackagePathEntry {
  readonly device_path: string;
  readonly file_name: string;
  readonly role: "base" | "split" | "unknown";
}

/**
 * Parse `pm path PACKAGE` lines. The base/split role is derived from the file
 * name (`base.apk`, `split_*.apk`), which is the only signal the output
 * carries; any other name reports an unknown role.
 */
export const parsePmPathOutput = (
  stdout: string,
  platform: NodeJS.Platform = process.platform,
): {
  paths: readonly AdbPackagePathEntry[];
  rejectedPaths: readonly {
    device_path: string;
    reason: AdbHostFileNameReason;
  }[];
  unparsedLines: AdbUnparsedLines;
} => {
  const paths: AdbPackagePathEntry[] = [];
  const rejectedPaths: {
    device_path: string;
    reason: AdbHostFileNameReason;
  }[] = [];
  const unparsed = collectUnparsedLines();
  for (const rawLine of stdout.split(/\r?\n/u)) {
    if (rawLine === "") continue;
    const match = /^package:(.*)$/u.exec(rawLine);
    if (match === null) {
      unparsed.add(rawLine);
      continue;
    }
    const devicePath = match[1]!;
    const validated = adbHostFileName(devicePath, platform);
    if (!validated.ok) {
      rejectedPaths.push({
        device_path: devicePath,
        reason: validated.reason,
      });
      continue;
    }
    const fileName = validated.fileName;
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
  return { paths, rejectedPaths, unparsedLines: unparsed.facts() };
};
