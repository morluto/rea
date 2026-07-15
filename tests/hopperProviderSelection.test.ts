import { describe, expect, it } from "vitest";

import { parseConfig } from "../src/config.js";
import type { BinaryTarget } from "../src/domain/binaryTarget.js";
import { HopperProvider } from "../src/hopper/HopperProvider.js";
import { silentLogger } from "../src/logger.js";

describe("Hopper provider discovery", () => {
  it("reports bounded launcher availability without starting Hopper", () => {
    const available = provider(process.execPath).inspectAvailability();
    expect(available).toEqual({
      status: "available",
      code: null,
      reason: null,
      diagnostics: {
        launcher_path: process.execPath,
        platform: process.platform,
      },
    });

    const missingPath = "/missing/rea-hopper-launcher";
    expect(provider(missingPath).inspectAvailability()).toEqual({
      status: "unavailable",
      code: "executable_missing",
      reason: `Hopper launcher is missing or not executable: ${missingPath}`,
      diagnostics: {
        launcher_path: missingPath,
        platform: process.platform,
      },
    });
  });

  it("separates target kind, format, and architecture support", () => {
    const hopper = provider(process.execPath);
    expect(hopper.inspectTargetSupport(databaseTarget())).toMatchObject({
      status: "supported",
    });
    expect(
      hopper.inspectTargetSupport(executableTarget("elf", "x86_64")),
    ).toMatchObject({ status: "supported" });
    expect(hopper.inspectTargetSupport(artifactTarget())).toMatchObject({
      status: "unsupported",
      code: "target_kind_unsupported",
      diagnostics: { target_kind: "archive", target_format: "asar" },
    });
    expect(
      hopper.inspectTargetSupport(executableTargetWithoutArchitecture()),
    ).toMatchObject({
      status: "unsupported",
      code: "architecture_unsupported",
    });
  });
});

const provider = (launcherPath: string): HopperProvider => {
  const config = parseConfig({ HOPPER_LAUNCHER_PATH: launcherPath });
  if (!config.ok) throw config.error;
  return new HopperProvider(config.value, silentLogger);
};

const databaseTarget = (): BinaryTarget => ({
  path: "/tmp/fixture.hop",
  sha256: "a".repeat(64),
  kind: "database",
  format: "analysis-database",
});

const executableTarget = (
  format: "mach-o" | "elf" | "pe",
  architecture: "x86" | "x86_64" | "arm" | "arm64",
): BinaryTarget => ({
  path: "/tmp/fixture",
  sha256: "b".repeat(64),
  kind: "executable",
  format,
  architecture,
  availableArchitectures: [architecture],
});

const executableTargetWithoutArchitecture = (): BinaryTarget => ({
  path: "/tmp/fixture",
  sha256: "b".repeat(64),
  kind: "executable",
  format: "elf",
});

const artifactTarget = (): BinaryTarget => ({
  path: "/tmp/app.asar",
  sha256: "c".repeat(64),
  kind: "archive",
  format: "asar",
});
