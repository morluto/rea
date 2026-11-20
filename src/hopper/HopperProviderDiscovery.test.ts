import { existsSync } from "node:fs";
import { mkdir, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { parseConfig } from "../config/parseConfig.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import { silentLogger } from "../logger.js";
import { HopperProvider } from "./HopperProvider.js";

describe("Hopper provider discovery", () => {
  it.each(["darwin", "linux"] as const)(
    "reports launcher availability for an injected %s host",
    async (platform) => {
      const available = provider(
        process.execPath,
        platform,
      ).inspectAvailability();
      expect(available).toEqual({
        status: "available",
        code: null,
        reason: null,
        diagnostics: {
          launcher_path: process.execPath,
          platform,
        },
      });

      const home = await createTestTempDirectory(
        "rea-hopper-missing-launcher-",
      );
      const missingPath = join(home, "missing");
      expect(provider(missingPath, platform).inspectAvailability()).toEqual({
        status: "unavailable",
        code: "executable_missing",
        reason: `Hopper launcher is missing or not executable: ${missingPath}`,
        remediation: expect.stringContaining("HOPPER_LAUNCHER_PATH"),
        diagnostics: {
          launcher_path: missingPath,
          platform,
        },
      });
    },
  );

  it.skipIf(
    process.platform === "win32" || existsSync("/opt/hopper/bin/Hopper"),
  )(
    "discovers the launcher from the provider's host and home when none is configured",
    async () => {
      const home = await createTestTempDirectory("rea-hopper-discovery-");
      const launcher = join(home, ".local/share/rea/hopper/bin/Hopper");
      await mkdir(dirname(launcher), { recursive: true });
      await symlink(process.execPath, launcher);
      const config = parseConfig({});
      if (!config.ok) throw config.error;
      const hopper = new HopperProvider(
        config.value,
        silentLogger,
        { HOME: home },
        "linux",
      );
      expect(hopper.inspectAvailability()).toMatchObject({
        status: "available",
        diagnostics: { launcher_path: launcher, platform: "linux" },
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "reports a directory launcher path as missing",
    () => {
      const directory = dirname(process.execPath);
      expect(provider(directory).inspectAvailability()).toEqual({
        status: "unavailable",
        code: "executable_missing",
        reason: `Hopper launcher is missing or not executable: ${directory}`,
        remediation: expect.stringContaining("HOPPER_LAUNCHER_PATH"),
        diagnostics: {
          launcher_path: directory,
          platform: process.platform,
        },
      });
    },
  );

  it("rejects an injected Windows host even with a selected executable", () => {
    expect(
      provider(process.execPath, "win32").inspectAvailability(),
    ).toMatchObject({
      status: "unavailable",
      code: "unsupported_host",
      diagnostics: { platform: "win32", launcher_path: process.execPath },
      remediation: expect.stringContaining("REA_ANALYSIS_PROVIDER"),
    });
  });

  it.runIf(process.platform === "win32")(
    "reports Hopper integration as unsupported on Windows",
    () => {
      expect(provider(process.execPath).inspectAvailability()).toMatchObject({
        status: "unavailable",
        code: "unsupported_host",
        diagnostics: { platform: "win32" },
      });
    },
  );

  it("separates target kind, format, and architecture support", () => {
    const hopper = provider(process.execPath, "linux");
    expect(hopper.inspectTargetSupport(databaseTarget())).toMatchObject({
      status: "supported",
    });
    expect(hopper.inspectTargetSupport(executableTarget)).toMatchObject({
      status: "supported",
    });
    expect(hopper.inspectTargetSupport(artifactTarget())).toMatchObject({
      status: "unsupported",
      code: "target_kind_unsupported",
      diagnostics: { target_kind: "archive", target_format: "asar" },
    });
  });

  it("fails closed for saved Hopper databases on macOS without a bridge launch route", () => {
    expect(
      provider(process.execPath, "darwin").inspectTargetSupport(
        databaseTarget(),
      ),
    ).toMatchObject({
      status: "unsupported",
      code: "target_kind_unsupported",
      reason: expect.stringContaining("cannot start REA's analysis bridge"),
      diagnostics: {
        target_kind: "database",
        target_format: "analysis-database",
      },
    });
  });
});

const provider = (
  launcherPath: string,
  platform?: NodeJS.Platform,
): HopperProvider => {
  const config = parseConfig({ HOPPER_LAUNCHER_PATH: launcherPath });
  if (!config.ok) throw config.error;
  return new HopperProvider(config.value, silentLogger, {}, platform);
};

const databaseTarget = (): BinaryTarget => ({
  path: "/tmp/fixture.hop",
  sha256: "a".repeat(64),
  kind: "database",
  format: "analysis-database",
});

const executableTarget: BinaryTarget = {
  path: "/tmp/fixture",
  sha256: "b".repeat(64),
  kind: "executable",
  format: "elf",
  architecture: "x86_64",
  availableArchitectures: ["x86_64"],
};

const artifactTarget = (): BinaryTarget => ({
  path: "/tmp/app.asar",
  sha256: "c".repeat(64),
  kind: "archive",
  format: "asar",
});
