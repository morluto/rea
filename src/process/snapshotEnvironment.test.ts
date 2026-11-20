import { expect, it } from "vitest";

import {
  mergeEnvironmentOverrides,
  snapshotEnvironment,
} from "./snapshotEnvironment.js";

it.each(["win32", "linux"] as const)(
  "merges explicit environment layers using %s key identity",
  (platform) => {
    const existing = {
      rea_analysis_provider: "hopper",
      CallerSetting: "retain",
    };
    const overrides = { REA_ANALYSIS_PROVIDER: "ghidra", Path: "chosen" };
    const merged = mergeEnvironmentOverrides(existing, overrides, platform);
    expect(merged).toEqual(
      platform === "win32"
        ? {
            REA_ANALYSIS_PROVIDER: "ghidra",
            CallerSetting: "retain",
            Path: "chosen",
          }
        : { ...existing, ...overrides },
    );
    expect(Object.isFrozen(merged)).toBe(true);
    expect(existing.rea_analysis_provider).toBe("hopper");
    expect(overrides.REA_ANALYSIS_PROVIDER).toBe("ghidra");
  },
);

it("preserves case-sensitive POSIX variables in an immutable snapshot", () => {
  const selected = { PATH: "/chosen/bin", Path: "/other/bin" };
  const snapshot = snapshotEnvironment(selected, "linux");
  selected.PATH = "/later/bin";
  expect(snapshot).toEqual({ PATH: "/chosen/bin", Path: "/other/bin" });
  expect(Object.isFrozen(snapshot)).toBe(true);
});

it("keeps the last caller value for Windows aliases, including undefined", () => {
  const snapshot = snapshotEnvironment(
    {
      PATH: "upper",
      path: "lower",
      COMSPEC: "upper-cmd",
      ComSpec: "mixed-cmd",
      TEMP: "ambient-temp",
      temp: undefined,
    },
    "win32",
  );

  expect(snapshot).toEqual({
    COMSPEC: "mixed-cmd",
    PATH: "lower",
    TEMP: undefined,
  });
  expect(Object.keys(snapshot)).toEqual(["COMSPEC", "PATH", "TEMP"]);
  expect(Object.isFrozen(snapshot)).toBe(true);
});
