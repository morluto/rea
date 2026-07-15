import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { BinaryTarget } from "../src/domain/binaryTarget.js";
import {
  hopperLoaderArgsForTarget,
  resolveHopperAnalysisProfile,
} from "../src/hopper/HopperAnalysisProfile.js";
import { HOPPER_PROVIDER_IDENTITY } from "../src/hopper/HopperProvider.js";

let directory: string | undefined;

afterEach(async () => {
  if (directory !== undefined)
    await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("Hopper analysis profiles", () => {
  it.each([
    [target("mach-o", "arm64"), ["-l", "Mach-O", "--aarch64"]],
    [target("elf", "x86_64"), ["-l", "ELF", "--intel-64"]],
    [target("pe", "x86"), ["-l", "WinPE", "--intel-32"]],
    [
      {
        ...target("mach-o", "arm64"),
        availableArchitectures: ["x86_64", "arm64"],
      } satisfies BinaryTarget,
      ["-l", "FAT", "--aarch64", "-l", "Mach-O"],
    ],
    [
      {
        path: "/tmp/fixture.hop",
        sha256: "b".repeat(64),
        kind: "database",
        format: "analysis-database",
      } satisfies BinaryTarget,
      [],
    ],
  ] as const)("derives complete non-interactive options", (input, expected) => {
    expect(hopperLoaderArgsForTarget(input)).toEqual({
      ok: true,
      value: expected,
    });
    expect("loaderArgs" in input).toBe(false);
  });

  it("commits launcher build and configured overrides without target coupling", async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-hopper-profile-"));
    const launcher = join(directory, "hopper");
    await writeFile(launcher, "Hopper build A");
    const input = target("mach-o", "arm64");
    const derived = await resolveHopperAnalysisProfile(input, {
      launcherPath: launcher,
      loaderArgsOverride: [],
      provider: HOPPER_PROVIDER_IDENTITY,
    });
    const overridden = await resolveHopperAnalysisProfile(input, {
      launcherPath: launcher,
      loaderArgsOverride: ["-l", "Mach-O", "--intel-64"],
      provider: HOPPER_PROVIDER_IDENTITY,
    });
    if (
      !derived.ok ||
      derived.value.profile === null ||
      !overridden.ok ||
      overridden.value.profile === null
    )
      throw new Error("fixture profiles did not resolve");
    expect(derived.value.compatibility).toEqual({
      loaderArgs: ["-l", "Mach-O", "--aarch64"],
    });
    expect(overridden.value.compatibility).toEqual({
      loaderArgs: ["-l", "Mach-O", "--intel-64"],
    });
    expect(overridden.value.profile.digest).not.toBe(
      derived.value.profile.digest,
    );
    expect(derived.value.profile.provider.version).toMatch(
      /^launcher-sha256:[a-f0-9]{64}$/u,
    );

    await writeFile(launcher, "Hopper build B");
    const changedBuild = await resolveHopperAnalysisProfile(input, {
      launcherPath: launcher,
      loaderArgsOverride: [],
      provider: HOPPER_PROVIDER_IDENTITY,
    });
    if (!changedBuild.ok || changedBuild.value.profile === null)
      throw new Error("changed fixture profile did not resolve");
    expect(changedBuild.value.profile.provider.version).not.toBe(
      derived.value.profile.provider.version,
    );
  });

  it("keeps compatibility output but declines cache identity when version is unresolved", async () => {
    const resolved = await resolveHopperAnalysisProfile(
      target("elf", "x86_64"),
      {
        launcherPath: "/missing/hopper",
        loaderArgsOverride: [],
        provider: HOPPER_PROVIDER_IDENTITY,
      },
    );
    expect(resolved).toEqual({
      ok: true,
      value: {
        profile: null,
        compatibility: {
          loaderArgs: ["-l", "ELF", "--intel-64"],
        },
      },
    });
  });

  it("stops launcher hashing when profile resolution is cancelled", async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-hopper-profile-cancel-"));
    const launcher = join(directory, "hopper");
    await writeFile(launcher, "Hopper build");
    const controller = new AbortController();
    const resolving = resolveHopperAnalysisProfile(target("elf", "x86_64"), {
      launcherPath: launcher,
      loaderArgsOverride: [],
      provider: HOPPER_PROVIDER_IDENTITY,
      signal: controller.signal,
    });

    controller.abort();

    await expect(resolving).resolves.toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCancelledError", operation: "open_binary" },
    });
  });
});

const target = (
  format: "mach-o" | "elf" | "pe",
  architecture: "x86" | "x86_64" | "arm" | "arm64",
): BinaryTarget => ({
  path: "/tmp/fixture",
  sha256: "a".repeat(64),
  kind: "executable",
  format,
  architecture,
  availableArchitectures: [architecture],
});
