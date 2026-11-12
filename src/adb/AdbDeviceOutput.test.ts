import { describe, expect, it } from "vitest";

import {
  parseAdbDevicesOutput,
  parseGetpropOutput,
  parsePackageListOutput,
  parsePmPathOutput,
} from "./AdbDeviceOutput.js";

describe("parseAdbDevicesOutput", () => {
  it("parses emulator, USB, and network devices with their metadata", () => {
    const output = [
      "List of devices attached",
      "emulator-5554          device product:sdk_gphone64_x86_64 model:sdk_gphone64_x86_64 device:emu64xa transport_id:1",
      "07ef9c2a              device usb:1-1 product:raven model:Pixel_6_Pro device:raven transport_id:2",
      "192.168.1.42:5555     device product:mock model:mock transport_id:3",
      "",
    ].join("\n");
    const { devices, unparsedLines, daemonStarted } =
      parseAdbDevicesOutput(output);
    expect(unparsedLines).toEqual({ sample: [], total: 0 });
    expect(daemonStarted).toBe(false);
    expect(devices).toEqual([
      {
        serial: "emulator-5554",
        state: "device",
        transport: "tcp",
        product: "sdk_gphone64_x86_64",
        model: "sdk_gphone64_x86_64",
        device: "emu64xa",
        transport_identity: {
          status: "reported",
          decimal: "1",
          source_token: "1",
          source_line:
            "emulator-5554          device product:sdk_gphone64_x86_64 model:sdk_gphone64_x86_64 device:emu64xa transport_id:1",
        },
        kind: "emulator",
        kind_basis: "emulator_serial_prefix",
      },
      {
        serial: "07ef9c2a",
        state: "device",
        transport: "usb",
        product: "raven",
        model: "Pixel_6_Pro",
        device: "raven",
        transport_identity: {
          status: "reported",
          decimal: "2",
          source_token: "2",
          source_line:
            "07ef9c2a              device usb:1-1 product:raven model:Pixel_6_Pro device:raven transport_id:2",
        },
        kind: "physical",
        kind_basis: "usb_transport",
      },
      {
        serial: "192.168.1.42:5555",
        state: "device",
        transport: "tcp",
        product: "mock",
        model: "mock",
        device: null,
        transport_identity: {
          status: "reported",
          decimal: "3",
          source_token: "3",
          source_line:
            "192.168.1.42:5555     device product:mock model:mock transport_id:3",
        },
        kind: "unknown",
        kind_basis: "none",
      },
    ]);
  });

  it("classifies adb mDNS wireless serials as TCP without treating them as USB", () => {
    const output = [
      "List of devices attached",
      "adb-8c4f2a1b4e5d6f70-AbCdEf._adb-tls-connect._tcp device product:cheetah model:Pixel_7_Pro device:cheetah transport_id:4",
      "phone._adb._tcp       device transport_id:5",
      "not-a-service._tcp    device transport_id:6",
      "adb-wired._adb-tls-connect._tcp device usb:1-1 product:raven model:Pixel_6 device:raven transport_id:7",
      "",
    ].join("\n");
    const { devices, unparsedLines } = parseAdbDevicesOutput(output);
    expect(unparsedLines).toEqual({ sample: [], total: 0 });
    expect(
      devices.map(({ serial, transport, kind, kind_basis }) => ({
        serial,
        transport,
        kind,
        kind_basis,
      })),
    ).toEqual([
      {
        serial: "adb-8c4f2a1b4e5d6f70-AbCdEf._adb-tls-connect._tcp",
        transport: "tcp",
        kind: "unknown",
        kind_basis: "none",
      },
      {
        serial: "phone._adb._tcp",
        transport: "tcp",
        kind: "unknown",
        kind_basis: "none",
      },
      {
        serial: "not-a-service._tcp",
        transport: "unknown",
        kind: "unknown",
        kind_basis: "none",
      },
      {
        serial: "adb-wired._adb-tls-connect._tcp",
        transport: "usb",
        kind: "physical",
        kind_basis: "usb_transport",
      },
    ]);
  });
});

describe("ADB daemon startup notices", () => {
  it("recognizes daemon startup notices instead of failing the listing", () => {
    const output = [
      "* daemon not running; starting now at tcp:5037",
      "* daemon started successfully",
      "List of devices attached",
      "emulator-5554          device transport_id:1",
      "",
    ].join("\n");
    const { devices, daemonStarted } = parseAdbDevicesOutput(output);
    expect(daemonStarted).toBe(true);
    expect(devices).toHaveLength(1);
  });

  it("recognizes daemon startup notices emitted on stderr", () => {
    const stdout = [
      "List of devices attached",
      "emulator-5554          device transport_id:1",
      "",
    ].join("\n");
    const stderr = [
      "* daemon not running; starting now at tcp:5037",
      "* daemon started successfully",
      "",
    ].join("\n");
    const { devices, daemonStarted, unparsedLines } = parseAdbDevicesOutput(
      stdout,
      stderr,
    );
    expect(daemonStarted).toBe(true);
    expect(unparsedLines).toEqual({ sample: [], total: 0 });
    expect(devices).toHaveLength(1);
  });

  it("recognizes the legacy daemon notice with its trailing marker and CRLF", () => {
    const { daemonStarted, unparsedLines } = parseAdbDevicesOutput(
      "List of devices attached\r\n",
      "* daemon started successfully *\r\n",
    );
    expect(daemonStarted).toBe(true);
    expect(unparsedLines).toEqual({ sample: [], total: 0 });
  });

  it("does not treat a daemon startup error containing the success phrase as success", () => {
    const { daemonStarted, unparsedLines } = parseAdbDevicesOutput(
      "List of devices attached\r\n",
      "* daemon not started successfully\r\n",
    );
    expect(daemonStarted).toBe(false);
    expect(unparsedLines).toEqual({ sample: [], total: 0 });
  });

  it("ignores non-startup lines and device strings on stderr", () => {
    const stdout = [
      "List of devices attached",
      "emulator-5554          device transport_id:1",
      "",
    ].join("\n");
    const stderr = [
      "adb: warning: some transport warning",
      "emulator-5556          device transport_id:2",
      "",
    ].join("\n");
    const { devices, daemonStarted, unparsedLines } = parseAdbDevicesOutput(
      stdout,
      stderr,
    );
    expect(daemonStarted).toBe(false);
    expect(unparsedLines).toEqual({ sample: [], total: 0 });
    expect(devices).toHaveLength(1);
    expect(devices[0]?.serial).toBe("emulator-5554");
  });
});

describe("ADB device states", () => {
  it("keeps non-device states such as unauthorized and offline", () => {
    const output = [
      "List of devices attached",
      "emulator-5556          offline transport_id:2",
      "HT84L0240512           unauthorized usb:1-2 transport_id:3",
      "",
    ].join("\n");
    const { devices } = parseAdbDevicesOutput(output);
    expect(devices.map((device) => [device.serial, device.state])).toEqual([
      ["emulator-5556", "offline"],
      ["HT84L0240512", "unauthorized"],
    ]);
  });

  it("accepts complete multiword states and rejects state prefixes", () => {
    const output = [
      "serial-no-permission no permissions usb:1-1",
      "serial-bad-device deviceXYZ  ",
      "serial-bad-offline offline-ish",
      "serial-bad-auth unauthorizedXYZ",
    ].join("\n");
    const { devices, unparsedLines } = parseAdbDevicesOutput(output);
    expect(devices.map(({ serial, state }) => [serial, state])).toEqual([
      ["serial-no-permission", "no permissions"],
    ]);
    expect(unparsedLines).toEqual({
      sample: [
        "serial-bad-device deviceXYZ  ",
        "serial-bad-offline offline-ish",
        "serial-bad-auth unauthorizedXYZ",
      ],
      total: 3,
    });
  });

  it.each([
    [
      "without a reason",
      "no permissions; see [http://developer.android.com/tools/device.html]",
    ],
    [
      "with a reason",
      "no permissions (user alice is not in the plugdev group); see [http://developer.android.com/tools/device.html]",
    ],
  ])("parses adb's no-permissions help text %s", (_name, stateText) => {
    const { devices, unparsedLines } = parseAdbDevicesOutput(
      [
        "List of devices attached",
        `07ef9c2a               ${stateText} usb:1-1 transport_id:4`,
        "emulator-5554          device product:sdk model:sdk device:emu transport_id:1",
        "",
      ].join("\n"),
    );
    expect(unparsedLines).toEqual({ sample: [], total: 0 });
    expect(devices.map(({ serial, state }) => [serial, state])).toEqual([
      ["07ef9c2a", "no permissions"],
      ["emulator-5554", "device"],
    ]);
    expect(devices[0]).toMatchObject({
      transport: "usb",
      product: null,
      model: null,
      device: null,
      transport_identity: {
        status: "reported",
        decimal: "4",
        source_token: "4",
        source_line: `07ef9c2a               ${stateText} usb:1-1 transport_id:4`,
      },
      kind: "physical",
    });
  });

  it("rejects a semicolon after any state other than no permissions", () => {
    const { devices, unparsedLines } = parseAdbDevicesOutput(
      "serial-bad-device device; see [url] transport_id:1\n",
    );
    expect(devices).toEqual([]);
    expect(unparsedLines.total).toBe(1);
  });

  it("returns unrecognized lines instead of dropping them", () => {
    const output = [
      "List of devices attached",
      "this is not a device line",
      "",
    ].join("\n");
    const { unparsedLines } = parseAdbDevicesOutput(output);
    expect(unparsedLines).toEqual({
      sample: ["this is not a device line"],
      total: 1,
    });
  });

  it("reports a non-numeric transport_id as unknown", () => {
    const output = [
      "List of devices attached",
      "emulator-5554          device transport_id:not-a-number",
      "",
    ].join("\n");
    const { devices } = parseAdbDevicesOutput(output);
    expect(devices[0]?.transport_identity).toEqual({
      status: "invalid",
      source_token: "not-a-number",
      source_line: "emulator-5554          device transport_id:not-a-number",
      reason: "invalid_decimal",
    });
  });
});

describe("parseGetpropOutput", () => {
  it("projects the whitelisted build identity from a real dump", () => {
    const dump = [
      "[ro.build.version.release]: [14]",
      "[ro.build.version.sdk]: [34]",
      "[ro.build.version.security_patch]: [2024-06-05]",
      "[ro.build.id]: [AP21.240617.014]",
      "[ro.build.fingerprint]: [google/sdk_gphone64_x86_64/emu64xa:14/AP21.240617.014/12094027:userdebug/dev-keys]",
      "[ro.product.brand]: [google]",
      "[ro.product.device]: [emu64xa]",
      "[ro.product.manufacturer]: [Google]",
      "[ro.product.model]: [sdk_gphone64_x86_64]",
      "[ro.product.cpu.abilist]: [x86_64,x86,arm64-v8a,armeabi-v7a,armeabi]",
      "[ro.kernel.qemu]: [1]",
      "[ro.debuggable]: [1]",
      "[sys.unlisted.property]: [dropped]",
      "",
    ].join("\n");
    const { properties, emulatorObserved } = parseGetpropOutput(dump);
    expect(emulatorObserved).toBe(true);
    expect(properties).not.toContainEqual({
      name: "sys.unlisted.property",
      value: "dropped",
    });
    expect(properties).toEqual([
      { name: "ro.build.version.release", value: "14" },
      { name: "ro.build.version.sdk", value: "34" },
      { name: "ro.build.version.security_patch", value: "2024-06-05" },
      { name: "ro.build.id", value: "AP21.240617.014" },
      {
        name: "ro.build.fingerprint",
        value:
          "google/sdk_gphone64_x86_64/emu64xa:14/AP21.240617.014/12094027:userdebug/dev-keys",
      },
      { name: "ro.debuggable", value: "1" },
      { name: "ro.kernel.qemu", value: "1" },
      { name: "ro.product.brand", value: "google" },
      { name: "ro.product.device", value: "emu64xa" },
      { name: "ro.product.manufacturer", value: "Google" },
      { name: "ro.product.model", value: "sdk_gphone64_x86_64" },
      {
        name: "ro.product.cpu.abilist",
        value: "x86_64,x86,arm64-v8a,armeabi-v7a,armeabi",
      },
    ]);
  });

  it("reports an explicit non-emulator build without inventing a value", () => {
    const dump = [
      "[ro.build.version.release]: [13]",
      "[ro.kernel.qemu]: [0]",
      "",
    ].join("\n");
    const { emulatorObserved } = parseGetpropOutput(dump);
    expect(emulatorObserved).toBe(false);
  });

  it("reports the emulator indicator unknown when the build omits it", () => {
    const { emulatorObserved } = parseGetpropOutput(
      "[ro.build.version.sdk]: [33]\n",
    );
    expect(emulatorObserved).toBeNull();
  });
});

describe("parsePackageListOutput", () => {
  it("parses package lines with their base APK device paths", () => {
    const output = [
      "package:/data/app/~~xy==/com.example.npzyCvVb1I-YzKIsGFvVYw==/base.apk=com.example",
      "package:/system/app/WebView/WebView.apk=com.android.webview",
      "",
    ].join("\n");
    const { packages, unparsedLines } = parsePackageListOutput(output);
    expect(unparsedLines).toEqual({ sample: [], total: 0 });
    expect(packages).toEqual([
      {
        package_name: "com.example",
        base_apk_device_path:
          "/data/app/~~xy==/com.example.npzyCvVb1I-YzKIsGFvVYw==/base.apk",
      },
      {
        package_name: "com.android.webview",
        base_apk_device_path: "/system/app/WebView/WebView.apk",
      },
    ]);
  });

  it("keeps unrecognized lines for partial coverage reporting", () => {
    const { packages, unparsedLines } = parsePackageListOutput(
      "package:/data/app/x/base.apk=com.ok\n  garbage line  \n",
    );
    expect(packages).toHaveLength(1);
    expect(unparsedLines).toEqual({ sample: ["  garbage line  "], total: 1 });
  });

  it("samples the first ten unrecognized lines and counts every one", () => {
    const rows = Array.from(
      { length: 11 },
      (_, index) => `row ${String(index + 1)}`,
    );
    const { packages, unparsedLines } = parsePackageListOutput(
      ["package:/data/app/x/base.apk=com.ok", ...rows].join("\n"),
    );
    expect(packages).toHaveLength(1);
    expect(unparsedLines).toEqual({ sample: rows.slice(0, 10), total: 11 });
  });
});

describe("parsePmPathOutput", () => {
  it("classifies base and split APKs from their file names", () => {
    const output = [
      "package:/data/app/~~a==/com.example.b==/base.apk",
      "package:/data/app/~~a==/com.example.b==/split_config.arm64_v8a.apk",
      "package:/data/app/~~a==/com.example.b==/split_config.en.apk",
      "",
    ].join("\n");
    const { paths, unparsedLines } = parsePmPathOutput(output);
    expect(unparsedLines).toEqual({ sample: [], total: 0 });
    expect(paths).toEqual([
      {
        device_path: "/data/app/~~a==/com.example.b==/base.apk",
        file_name: "base.apk",
        role: "base",
      },
      {
        device_path:
          "/data/app/~~a==/com.example.b==/split_config.arm64_v8a.apk",
        file_name: "split_config.arm64_v8a.apk",
        role: "split",
      },
      {
        device_path: "/data/app/~~a==/com.example.b==/split_config.en.apk",
        file_name: "split_config.en.apk",
        role: "split",
      },
    ]);
  });

  it("reports an unknown role for names that follow neither convention", () => {
    const { paths } = parsePmPathOutput("package:/system/app/X/Y.apk\n");
    expect(paths[0]).toEqual({
      device_path: "/system/app/X/Y.apk",
      file_name: "Y.apk",
      role: "unknown",
    });
  });

  it("preserves whitespace and the exact POSIX device path", () => {
    const devicePath = "/data/app/My App/résumé:final\\draft*.apk";
    const { paths, rejectedPaths, unparsedLines } = parsePmPathOutput(
      `package:${devicePath}\r\n`,
      "linux",
    );
    expect(paths).toEqual([
      {
        device_path: devicePath,
        file_name: "résumé:final\\draft*.apk",
        role: "unknown",
      },
    ]);
    expect(rejectedPaths).toEqual([]);
    expect(unparsedLines).toEqual({ sample: [], total: 0 });
  });

  it("rejects an empty final component without normalizing the source", () => {
    const devicePath = "/data/app/pkg/base.apk/";
    const parsed = parsePmPathOutput(`package:${devicePath}\n`);
    expect(parsed.paths).toEqual([]);
    expect(parsed.rejectedPaths).toEqual([
      { device_path: devicePath, reason: "empty_file_name" },
    ]);
  });

  it("retains malformed lines including surrounding whitespace", () => {
    expect(
      parsePmPathOutput(" package:/data/app/pkg/base.apk \n").unparsedLines,
    ).toEqual({ sample: [" package:/data/app/pkg/base.apk "], total: 1 });
  });
});

it.each([
  ["1", "reported", "1"],
  ["2147483648", "reported", "2147483648"],
  ["9007199254740991", "reported", "9007199254740991"],
  ["9007199254740993", "reported", "9007199254740993"],
  ["18446744073709551615", "reported", "18446744073709551615"],
  ["0001", "reported", "1"],
  ["0", "invalid", "reserved_zero"],
  ["-1", "invalid", "invalid_decimal"],
  ["1e3", "invalid", "invalid_decimal"],
  ["", "invalid", "invalid_decimal"],
  ["18446744073709551616", "invalid", "outside_uint64"],
] as const)("retains exact transport identity %s", (token, status, fact) => {
  const { devices } = parseAdbDevicesOutput(
    `serial device model:Pixel transport_id:${token}\r\n`,
  );
  expect(devices[0]).toMatchObject({
    serial: "serial",
    model: "Pixel",
    transport_identity: {
      status,
      source_token: token,
      ...(status === "reported" ? { decimal: fact } : { reason: fact }),
    },
  });
});

it("uses only the final transport field and distinguishes a missing field", () => {
  const { devices } = parseAdbDevicesOutput(
    [
      "first device product:foo transport_id:7 model:Pixel transport_id:9",
      "second device product:foo transport_id:7 model:Pixel",
    ].join("\n"),
  );
  expect(devices[0]).toMatchObject({
    transport_identity: { status: "reported", decimal: "9", source_token: "9" },
  });
  expect(devices[1]).toMatchObject({
    transport_identity: { status: "not_reported", source_token: null },
  });
});

// AOSP `transport.cpp append_transport()` substitutes this placeholder when the transport has no
// serial to report, which `client/usb_linux.cpp` keeps for a device that cannot report one during
// early bringup (http://b/20883914). It contains spaces, and the long listing pads it with `%-22s`,
// so the serial column is not one `\S+` token.
it("parses the placeholder adb prints for a transport with no serial", () => {
  const output = [
    "List of devices attached",
    "(no serial number)     device usb:1-3 product:beryllium model:POCO_F1 device:beryllium transport_id:2",
    "(no serial number)     offline usb:1-4 transport_id:3",
    "",
  ].join("\n");
  const { devices, unparsedLines } = parseAdbDevicesOutput(output);
  expect(unparsedLines).toEqual({ sample: [], total: 0 });
  expect(
    devices.map(({ serial, state, transport, kind }) => ({
      serial,
      state,
      transport,
      kind,
    })),
  ).toEqual([
    {
      serial: "(no serial number)",
      state: "device",
      transport: "usb",
      kind: "physical",
    },
    {
      serial: "(no serial number)",
      state: "offline",
      transport: "usb",
      kind: "physical",
    },
  ]);
  expect(devices[0]?.transport_identity).toMatchObject({
    status: "reported",
    decimal: "2",
  });
});

it("keeps the other attached devices when one transport has no serial", () => {
  // `AdbDeviceOperations` rejects any unparsed line outright, so a placeholder the pattern missed
  // removed every healthy device from the result as well.
  const output = [
    "List of devices attached",
    "emulator-5554\tdevice",
    "07ef9c2a\tdevice",
    "(no serial number)     offline usb:1-4 transport_id:3",
    "",
  ].join("\n");
  const { devices, unparsedLines } = parseAdbDevicesOutput(output);
  expect(unparsedLines.total).toBe(0);
  expect(devices.map(({ serial }) => serial)).toEqual([
    "emulator-5554",
    "07ef9c2a",
    "(no serial number)",
  ]);
});

it("parses the placeholder in the short listing too", () => {
  const { devices, unparsedLines } = parseAdbDevicesOutput(
    ["List of devices attached", "(no serial number)\tdevice", ""].join("\n"),
  );
  expect(unparsedLines.total).toBe(0);
  expect(devices[0]).toMatchObject({
    serial: "(no serial number)",
    state: "device",
  });
});
