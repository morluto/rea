import { afterEach, describe, expect, it, vi } from "vitest";

import { elf, fat, thinMach } from "../domain/binaryTarget.fixture.js";
import { projectGhidraDoctorInspection } from "./GhidraDoctor.js";
import {
  ghidraJavaEnvironment,
  inspectGhidraInstallation,
  type GhidraExecutableHeaderProbe,
  type GhidraInstallationHost,
  type GhidraJavaObservation,
} from "./GhidraInstallation.js";
import {
  SUPPORTED_GHIDRA_JAVA_MAJOR,
  SUPPORTED_GHIDRA_VERSION,
  ghidraApplicationProperties,
  ghidraJavaRequirement,
} from "./GhidraInstallationPolicy.js";

const INSTALL = "/opt/ghidra";
const PROPERTIES = `${INSTALL}/Ghidra/application.properties`;
const HEADLESS = `${INSTALL}/support/analyzeHeadless`;
const LINUX_DECOMPILER = `${INSTALL}/Ghidra/Features/Decompiler/os/linux_x86_64/decompile`;
const MAC_DECOMPILER = `${INSTALL}/Ghidra/Features/Decompiler/os/mac_arm_64/decompile`;
const WINDOWS_INSTALL = "C:\\tools\\ghidra_12.1.4_PUBLIC";
const WINDOWS_PROPERTIES = `${WINDOWS_INSTALL}\\Ghidra\\application.properties`;
const WINDOWS_HEADLESS = `${WINDOWS_INSTALL}\\support\\analyzeHeadless.bat`;
const WINDOWS_DECOMPILER = `${WINDOWS_INSTALL}\\Ghidra\\Features\\Decompiler\\os\\win_x86_64\\decompile.exe`;

const headerProbe = (bytes: Buffer): GhidraExecutableHeaderProbe => ({
  bytes,
  size: bytes.length,
});

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
      ? `application.version=${SUPPORTED_GHIDRA_VERSION}\napplication.java.min=${String(SUPPORTED_GHIDRA_JAVA_MAJOR)}\n`
      : undefined,
  executable: (path) =>
    path === HEADLESS || path === MAC_DECOMPILER || path === LINUX_DECOMPILER,
  probeJava: () => JAVA,
  ...overrides,
});

afterEach(() => {
  vi.unstubAllEnvs();
});

it("probes the selected Java environment without reading conflicting ambient settings", () => {
  vi.stubEnv("REA_GHIDRA_CONTEXT", "ambient");
  vi.stubEnv("REA_GHIDRA_AMBIENT", "ambient-only");
  const inspection = inspectGhidraInstallation(
    {
      environment: { REA_GHIDRA_CONTEXT: "selected", PATH: "/selected-bin" },
      installDir: INSTALL,
      platform: "linux",
      architecture: "x64",
    },
    host({
      probeJava: (_command, environment) =>
        environment.REA_GHIDRA_CONTEXT === "selected" &&
        environment.REA_GHIDRA_AMBIENT === undefined &&
        environment.PATH === "/selected-bin"
          ? JAVA
          : undefined,
    }),
  );
  expect(inspection.status).toBe("available");
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
        {
          environment: {},
          installDir: INSTALL,
          platform: "linux",
          architecture: "x64",
        },
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
        {
          environment: {},
          installDir: INSTALL,
          platform: "linux",
          architecture: "x64",
        },
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

  it.each([
    ["darwin", "x64", "mac_x86_64"],
    ["darwin", "arm64", "mac_arm_64"],
    ["linux", "arm64", "linux_arm_64"],
  ] as const)(
    "accepts %s/%s with the matching distribution or locally built native tool",
    (platform, architecture, nativeDirectory) => {
      for (const location of ["os", "build/os"]) {
        const decompiler = `${INSTALL}/Ghidra/Features/Decompiler/${location}/${nativeDirectory}/decompile`;
        expect(
          inspectGhidraInstallation(
            { environment: {}, installDir: INSTALL, platform, architecture },
            host({
              executable: (path) => path === HEADLESS || path === decompiler,
            }),
          ),
        ).toMatchObject({
          status: "available",
          platform,
          architecture,
          nativeDecompilerPath: decompiler,
        });
      }
    },
  );

  it("accepts the exact Windows x64 batch launcher and JDK commitment", () => {
    const windowsHost: GhidraInstallationHost = {
      platform: "win32",
      architecture: "x64",
      readText: (path) =>
        path === WINDOWS_PROPERTIES
          ? `application.version=${SUPPORTED_GHIDRA_VERSION}\napplication.java.min=21\n`
          : undefined,
      executable: (path) =>
        path === WINDOWS_HEADLESS || path === WINDOWS_DECOMPILER,
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
          environment: {},
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
        architecture: "arm" as const,
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
      override: {
        readText: () => "application.version=11.4\napplication.java.min=21\n",
      },
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
      name: "only a foreign-architecture decompiler on Linux arm64",
      options: {
        installDir: INSTALL,
        platform: "linux" as const,
        architecture: "arm64" as const,
      },
      override: {},
      failed: "native_decompiler",
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
    const result = inspectGhidraInstallation(
      { ...options, environment: {} },
      host(override),
    );
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
  it("uses Java Properties last-key, delimiter, escape, and continuation rules", () => {
    const properties = ghidraApplicationProperties(
      [
        "application.version=11.4",
        "# comment ending with a slash " + "\\",
        "application.\\u0076ersion : 12.\\",
        "  1.\\u0034",
        "! another comment " + "\\",
        "application.java.\\u006din\t21",
        "application.java.max=",
      ].join("\n"),
    );
    expect(properties).toEqual({
      providerVersion: "12.1.4",
      javaMinimum: { status: "major", major: 21 },
      javaMaximum: { status: "absent" },
      parseError: null,
    });
    expect(
      ghidraApplicationProperties("application.version=12.1.4").javaMinimum,
    ).toEqual({
      status: "absent",
    });
    expect(
      ghidraApplicationProperties(
        "application.version=12.1.4\napplication.java.min=\n",
      ).javaMinimum,
    ).toEqual({ status: "unresolved", raw: "" });
    expect(
      ghidraApplicationProperties("application.version=12.1.4\\")
        .providerVersion,
    ).toBe("12.1.4");
    expect(
      ghidraApplicationProperties("application.version=12.\\\n #.1")
        .providerVersion,
    ).toBe("12.#.1");
    expect(
      ghidraApplicationProperties(
        "application.version=12.\\\n\napplication.version=12.1.4",
      ).providerVersion,
    ).toBe("12.1.4");
  });

  it("matches Ghidra integer Java bounds and zero maximum semantics", () => {
    const properties = ghidraApplicationProperties(
      "application.java.min=21.0\napplication.java.max=0\n",
    );
    expect(properties.javaMinimum).toEqual({
      status: "unresolved",
      raw: "21.0",
    });
    expect(properties.javaMaximum).toEqual({ status: "absent" });
    expect(
      ghidraApplicationProperties("application.java.max=+0").javaMaximum,
    ).toEqual({
      status: "absent",
    });
    expect(
      ghidraApplicationProperties("application.java.max=+０").javaMaximum,
    ).toEqual({ status: "absent" });
    expect(
      ghidraApplicationProperties("application.java.min=+21").javaMinimum,
    ).toEqual({
      status: "major",
      major: 21,
    });
    expect(
      ghidraApplicationProperties("application.java.min=٢١").javaMinimum,
    ).toEqual({
      status: "major",
      major: 21,
    });
    expect(
      ghidraApplicationProperties("application.java.min=２１").javaMinimum,
    ).toEqual({
      status: "major",
      major: 21,
    });
    expect(
      ghidraApplicationProperties("application.java.max=＋０").javaMaximum,
    ).toEqual({
      status: "unresolved",
      raw: "＋０",
    });
    expect(
      ghidraApplicationProperties("application.java.min=②").javaMinimum,
    ).toEqual({
      status: "unresolved",
      raw: "②",
    });
    expect(
      ghidraApplicationProperties("application.java.min=2147483648")
        .javaMinimum,
    ).toEqual({ status: "unresolved", raw: "2147483648" });
  });

  it("keeps an unavailable properties file unresolved for Java admission", () => {
    expect(ghidraJavaRequirement(undefined).unresolved).toBe(
      "application.properties is unavailable",
    );
  });

  it("preserves property value trailing whitespace instead of normalizing it", () => {
    const properties = ghidraApplicationProperties(
      "application.version=12.1.4 \napplication.java.min=21 \n",
    );
    expect(properties.providerVersion).toBe("12.1.4 ");
    expect(properties.javaMinimum).toEqual({
      status: "unresolved",
      raw: "21 ",
    });
    expect(properties.parseError).toBeNull();
  });
});

describe("Ghidra malformed property admission", () => {
  it("fails installation and doctor admission closed on malformed Unicode escapes", () => {
    const result = inspectGhidraInstallation(
      {
        environment: {},
        installDir: INSTALL,
        platform: "linux",
        architecture: "x64",
      },
      host({
        readText: () =>
          "application.version=12.1.4\nbroken=\\u12G4\napplication.java.min=17\n",
      }),
    );
    expect(result.status).toBe("unavailable");
    expect(result.providerVersion).toBeNull();
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "version",
          status: "failed",
          code: "version_unresolved",
          detail: expect.stringContaining("Malformed Unicode escape"),
        }),
        expect.objectContaining({
          name: "java",
          status: "failed",
          code: "version_unresolved",
          remediation: expect.stringContaining(
            "application.properties parse failed",
          ),
        }),
      ]),
    );
    expect(projectGhidraDoctorInspection(result)).toMatchObject({
      available: false,
      registrationEnvironment: {},
      checks: expect.arrayContaining([
        expect.objectContaining({ name: "version", ok: false }),
        expect.objectContaining({ name: "java", ok: false }),
      ]),
    });
  });
});

describe("Ghidra installation version admission", () => {
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
      name: "missing Java minimum",
      readText: () => "application.version=12.1.4\n",
      probeJava: () => JAVA,
      failed: "java",
      code: "version_unresolved",
    },
    {
      name: "unparseable Ghidra version",
      readText: () => "application.version=latest\napplication.java.min=21\n",
      probeJava: () => JAVA,
      failed: "version",
      code: "version_unresolved",
    },
    {
      name: "different Ghidra line",
      readText: () => "application.version=12.2.0\napplication.java.min=21\n",
      probeJava: () => JAVA,
      failed: "version",
      code: "unsupported_version",
    },
  ])("distinguishes $name", ({ readText, probeJava, failed, code }) => {
    const result = inspectGhidraInstallation(
      {
        environment: {},
        installDir: INSTALL,
        platform: "linux",
        architecture: "x64",
      },
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
        environment: {},
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

  it("accepts a lower Java minimum declared by the installation", () => {
    expect(
      inspectGhidraInstallation(
        {
          environment: {},
          installDir: INSTALL,
          platform: "linux",
          architecture: "x64",
        },
        host({
          readText: () =>
            `application.version=${SUPPORTED_GHIDRA_VERSION}\napplication.java.min=17\n`,
          probeJava: () => ({ ...JAVA, major: 17, version: "17.0.20.1" }),
        }),
      ),
    ).toMatchObject({ status: "available", javaVersion: "17.0.20.1" });
  });
});

describe("Ghidra configuration paths", () => {
  it.each([
    [{ installDir: "./ghidra" }, "GHIDRA_INSTALL_DIR must be absolute"],
    [{ installDir: INSTALL, javaHome: "./jdk" }, "JAVA_HOME must be absolute"],
    [
      { installDir: "ghidra", javaHome: "jdk" },
      "GHIDRA_INSTALL_DIR and JAVA_HOME must be absolute",
    ],
  ])(
    "rejects relative paths that REA's configuration parser rejects (%o)",
    (paths, detail) => {
      const result = inspectGhidraInstallation(
        { environment: {}, ...paths, platform: "linux", architecture: "x64" },
        host(),
      );
      expect(result).toMatchObject({
        status: "unavailable",
        rejection: {
          code: "not_configured",
          reason: expect.stringContaining("reject relative paths"),
        },
      });
      expect(result.checks).toContainEqual(
        expect.objectContaining({ name: "configuration", detail }),
      );
      // Setup registers only an available inspection's environment.
      expect(projectGhidraDoctorInspection(result)).toMatchObject({
        available: false,
        registrationEnvironment: {},
      });
    },
  );

  it.each([
    ["linux", "./jdk"],
    ["linux", ""],
    ["win32", "jdk"],
  ] as const)(
    "does not run Java from a relative JAVA_HOME (%s %o)",
    (platform, javaHome) => {
      const probed: string[] = [];
      const result = inspectGhidraInstallation(
        {
          environment: {},
          installDir: platform === "win32" ? WINDOWS_INSTALL : INSTALL,
          javaHome,
          platform,
          architecture: "x64",
        },
        host({
          probeJava: (command) => {
            probed.push(command);
            return JAVA;
          },
        }),
      );
      expect(probed).toEqual([]);
      expect(result).toMatchObject({
        status: "unavailable",
        rejection: { code: "not_configured" },
      });
    },
  );

  it("judges absolute paths by the inspected platform", () => {
    const result = inspectGhidraInstallation(
      {
        environment: {},
        installDir: "C:\\ghidra",
        platform: "win32",
        architecture: "x64",
      },
      host(),
    );
    expect(result.checks).toContainEqual(
      expect.objectContaining({ name: "configuration", status: "passed" }),
    );
  });
});

describe("Ghidra FAT native decompiler admission", () => {
  it.each([
    {
      name: "foreign-only FAT",
      bytes: fat([0x01000007]),
      status: "unavailable",
      detail: "requires mach-o arm64",
    },
    {
      name: "matching universal FAT",
      bytes: fat([0x01000007, 0x0100000c]),
      status: "available",
      detail: "matches darwin/arm64",
    },
    {
      name: "truncated FAT table",
      bytes: fat([0x01000007], 2),
      status: "available",
      detail: "could not be established",
    },
  ])("distinguishes $name", ({ bytes, status, detail }) => {
    const result = inspectGhidraInstallation(
      {
        environment: {},
        installDir: INSTALL,
        platform: "darwin",
        architecture: "arm64",
      },
      host({ executableHeader: () => headerProbe(bytes) }),
    );
    expect(result.status).toBe(status);
    expect(
      result.checks.find(({ name }) => name === "native_decompiler")?.detail,
    ).toContain(detail);
  });

  it("keeps a truncated host slice unknown despite a readable foreign slice", () => {
    const bytes = fat([0x01000007, 0x0100000c]);
    bytes.writeUInt32BE(bytes.length + 1, 8 + 20 + 12);
    const result = inspectGhidraInstallation(
      {
        environment: {},
        installDir: INSTALL,
        platform: "darwin",
        architecture: "arm64",
      },
      host({ executableHeader: () => headerProbe(bytes) }),
    );
    expect(result.status).toBe("available");
    expect(
      result.checks.find(({ name }) => name === "native_decompiler")?.detail,
    ).toContain("could not be established");
  });
});

describe("Ghidra native decompiler admission", () => {
  it.each([
    {
      name: "a MIPS decompiler at the Linux x64 path",
      options: {
        environment: {},
        installDir: INSTALL,
        platform: "linux" as const,
        architecture: "x64" as const,
      },
      executableHeader: (path: string) =>
        path === LINUX_DECOMPILER ? headerProbe(elf(1, 1, 8)) : undefined,
    },
    {
      name: "a Linux x86-64 decompiler at the macOS arm64 path",
      options: {
        environment: {},
        installDir: INSTALL,
        platform: "darwin" as const,
        architecture: "arm64" as const,
      },
      executableHeader: (path: string) =>
        path === MAC_DECOMPILER ? headerProbe(elf(2, 1, 62)) : undefined,
    },
    {
      name: "a macOS arm64 decompiler at the Linux x64 path",
      options: {
        environment: {},
        installDir: INSTALL,
        platform: "linux" as const,
        architecture: "x64" as const,
      },
      executableHeader: (path: string) =>
        path === LINUX_DECOMPILER
          ? headerProbe(thinMach(0xcffaedfe, 0x0100000c))
          : undefined,
    },
  ])("distinguishes $name", ({ options, executableHeader }) => {
    const result = inspectGhidraInstallation(
      options,
      host({ executableHeader }),
    );
    expect(result.status).toBe("unavailable");
    expect(
      result.checks.find(({ status }) => status === "failed"),
    ).toMatchObject({ name: "native_decompiler", code: "executable_missing" });
  });

  it("explains an accepted decompiler by its header, not only its path", () => {
    const result = inspectGhidraInstallation(
      {
        environment: {},
        installDir: INSTALL,
        platform: "linux",
        architecture: "x64",
      },
      host({
        executableHeader: (path: string) =>
          path === LINUX_DECOMPILER ? headerProbe(elf(2, 1, 62)) : undefined,
      }),
    );
    expect(result.status).toBe("available");
    if (result.status !== "available") return;
    expect(
      result.checks.find(({ name }) => name === "native_decompiler"),
    ).toMatchObject({
      status: "passed",
      detail: `${LINUX_DECOMPILER} reports elf x86_64, which matches linux/x64`,
    });
  });

  it("keeps an unreadable header unknown instead of failing the install", () => {
    const result = inspectGhidraInstallation(
      {
        environment: {},
        installDir: INSTALL,
        platform: "linux",
        architecture: "x64",
      },
      host({ executableHeader: () => undefined }),
    );
    expect(result.status).toBe("available");
    if (result.status !== "available") return;
    expect(
      result.checks.find(({ name }) => name === "native_decompiler"),
    ).toMatchObject({
      status: "passed",
      detail: expect.stringContaining("could not be established"),
    });
  });

  it("accepts a one-slice universal-format Darwin native decompiler", () => {
    const bytes = fat([0x0100000c]);
    const result = inspectGhidraInstallation(
      {
        environment: {},
        installDir: INSTALL,
        platform: "darwin",
        architecture: "arm64",
      },
      host({
        executableHeader: (path: string) =>
          path === MAC_DECOMPILER ? headerProbe(bytes) : undefined,
      }),
    );
    expect(result.status).toBe("available");
    if (result.status !== "available") return;
    expect(
      result.checks.find(({ name }) => name === "native_decompiler"),
    ).toMatchObject({
      status: "passed",
      detail: `${MAC_DECOMPILER} reports mach-o-universal arm64, which matches darwin/arm64`,
    });
  });

  it("names the observed and the required executable in the failure", () => {
    const result = inspectGhidraInstallation(
      {
        environment: {},
        installDir: INSTALL,
        platform: "darwin",
        architecture: "arm64",
      },
      host({
        executableHeader: (path: string) =>
          path === MAC_DECOMPILER ? headerProbe(elf(2, 1, 62)) : undefined,
      }),
    );
    expect(result.status).toBe("unavailable");
    if (result.status !== "unavailable") return;
    expect(
      result.checks.find(({ name }) => name === "native_decompiler"),
    ).toMatchObject({
      status: "failed",
      detail: expect.stringMatching(
        /reports elf x86_64, but darwin\/arm64 requires mach-o arm64/u,
      ),
      remediation: expect.stringContaining("os/mac_arm_64/decompile"),
    });
  });
});
