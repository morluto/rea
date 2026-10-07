import { describe, expect, it } from "vitest";

import {
  defaultHopperLauncherPath,
  parseConfig,
} from "../../src/config/parseConfig.js";

describe("Hopper launcher defaults", () => {
  it("prefers an executable system Hopper on Linux", () => {
    const executable = (path: string) => path === "/opt/hopper/bin/Hopper";
    expect(defaultHopperLauncherPath("linux", "/home/test", executable)).toBe(
      "/opt/hopper/bin/Hopper",
    );
  });

  it("falls back to the legacy user-local Hopper on Linux", () => {
    const executable = (path: string) =>
      path === "/home/test/.local/share/rea/hopper/bin/Hopper";
    expect(defaultHopperLauncherPath("linux", "/home/test", executable)).toBe(
      "/home/test/.local/share/rea/hopper/bin/Hopper",
    );
  });

  it("keeps the system path as the diagnostic fallback when neither exists", () => {
    expect(defaultHopperLauncherPath("linux", "/home/test", () => false)).toBe(
      "/opt/hopper/bin/Hopper",
    );
  });

  it("keeps explicit HOPPER_LAUNCHER_PATH authoritative", () => {
    const parsed = parseConfig({
      HOPPER_LAUNCHER_PATH: "/custom/Hopper",
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok)
      expect(parsed.value.hopperLauncherPath).toBe("/custom/Hopper");
  });
});
