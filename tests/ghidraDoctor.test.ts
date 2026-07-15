import { describe, expect, it } from "vitest";

import { runDoctor, type DoctorHost } from "../src/application/Doctor.js";
import {
  inspectGhidraInstallation,
  type GhidraInstallationHost,
  type GhidraInstallationInspection,
} from "../src/ghidra/GhidraInstallation.js";
import { projectGhidraDoctorInspection } from "../src/ghidra/GhidraDoctor.js";

const INSTALL = "/opt/ghidra_12.1.2_PUBLIC";
const installationHost = (
  overrides: Partial<GhidraInstallationHost> = {},
): GhidraInstallationHost => ({
  readText: () => "application.version=12.1.2\n",
  executable: () => true,
  probeJava: () => ({
    version: "21.0.11",
    major: 21,
    home: "/usr/lib/jvm/jdk-21",
    bits: 64,
    jdk: true,
  }),
  ...overrides,
});

const inspection = (
  options: {
    readonly installDir?: string;
    readonly architecture?: NodeJS.Architecture;
  } = { installDir: INSTALL },
  overrides: Partial<GhidraInstallationHost> = {},
): GhidraInstallationInspection =>
  inspectGhidraInstallation(
    {
      platform: "linux",
      architecture: options.architecture ?? "x64",
      ...(options.installDir === undefined
        ? {}
        : { installDir: options.installDir }),
    },
    installationHost(overrides),
  );

const doctorHost = (
  ghidra: GhidraInstallationInspection,
  hopperAvailable = false,
): DoctorHost => ({
  platform: "linux",
  nodeVersion: "24.18.0",
  macosVersion: () => Promise.resolve(undefined),
  linuxDistribution: () =>
    Promise.resolve({
      id: "ubuntu",
      versionId: "24.04",
      packageFamily: "deb",
      supported: true,
    }),
  validTarget: () => Promise.resolve(true),
  executable: (path) =>
    Promise.resolve(hopperAvailable && path.includes("Hopper")),
  supportedLinuxHopper: () => Promise.resolve(true),
  linuxDemoRuntimeReady: () => Promise.resolve(true),
  brewHopperPath: () => Promise.resolve(undefined),
  manualHopperPaths: () => Promise.resolve([]),
  providerInspections: () =>
    Promise.resolve([projectGhidraDoctorInspection(ghidra)]),
});

describe("Ghidra doctor integration", () => {
  it("accepts a valid BYO Ghidra engine when Hopper is absent", async () => {
    const result = await runDoctor(undefined, doctorHost(inspection()));

    expect(result.healthy).toBe(true);
    expect(result.hopperPath).toBeUndefined();
    expect(result.providerInspections?.[0]).toMatchObject({
      id: "ghidra",
      available: true,
      providerVersion: "12.1.2",
      registrationEnvironment: {
        GHIDRA_INSTALL_DIR: INSTALL,
        JAVA_HOME: "/usr/lib/jvm/jdk-21",
      },
    });
    expect(
      result.checks.find(({ name }) => name === "ghidra-java"),
    ).toMatchObject({
      ok: true,
      detail: expect.stringContaining("21.0.11"),
    });
  });

  it.each([
    [
      "bad installation",
      inspection({ installDir: INSTALL }, { readText: () => undefined }),
      "ghidra-installation",
    ],
    [
      "wrong version",
      inspection(
        { installDir: INSTALL },
        { readText: () => "application.version=11.4\n" },
      ),
      "ghidra-version",
    ],
    [
      "missing analyzeHeadless",
      inspection({ installDir: INSTALL }, { executable: () => false }),
      "ghidra-headless",
    ],
    [
      "wrong Java",
      inspection(
        { installDir: INSTALL },
        {
          probeJava: () => ({
            version: "17.0.12",
            major: 17,
            home: "/usr/lib/jvm/jdk-17",
            bits: 64,
            jdk: true,
          }),
        },
      ),
      "ghidra-java",
    ],
    [
      "unsupported architecture",
      inspection({ installDir: INSTALL, architecture: "arm64" }),
      "ghidra-architecture",
    ],
  ] as const)("distinguishes %s", async (_label, ghidra, checkName) => {
    const result = await runDoctor(undefined, doctorHost(ghidra, true));

    expect(result.healthy).toBe(false);
    expect(result.checks.find(({ name }) => name === checkName)).toMatchObject({
      ok: false,
      remediation: expect.any(String),
    });
  });

  it("treats unconfigured Ghidra as optional when Hopper is healthy", async () => {
    const result = await runDoctor(undefined, doctorHost(inspection({}), true));

    expect(result.healthy).toBe(true);
    expect(result.checks.find(({ name }) => name === "ghidra")).toMatchObject({
      ok: false,
      classification: "missing_analysis_engine",
    });
  });
});
