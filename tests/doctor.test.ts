import { describe, expect, it } from "vitest";
import { runDoctor, type DoctorHost } from "../src/application/Doctor.js";

const host = (overrides: Partial<DoctorHost> = {}): DoctorHost => ({
  platform: "darwin",
  nodeVersion: "24.18.0",
  macosVersion: () => Promise.resolve("12.0"),
  linuxDistribution: () => Promise.resolve(undefined),
  validTarget: (path) => Promise.resolve(path.includes("Hopper")),
  executable: (path) => Promise.resolve(path.includes("Hopper")),
  supportedLinuxHopper: () => Promise.resolve(true),
  linuxDemoRuntimeReady: () => Promise.resolve(true),
  brewHopperPath: () => Promise.resolve(undefined),
  manualHopperPaths: () => Promise.resolve([]),
  ...overrides,
});

describe("doctor", () => {
  it("returns exact recovery for every failed diagnostic", async () => {
    const result = await runDoctor(
      "/missing/app",
      host({
        nodeVersion: "20.0.0",
        macosVersion: () => Promise.resolve("11.7"),
        executable: () => Promise.resolve(false),
        validTarget: () => Promise.resolve(false),
      }),
    );
    expect(
      Object.fromEntries(
        result.checks.map(({ name, remediation }) => [name, remediation]),
      ),
    ).toEqual({
      node: "Install Node.js 22.19+ or 24.11+.",
      host: "REA supports macOS 12+, Ubuntu 24.04+, Fedora 41+, and 64-bit Arch Linux.",
      hopper: "Run rea setup to install Hopper, or set HOPPER_LAUNCHER_PATH.",
      target: "Supply a readable local app or program path.",
    });
  });

  it.each(["11.7", undefined])(
    "rejects unsupported macOS version %s",
    async (version) => {
      const result = await runDoctor(
        undefined,
        host({ macosVersion: () => Promise.resolve(version) }),
      );
      expect(result.checks.find(({ name }) => name === "host")?.ok).toBe(false);
    },
  );
  it("detects a manual configured Hopper before Homebrew", async () => {
    const result = await runDoctor(
      undefined,
      host({
        configuredHopperPath: "/manual/Hopper",
        executable: (path) => Promise.resolve(path === "/manual/Hopper"),
      }),
    );
    expect(result.hopperPath).toBe("/manual/Hopper");
    expect(result.healthy).toBe(true);
  });
  it("accepts an officially supported Linux distribution", async () => {
    const path = "/home/user/.local/share/rea/hopper/bin/Hopper";
    const result = await runDoctor(
      undefined,
      host({
        platform: "linux",
        macosVersion: () => Promise.resolve(undefined),
        linuxDistribution: () =>
          Promise.resolve({
            id: "ubuntu",
            versionId: "24.04",
            packageFamily: "deb",
            supported: true,
          }),
        configuredHopperPath: path,
        executable: (candidate) => Promise.resolve(candidate === path),
      }),
    );
    expect(result.healthy).toBe(true);
    expect(result.hopperPath).toBe(path);
  });
  it("reports missing Linux demo-session dependencies", async () => {
    const result = await runDoctor(
      undefined,
      host({
        platform: "linux",
        macosVersion: () => Promise.resolve(undefined),
        linuxDistribution: () =>
          Promise.resolve({
            id: "ubuntu",
            versionId: "24.04",
            packageFamily: "deb",
            supported: true,
          }),
        linuxDemoRuntimeReady: () => Promise.resolve(false),
      }),
    );
    expect(result.healthy).toBe(false);
    expect(
      result.checks.find(({ name }) => name === "hopper-demo-runtime"),
    ).toMatchObject({
      ok: false,
      classification: "missing_dependency",
      remediation: expect.stringContaining("xauth"),
    });
  });
  it("explains how to recover from an unsupported configured launcher", async () => {
    const path = "/custom/Hopper";
    const result = await runDoctor(
      undefined,
      host({
        platform: "linux",
        configuredHopperPath: path,
        linuxDistribution: () =>
          Promise.resolve({
            id: "ubuntu",
            versionId: "24.04",
            packageFamily: "deb",
            supported: true,
          }),
        executable: (candidate) => Promise.resolve(candidate === path),
        supportedLinuxHopper: () => Promise.resolve(false),
      }),
    );
    expect(
      result.checks.find(({ name }) => name === "hopper-version")?.remediation,
    ).toContain("Unset or update HOPPER_LAUNCHER_PATH");
  });
  it("detects a Homebrew cask installed outside /Applications", async () => {
    const path =
      "/opt/homebrew/Caskroom/hopper/Hopper Disassembler.app/Contents/MacOS/hopper";
    const result = await runDoctor(
      undefined,
      host({
        executable: (candidate) => Promise.resolve(candidate === path),
        brewHopperPath: () => Promise.resolve(path),
      }),
    );
    expect(result.hopperPath).toBe(path);
  });

  it("detects a manually installed Hopper application", async () => {
    const path = "/Applications/Hopper v6.app/Contents/MacOS/hopper";
    const result = await runDoctor(
      undefined,
      host({
        executable: (candidate) => Promise.resolve(candidate === path),
        manualHopperPaths: () => Promise.resolve([path]),
      }),
    );
    expect(result.hopperPath).toBe(path);
  });

  it("uses shared app target validation when a target is supplied", async () => {
    const result = await runDoctor(
      "/Applications/Notes.app",
      host({
        validTarget: (path) =>
          Promise.resolve(path === "/Applications/Notes.app"),
      }),
    );
    expect(result.checks.find(({ name }) => name === "target")?.ok).toBe(true);
  });

  it("rejects a readable Hopper launcher without execute permission", async () => {
    const path = "/manual/Hopper";
    const result = await runDoctor(
      undefined,
      host({
        configuredHopperPath: path,
        validTarget: () => Promise.resolve(true),
        executable: () => Promise.resolve(false),
      }),
    );
    expect(result.hopperPath).toBeUndefined();
    expect(result.checks.find(({ name }) => name === "hopper")?.ok).toBe(false);
  });
});
