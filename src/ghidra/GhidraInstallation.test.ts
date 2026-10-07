import { describe, expect, it } from "vitest";

import {
  ghidraJavaEnvironment,
  inspectGhidraInstallation,
  SUPPORTED_GHIDRA_JAVA_MAJOR,
  SUPPORTED_GHIDRA_VERSION,
  type GhidraInstallationHost,
  type GhidraJavaObservation,
} from "./GhidraInstallation.js";

const INSTALL = "/opt/ghidra";
const PROPERTIES = `${INSTALL}/Ghidra/application.properties`;
const HEADLESS = `${INSTALL}/support/analyzeHeadless`;
const MAC_DECOMPILER = `${INSTALL}/Ghidra/Features/Decompiler/os/mac_arm_64/decompile`;
const WINDOWS_INSTALL = "C:\\tools\\ghidra_12.1.4_PUBLIC";
const WINDOWS_PROPERTIES = `${WINDOWS_INSTALL}\\Ghidra\\application.properties`;
const WINDOWS_HEADLESS = `${WINDOWS_INSTALL}\\support\\analyzeHeadless.bat`;
const JAVA: GhidraJavaObservation = {
  version: "21.0.11",
  major: SUPPORTED_GHIDRA_JAVA_MAJOR,
  home: "/usr/lib/jvm/jdk-21",
  bits: 64,
  runtime: "jdk",
};

const host = (
  overrides: Partial<GhidraInstallationHost> = {},
): GhidraInstallationHost => ({
  readText: (path) =>
    path === PROPERTIES
      ? `application.version=${SUPPORTED_GHIDRA_VERSION}\n`
      : undefined,
  executable: (path) => path === HEADLESS || path === MAC_DECOMPILER,
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

  it("accepts the verified Linux x64 Ghidra release and JDK", () => {
    expect(
      inspectGhidraInstallation(
        { installDir: INSTALL, platform: "linux", architecture: "x64" },
        host(),
      ),
    ).toMatchObject({
      status: "available",
      providerVersion: SUPPORTED_GHIDRA_VERSION,
      analyzeHeadlessPath: HEADLESS,
      javaVersion: "21.0.11",
    });
  });

  it.each([
    ["12.1.2", "27", 27],
    ["12.1.2-2.1", "27", 27],
    ["12.1.0", "21.0.2", 21],
    [SUPPORTED_GHIDRA_VERSION, "25.0.1", 25],
  ])(
    "accepts Ghidra %s with JDK %s on the verified release line",
    (providerVersion, javaVersion, major) => {
      const result = inspectGhidraInstallation(
        { installDir: INSTALL, platform: "linux", architecture: "x64" },
        host({
          readText: () =>
            `application.version=${providerVersion}\napplication.java.min=21\napplication.java.max=\n`,
          probeJava: () => ({
            ...JAVA,
            version: javaVersion,
            major,
          }),
        }),
      );
      expect(result.status).toBe("available");
      expect(result).toMatchObject({ providerVersion, javaVersion });
      expect(
        result.checks.find(({ name }) => name === "version"),
      ).toMatchObject({
        status: "passed",
        detail:
          providerVersion === SUPPORTED_GHIDRA_VERSION
            ? SUPPORTED_GHIDRA_VERSION
            : expect.stringContaining("verified build"),
      });
    },
  );

  it.each(["x64", "arm64"] as const)(
    "accepts macOS %s with matching native tools",
    (architecture) => {
      const decompiler = `${INSTALL}/Ghidra/Features/Decompiler/os/${architecture === "arm64" ? "mac_arm_64" : "mac_x86_64"}/decompile`;
      const macHost: GhidraInstallationHost = {
        ...host({
          platform: "darwin",
          architecture,
          executable: (path) => path === HEADLESS || path === decompiler,
        }),
      };
      expect(
        inspectGhidraInstallation(
          { installDir: INSTALL, platform: "darwin", architecture },
          macHost,
        ),
      ).toMatchObject({
        status: "available",
        platform: "darwin",
        architecture,
        nativeDecompilerPath: decompiler,
      });
    },
  );

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
      status: "available",
      platform: "win32",
      architecture: "x64",
      analyzeHeadlessPath: WINDOWS_HEADLESS,
      javaCommand: "C:\\Java\\jdk-21\\bin\\java.exe",
      providerVersion: SUPPORTED_GHIDRA_VERSION,
    });
  });
});

describe("Ghidra installation rejection diagnostics", () => {
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
        platform: "aix" as const,
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
      override: { probeJava: () => ({ ...JAVA, runtime: "jre" as const }) },
      failed: "java",
      code: "unsupported_version",
    },
  ])("distinguishes $name", ({ options, override, failed, code }) => {
    const result = inspectGhidraInstallation(options, host(override));
    expect(result.status).toBe("unavailable");
    expect(
      result.checks.find(({ status }) => status === "failed"),
    ).toMatchObject({
      name: failed,
      code,
    });
  });
});

describe("Ghidra release line and JDK bounds", () => {
  it.each([
    {
      name: "JDK above the installation maximum",
      readText: () =>
        "application.version=12.1.4\napplication.java.min=21\napplication.java.max=25\n",
      probeJava: () => ({ ...JAVA, major: 27, version: "27" }),
      failed: "java",
      code: "unsupported_version",
    },
    {
      name: "unreadable Java minimum",
      readText: () =>
        "application.version=12.1.4\napplication.java.min=latest\n",
      probeJava: () => JAVA,
      failed: "java",
      code: "version_unresolved",
    },
    {
      name: "unparseable Ghidra version",
      readText: () => "application.version=latest\n",
      probeJava: () => JAVA,
      failed: "version",
      code: "version_unresolved",
    },
    {
      name: "different Ghidra line",
      readText: () => "application.version=12.2.0\n",
      probeJava: () => JAVA,
      failed: "version",
      code: "unsupported_version",
    },
  ])("distinguishes $name", ({ readText, probeJava, failed, code }) => {
    const result = inspectGhidraInstallation(
      { installDir: INSTALL, platform: "linux", architecture: "x64" },
      host({ readText, probeJava }),
    );
    expect(result.status).toBe("unavailable");
    expect(
      result.checks.find(({ status }) => status === "failed"),
    ).toMatchObject({ name: failed, code });
  });

  it("names the accepted Ghidra line and JDK range in failure remediation", () => {
    const result = inspectGhidraInstallation(
      {
        installDir: INSTALL,
        javaHome: "/usr/lib/jvm/java-17-openjdk",
        platform: "linux",
        architecture: "x64",
      },
      host({
        readText: () =>
          "application.version=12.0.4\napplication.java.min=21\napplication.java.max=\n",
        probeJava: () => ({ ...JAVA, major: 17, version: "17.0.20.1" }),
      }),
    );
    expect(result.status).toBe("unavailable");
    if (result.status !== "unavailable") return;
    expect(result.rejection.reason).toContain("12.1.x");
    expect(result.rejection.reason).toContain(SUPPORTED_GHIDRA_VERSION);
    expect(result.checks.find(({ name }) => name === "java")).toMatchObject({
      status: "failed",
      remediation: expect.stringContaining("JDK 21 or newer"),
    });
  });

  it("honors an installation that declares a lower Java minimum", () => {
    expect(
      inspectGhidraInstallation(
        { installDir: INSTALL, platform: "linux", architecture: "x64" },
        host({
          readText: () =>
            `application.version=${SUPPORTED_GHIDRA_VERSION}\napplication.java.min=17\n`,
          probeJava: () => ({ ...JAVA, major: 17, version: "17.0.20.1" }),
        }),
      ),
    ).toMatchObject({ status: "available", javaVersion: "17.0.20.1" });
  });
});
