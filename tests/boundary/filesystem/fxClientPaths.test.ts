import { describe, expect, it } from "vitest";

import { fxLocation } from "../../../src/application/SupportedClientLocations.js";

describe("fxClientPaths", () => {
  it("resolves default fx configuration on win32 using pathApi separators", () => {
    const location = fxLocation({
      home: "C:\\Users\\alice",
      platform: "win32",
      env: {},
    });
    expect(location).toEqual({
      ok: true,
      value: {
        configPath: "C:\\Users\\alice\\.fx\\mcp.json",
        markerPath: "C:\\Users\\alice\\.fx",
      },
    });
  });

  it("resolves default fx configuration on POSIX", () => {
    const location = fxLocation({
      home: "/home/alice",
      platform: "linux",
      env: {},
    });
    expect(location).toEqual({
      ok: true,
      value: {
        configPath: "/home/alice/.fx/mcp.json",
        markerPath: "/home/alice/.fx",
      },
    });
  });

  it.each([
    ["C:\\Users\\alice\\", "trailing backslash matching home"],
    ["C:/Users/alice/", "mixed slashes matching home"],
    ["C:/Users//alice/", "doubled slashes matching home"],
    ["c:\\users\\alice", "case-insensitive matching home"],
    [
      "c:\\users\\alice\\",
      "case-insensitive with trailing backslash matching home",
    ],
    ["D:\\", "drive root with single backslash"],
    ["D:\\\\", "drive root with double backslash"],
    ["D:/", "drive root with forward slash"],
    ["D:", "drive root without slash"],
  ])("refuses an invalid win32 FX_HOME of %s (%s)", (value) => {
    const location = fxLocation({
      home: "C:\\Users\\alice",
      platform: "win32",
      env: { FX_HOME: value },
    });
    expect(location).toMatchObject({
      ok: false,
      error: {
        path: value,
        message: expect.stringContaining("FX_HOME"),
      },
    });
  });

  it.each([
    ["C:\\custom\\fx\\", "C:\\custom\\fx\\mcp.json", "C:\\custom\\fx"],
    ["C:/custom/fx/", "C:\\custom\\fx\\mcp.json", "C:\\custom\\fx"],
    ["C:\\custom\\fx", "C:\\custom\\fx\\mcp.json", "C:\\custom\\fx"],
  ])(
    "normalizes valid win32 FX_HOME (%s)",
    (input, expectedConfig, expectedMarker) => {
      const location = fxLocation({
        home: "C:\\Users\\alice",
        platform: "win32",
        env: { FX_HOME: input },
      });
      expect(location).toEqual({
        ok: true,
        value: {
          configPath: expectedConfig,
          markerPath: expectedMarker,
        },
      });
    },
  );

  it("normalizes valid POSIX FX_HOME with trailing slash", () => {
    const location = fxLocation({
      home: "/home/alice",
      platform: "linux",
      env: { FX_HOME: "/custom/fx/" },
    });
    expect(location).toEqual({
      ok: true,
      value: {
        configPath: "/custom/fx/mcp.json",
        markerPath: "/custom/fx",
      },
    });
  });

  it("preserves literal trailing backslashes on POSIX", () => {
    const location = fxLocation({
      home: "/home/alice",
      platform: "linux",
      env: { FX_HOME: "/profiles/fx\\" },
    });
    expect(location).toEqual({
      ok: true,
      value: {
        configPath: "/profiles/fx\\/mcp.json",
        markerPath: "/profiles/fx\\",
      },
    });
  });
});
