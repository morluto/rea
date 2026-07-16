import { describe, expect, it } from "vitest";

import {
  ghidraJavaEnvironment,
  inspectGhidraInstallation,
  SUPPORTED_GHIDRA_JAVA_MAJOR,
  SUPPORTED_GHIDRA_VERSION,
  type GhidraInstallationHost,
  type GhidraJavaObservation,
} from "../src/ghidra/GhidraInstallation.js";

const INSTALL = "/opt/ghidra";
const PROPERTIES = `${INSTALL}/Ghidra/application.properties`;
const HEADLESS = `${INSTALL}/support/analyzeHeadless`;
const WINDOWS_INSTALL = "C:\\tools\\ghidra_12.1.2_PUBLIC";
const WINDOWS_PROPERTIES = `${WINDOWS_INSTALL}\\Ghidra\\application.properties`;
const WINDOWS_HEADLESS = `${WINDOWS_INSTALL}\\support\\analyzeHeadless.bat`;
const JAVA: GhidraJavaObservation = {
  version: "21.0.11",
  major: SUPPORTED_GHIDRA_JAVA_MAJOR,
  home: "/usr/lib/jvm/jdk-21",
  bits: 64,
  jdk: true,
};

const host = (
  overrides: Partial<GhidraInstallationHost> = {},
): GhidraInstallationHost => ({
  readText: (path) =>
    path === PROPERTIES
      ? `application.version=${SUPPORTED_GHIDRA_VERSION}\n`
      : undefined,
  executable: (path) => path === HEADLESS,
  probeJava: () => JAVA,
  ...overrides,
});

describe("Ghidra installation inspection", () => {
  it("clears inherited JVM option injection before probing Java", () => {
    expect(
      ghidraJavaEnvironment(
        "/opt/jdk-21",
        {
          PATH: "/usr/bin",
          _JAVA_OPTIONS: "-Xmx99G",
          JAVA_TOOL_OPTIONS: "-javaagent:/tmp/agent.jar",
          JDK_JAVA_OPTIONS: "-XX:MaxRAMPercentage=99",
          GHIDRA_JAVA_OPTIONS: "-Duser.home=/tmp/unapproved",
        },
        "linux",
      ),
    ).toMatchObject({
      PATH: "/opt/jdk-21/bin:/usr/bin",
      JAVA_HOME: "/opt/jdk-21",
      _JAVA_OPTIONS: "",
      JAVA_TOOL_OPTIONS: "",
      JDK_JAVA_OPTIONS: "",
      GHIDRA_JAVA_OPTIONS: "",
    });
  });

  it("accepts only the exact Linux x64 Ghidra and JDK commitment", () => {
    expect(
      inspectGhidraInstallation(
        { installDir: INSTALL, platform: "linux", architecture: "x64" },
        host(),
      ),
    ).toMatchObject({
      available: true,
      providerVersion: SUPPORTED_GHIDRA_VERSION,
      analyzeHeadlessPath: HEADLESS,
      javaVersion: "21.0.11",
      rejectionCode: null,
    });
  });

  it("accepts the exact Windows x64 batch launcher and JDK commitment", () => {
    const windowsHost: GhidraInstallationHost = {
      platform: "win32",
      architecture: "x64",
      readText: (path) =>
        path === WINDOWS_PROPERTIES
          ? `application.version=${SUPPORTED_GHIDRA_VERSION}\n`
          : undefined,
      executable: (path) => path === WINDOWS_HEADLESS,
      probeJava: (command, environment) => {
        expect(command).toBe("C:\\Java\\jdk-21\\bin\\java.exe");
        expect(environment.PATH).toMatch(/^C:\\Java\\jdk-21\\bin;/u);
        return {
          ...JAVA,
          home: "C:\\Java\\jdk-21",
        };
      },
    };

    expect(
      inspectGhidraInstallation(
        {
          installDir: WINDOWS_INSTALL,
          javaHome: "C:\\Java\\jdk-21",
          platform: "win32",
          architecture: "x64",
        },
        windowsHost,
      ),
    ).toMatchObject({
      available: true,
      platform: "win32",
      architecture: "x64",
      analyzeHeadlessPath: WINDOWS_HEADLESS,
      javaCommand: "C:\\Java\\jdk-21\\bin\\java.exe",
      providerVersion: SUPPORTED_GHIDRA_VERSION,
      rejectionCode: null,
    });
  });

  it.each([
    {
      name: "missing configuration",
      options: { platform: "linux" as const, architecture: "x64" as const },
      override: {},
      failed: "configuration",
      code: "not_configured",
    },
    {
      name: "unsupported platform",
      options: {
        installDir: INSTALL,
        platform: "darwin" as const,
        architecture: "x64" as const,
      },
      override: {},
      failed: "platform",
      code: "unsupported_host",
    },
    {
      name: "unsupported architecture",
      options: {
        installDir: INSTALL,
        platform: "linux" as const,
        architecture: "arm64" as const,
      },
      override: {},
      failed: "architecture",
      code: "unsupported_host",
    },
    {
      name: "bad installation root",
      options: {
        installDir: INSTALL,
        platform: "linux" as const,
        architecture: "x64" as const,
      },
      override: { readText: () => undefined },
      failed: "installation",
      code: "executable_missing",
    },
    {
      name: "wrong Ghidra version",
      options: {
        installDir: INSTALL,
        platform: "linux" as const,
        architecture: "x64" as const,
      },
      override: { readText: () => "application.version=11.4\n" },
      failed: "version",
      code: "unsupported_version",
    },
    {
      name: "missing analyzeHeadless",
      options: {
        installDir: INSTALL,
        platform: "linux" as const,
        architecture: "x64" as const,
      },
      override: { executable: () => false },
      failed: "headless",
      code: "executable_missing",
    },
    {
      name: "missing Java",
      options: {
        installDir: INSTALL,
        platform: "linux" as const,
        architecture: "x64" as const,
      },
      override: { probeJava: () => undefined },
      failed: "java",
      code: "runtime_missing",
    },
    {
      name: "wrong Java",
      options: {
        installDir: INSTALL,
        platform: "linux" as const,
        architecture: "x64" as const,
      },
      override: { probeJava: () => ({ ...JAVA, major: 17, version: "17" }) },
      failed: "java",
      code: "unsupported_version",
    },
    {
      name: "JRE instead of JDK",
      options: {
        installDir: INSTALL,
        platform: "linux" as const,
        architecture: "x64" as const,
      },
      override: { probeJava: () => ({ ...JAVA, jdk: false }) },
      failed: "java",
      code: "unsupported_version",
    },
  ])("distinguishes $name", ({ options, override, failed, code }) => {
    const result = inspectGhidraInstallation(options, host(override));
    expect(result.available).toBe(false);
    expect(result.checks.find(({ ok }) => !ok)).toMatchObject({
      name: failed,
      code,
    });
  });
});
