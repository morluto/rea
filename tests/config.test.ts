import { describe, expect, it } from "vitest";

import { parseConfig } from "../src/config.js";

describe("runtime configuration", () => {
  it("requires a target and defaults to Hopper's documented launcher", () => {
    expect(parseConfig({}).ok).toBe(false);
    const result = parseConfig({ HOPPER_TARGET_PATH: "/usr/bin/true" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.hopperLauncherPath).toContain("/MacOS/hopper");
      expect(result.value.hopperTargetKind).toBe("executable");
      expect(result.value.hopperLoaderArgs).toEqual([]);
    }
  });

  it("parses database kind and loader arguments", () => {
    expect(
      parseConfig({
        HOPPER_TARGET_PATH: "/fixture/sample.hop",
        HOPPER_TARGET_KIND: "database",
        HOPPER_LOADER_ARGS_JSON: '["-l","FAT","--aarch64","-l","Mach-O"]',
      }),
    ).toEqual({
      ok: true,
      value: {
        hopperLauncherPath:
          "/Applications/Hopper Disassembler.app/Contents/MacOS/hopper",
        hopperTargetPath: "/fixture/sample.hop",
        hopperTargetKind: "database",
        hopperLoaderArgs: ["-l", "FAT", "--aarch64", "-l", "Mach-O"],
      },
    });
  });

  it.each(["not-json", "{}", '["ok",1]'])(
    "rejects invalid loader args: %s",
    (encoded) => {
      expect(
        parseConfig({
          HOPPER_TARGET_PATH: "/tmp/a",
          HOPPER_LOADER_ARGS_JSON: encoded,
        }).ok,
      ).toBe(false);
    },
  );
});
