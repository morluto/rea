import { describe, expect, it } from "vitest";

import {
  ADB_BINARY_ENV,
  parseAdbVersionOutput,
  resolveAdbBinary,
} from "./AdbConfiguration.js";

describe("resolveAdbBinary", () => {
  it("prefers an absolute REA_ADB_PATH", () => {
    expect(resolveAdbBinary({ [ADB_BINARY_ENV]: "/opt/tools/adb" })).toEqual({
      binary: "/opt/tools/adb",
      pathSource: "environment",
    });
  });

  it("falls back to PATH resolution without the environment key", () => {
    expect(resolveAdbBinary({})).toEqual({
      binary: "adb",
      pathSource: "path",
    });
    expect(resolveAdbBinary({ [ADB_BINARY_ENV]: "  " })).toEqual({
      binary: "adb",
      pathSource: "path",
    });
  });

  it("rejects a relative environment path explicitly", () => {
    expect(() => resolveAdbBinary({ [ADB_BINARY_ENV]: "tools/adb" })).toThrow(
      /must be an absolute path/u,
    );
  });
});

describe("parseAdbVersionOutput", () => {
  it("reads the build version and install path from real output", () => {
    expect(
      parseAdbVersionOutput(
        [
          "Android Debug Bridge version 1.0.41",
          "Version 34.0.5-debian",
          "Installed as /usr/lib/android-sdk/platform-tools/adb",
          "",
        ].join("\n"),
      ),
    ).toEqual({
      version: "34.0.5-debian",
      installedPath: "/usr/lib/android-sdk/platform-tools/adb",
    });
  });

  it("reports null identity fields when the named lines are absent", () => {
    expect(parseAdbVersionOutput("unexpected output")).toEqual({
      version: null,
      installedPath: null,
    });
  });
});
