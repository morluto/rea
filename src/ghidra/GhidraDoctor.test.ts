import { createInspectionResources } from "../../tests/fixtures/inspectionResources.js";

import { missingJavaProbe } from "./GhidraInstallation.fixture.js";
import { err, ok as javaProbeOk } from "../domain/result.js";
import type {
  GhidraJavaObservation,
  GhidraJavaProbeFailure,
} from "./GhidraJavaProbe.js";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";

import { runDoctor, type DoctorHost } from "../application/Doctor.js";
import { createDoctorHostFixture } from "../application/Doctor.fixture.js";
import { providerRegistrationEnvironment } from "../application/SetupRegistrationEnvironment.js";
import * as nativeLoader from "../windows/WindowsNativeLoader.js";
import {
  inspectGhidraInstallation,
  type GhidraInstallationHost,
  type GhidraInstallationInspection,
} from "./GhidraInstallation.js";
import {
  inspectSystemGhidraProvider,
  projectGhidraDoctorInspection,
} from "./GhidraDoctor.js";
import { GhidraProvider } from "./GhidraProvider.js";
import {
  SUPPORTED_GHIDRA_JAVA_MAJOR,
  SUPPORTED_GHIDRA_VERSION,
} from "./GhidraReleasePolicy.js";
import { parseConfig } from "../config/parseConfig.js";
import { silentLogger } from "../logger.js";

let inspectionResources = createInspectionResources();
afterEach(async () => {
  await inspectionResources.close();
  inspectionResources = createInspectionResources();
});

const INSTALL = "/opt/ghidra_12.2_PUBLIC";
const installationHost = (
  overrides: Partial<GhidraInstallationHost> = {},
  platform: NodeJS.Platform = "linux",
): GhidraInstallationHost => ({
  readText: () =>
    `application.version=${SUPPORTED_GHIDRA_VERSION}\napplication.java.min=${String(SUPPORTED_GHIDRA_JAVA_MAJOR)}\n`,
  executable: () => true,
  probeJava: () =>
    javaProbeOk<GhidraJavaObservation>({
      osArch: "amd64",
      osName: platform === "win32" ? "Windows 11" : "Linux",
      version: `${String(SUPPORTED_GHIDRA_JAVA_MAJOR)}.0.1`,
      major: SUPPORTED_GHIDRA_JAVA_MAJOR,
      home: `/usr/lib/jvm/jdk-${String(SUPPORTED_GHIDRA_JAVA_MAJOR)}`,
      bits: 64,
      runtime: "jdk",
    }),
  ...overrides,
});

const inspection = async (
  options: {
    readonly installDir?: string;
    readonly architecture?: NodeJS.Architecture;
    readonly platform?: NodeJS.Platform;
  } = { installDir: INSTALL },
  overrides: Partial<GhidraInstallationHost> = {},
): Promise<GhidraInstallationInspection> =>
  await inspectGhidraInstallation(
    {
      resourceOwner: inspectionResources.owner,
      environment: {},
      platform: options.platform ?? "linux",
      architecture: options.architecture ?? "x64",
      ...(options.installDir === undefined
        ? {}
        : { installDir: options.installDir }),
    },
    installationHost(overrides, options.platform ?? "linux"),
  );

const doctorHost = (
  ghidra: GhidraInstallationInspection,
  hopperAvailable = false,
): DoctorHost =>
  createDoctorHostFixture({
    platform: "linux",
    architecture: "x64",
    macosVersion: () => Promise.resolve(undefined),
    linuxDistribution: () =>
      Promise.resolve({
        id: "ubuntu",
        versionId: "24.04",
        packageFamily: "deb",
        hopperSetupSupported: true,
      }),
    executable: (path) =>
      Promise.resolve(hopperAvailable && path.includes("Hopper")),
    linuxDemoRuntimeCheck: () =>
      Promise.resolve({
        name: "hopper-demo-runtime",
        ok: true,
        classification: "healthy",
      }),
    brewHopperPath: () => Promise.resolve(undefined),
    manualHopperPaths: () => Promise.resolve([]),
    providerInspections: () =>
      Promise.resolve([projectGhidraDoctorInspection(ghidra)]),
  });

describe("Ghidra doctor integration", async () => {
  it("accepts a valid BYO Ghidra engine when Hopper is absent", async () => {
    const result = await runDoctor(undefined, doctorHost(await inspection()));

    expect(result.healthy).toBe(true);
    expect(result.hopperPath).toBeUndefined();
    expect(result.providerInspections?.[0]).toMatchObject({
      id: "ghidra",
      available: true,
      providerVersion: SUPPORTED_GHIDRA_VERSION,
      registrationEnvironment: {
        GHIDRA_INSTALL_DIR: INSTALL,
        JAVA_HOME: `/usr/lib/jvm/jdk-${String(SUPPORTED_GHIDRA_JAVA_MAJOR)}`,
      },
    });
    expect(
      result.checks.find(({ name }) => name === "ghidra-java"),
    ).toMatchObject({
      ok: true,
    });
  });

  it.each([
    [
      "bad installation",
      await inspection({ installDir: INSTALL }, { readText: () => undefined }),
      "ghidra-installation",
    ],
    [
      "wrong version",
      await inspection(
        { installDir: INSTALL },
        {
          readText: () => "application.version=11.4\napplication.java.min=21\n",
        },
      ),
      "ghidra-version",
    ],
    [
      "missing analyzeHeadless",
      await inspection({ installDir: INSTALL }, { executable: () => false }),
      "ghidra-headless",
    ],
    [
      "wrong Java",
      await inspection(
        { installDir: INSTALL },
        {
          probeJava: () =>
            javaProbeOk<GhidraJavaObservation>({
              osArch: "amd64",
              osName: "Linux",
              version: "17.0.12",
              major: 17,
              home: "/usr/lib/jvm/jdk-17",
              bits: 64,
              runtime: "jdk",
            }),
        },
      ),
      "ghidra-java",
    ],
    [
      "missing Java minimum",
      await inspection(
        { installDir: INSTALL },
        { readText: () => `application.version=${SUPPORTED_GHIDRA_VERSION}\n` },
      ),
      "ghidra-java",
    ],
    [
      "unsupported architecture",
      await inspection({ installDir: INSTALL, architecture: "arm" }),
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
    const result = await runDoctor(
      undefined,
      doctorHost(await inspection({}), true),
    );

    expect(result.healthy).toBe(true);
    expect(result.checks.find(({ name }) => name === "ghidra")).toMatchObject({
      ok: false,
      classification: "missing_analysis_engine",
    });
  });
});

const PASSING_GHIDRA_CHECKS = [
  "configuration",
  "platform",
  "architecture",
  "installation",
  "version",
  "headless",
  "native_decompiler",
  "java",
] as const;

const unavailableJavaProbe = err<GhidraJavaProbeFailure>({
  _tag: "GhidraJavaProbeFailure",
  code: "runtime_unavailable",
  detail: "Java command could not be executed",
});

const javaObservation = (
  osArch: string,
  osName: string,
): GhidraJavaObservation => ({
  osArch,
  osName,
  version: `${String(SUPPORTED_GHIDRA_JAVA_MAJOR)}.0.1`,
  major: SUPPORTED_GHIDRA_JAVA_MAJOR,
  home: `/usr/lib/jvm/jdk-${String(SUPPORTED_GHIDRA_JAVA_MAJOR)}`,
  bits: 64,
  runtime: "jdk",
});

const classifiedChecks = (
  checks: readonly {
    readonly name: string;
    readonly ok: boolean;
    readonly code: string | null;
    readonly remediation: string | null;
    readonly classification: string;
  }[],
) =>
  checks.map(({ name, ok, code, remediation, classification }) => ({
    name,
    ok,
    code,
    remediation,
    classification,
  }));

const failureClassificationCases = async () =>
  [
    [
      "an unsupported platform",
      await inspection({ installDir: INSTALL, platform: "freebsd" }),
      {
        platform: "unsupported_host",
        architecture: "unsupported_host",
        native_decompiler: "config_drift",
      },
    ],
    [
      "an unsupported architecture",
      await inspection({ installDir: INSTALL, architecture: "arm" }),
      {
        architecture: "unsupported_host",
        native_decompiler: "config_drift",
      },
    ],
    [
      "a missing Java runtime",
      await inspection(
        { installDir: INSTALL },
        { probeJava: () => missingJavaProbe },
      ),
      { java: "missing_dependency" },
    ],
    [
      "an unavailable Java runtime",
      await inspection(
        { installDir: INSTALL },
        { probeJava: () => unavailableJavaProbe },
      ),
      { java: "runtime_failure" },
    ],
    [
      "a Java release outside the declared range",
      await inspection(
        { installDir: INSTALL },
        {
          probeJava: () =>
            javaProbeOk<GhidraJavaObservation>({
              ...javaObservation("amd64", "Linux"),
              version: "17.0.12",
              major: 17,
              home: "/usr/lib/jvm/jdk-17",
            }),
        },
      ),
      { java: "config_drift" },
    ],
    [
      "an unreadable Java requirement",
      await inspection(
        { installDir: INSTALL },
        {
          readText: () => `application.version=${SUPPORTED_GHIDRA_VERSION}\n`,
        },
      ),
      { java: "config_drift" },
    ],
    [
      "a rejected Ghidra release",
      await inspection(
        { installDir: INSTALL },
        {
          readText: () => "application.version=11.4\napplication.java.min=21\n",
        },
      ),
      { version: "config_drift" },
    ],
    [
      "a missing headless launcher",
      await inspection({ installDir: INSTALL }, { executable: () => false }),
      { headless: "config_drift", native_decompiler: "config_drift" },
    ],
    [
      "an installation without application properties",
      await inspection({ installDir: INSTALL }, { readText: () => undefined }),
      { installation: "config_drift", java: "config_drift" },
    ],
    [
      "a relative installation path",
      await inspection({ installDir: "ghidra" }),
      { configuration: "config_drift" },
    ],
    [
      "no installation",
      await inspection({}),
      { configuration: "missing_analysis_engine" },
    ],
  ] as const;

const expectFailureClassifications = (
  ghidra: GhidraInstallationInspection,
  failed: Readonly<Record<string, string>>,
) => {
  const projected = projectGhidraDoctorInspection(ghidra);
  const observed = Object.fromEntries(
    projected.checks.map((check) => [
      check.name,
      check.ok
        ? (["healthy", true, check.code, check.remediation] as const)
        : ([
            check.classification,
            false,
            check.code !== null,
            typeof check.remediation === "string",
          ] as const),
    ]),
  );
  const expected = Object.fromEntries(
    projected.checks.map((check) => {
      const failure = failed[check.name];
      return [
        check.name,
        failure === undefined
          ? (["healthy", true, null, null] as const)
          : ([failure, false, true, true] as const),
      ];
    }),
  );
  expect(observed).toEqual(expected);
  expect(
    projected.checks
      .filter((check) => !check.ok)
      .map(({ name }) => name)
      .sort(),
  ).toEqual(Object.keys(failed).sort());
};

describe("Ghidra provider inspection classification", async () => {
  it.each([
    {
      host: "linux x64",
      platform: "linux" as const,
      architecture: "x64" as const,
      osArch: "amd64",
      osName: "Linux",
    },
    {
      host: "darwin arm64",
      platform: "darwin" as const,
      architecture: "arm64" as const,
      osArch: "aarch64",
      osName: "Mac OS X",
    },
  ])(
    "classifies every passing installation check as healthy on $host",
    async ({ platform, architecture, osArch, osName }) => {
      const projected = projectGhidraDoctorInspection(
        await inspection(
          { installDir: INSTALL, platform, architecture },
          {
            probeJava: () => javaProbeOk(javaObservation(osArch, osName)),
          },
        ),
      );

      expect(projected.available).toBe(true);
      expect(classifiedChecks(projected.checks)).toEqual(
        PASSING_GHIDRA_CHECKS.map((name) => ({
          name,
          ok: true,
          code: null,
          remediation: null,
          classification: "healthy",
        })),
      );
    },
  );

  it("reports the same healthy classification on the doctor checks", async () => {
    const result = await runDoctor(undefined, doctorHost(await inspection()));
    const providerChecks = result.providerInspections?.[0]?.checks ?? [];

    expect(classifiedChecks(providerChecks)).toEqual(
      PASSING_GHIDRA_CHECKS.map((name) => ({
        name,
        ok: true,
        code: null,
        remediation: null,
        classification: "healthy",
      })),
    );
    expect(
      PASSING_GHIDRA_CHECKS.map((name) =>
        result.checks.find(
          ({ name: checkName }) =>
            checkName ===
            (name === "configuration" ? "ghidra" : `ghidra-${name}`),
        ),
      ),
    ).toEqual(
      PASSING_GHIDRA_CHECKS.map((name) =>
        expect.objectContaining({
          name: name === "configuration" ? "ghidra" : `ghidra-${name}`,
          ok: true,
          classification: "healthy",
        }),
      ),
    );
  });

  it.each(await failureClassificationCases())(
    "keeps failure classifications for %s",
    (_label, ghidra, failed) => {
      expectFailureClassifications(ghidra, failed);
    },
  );
});

describe("Windows Ghidra doctor authority", () => {
  beforeEach(() => {
    vi.spyOn(nativeLoader, "systemWindowsNativeAuthority").mockReturnValue({
      available: false,
      failureStage: "artifact",
      reason: "Authored native artifact unavailable diagnostic",
    });
  });
  afterEach(() => vi.restoreAllMocks());
  it("distinguishes a valid Windows installation from unavailable native authority", async () => {
    const ghidra = await inspection({
      installDir: "C:\\tools\\ghidra_12.2_PUBLIC",
      platform: "win32",
    });
    const result = await runDoctor(undefined, {
      ...doctorHost(ghidra),
      platform: "win32",
      architecture: "x64",
      linuxDistribution: () => Promise.resolve(undefined),
    });

    expect(result.healthy).toBe(false);
    expect(result.providerInspections?.[0]).toMatchObject({
      available: false,
      providerVersion: SUPPORTED_GHIDRA_VERSION,
      registrationEnvironment: {
        GHIDRA_INSTALL_DIR: "C:\\tools\\ghidra_12.2_PUBLIC",
      },
    });
    expect(
      providerRegistrationEnvironment(result.providerInspections ?? []),
    ).toMatchObject({
      GHIDRA_INSTALL_DIR: "C:\\tools\\ghidra_12.2_PUBLIC",
    });
    expect(result.checks.find(({ name }) => name === "host")).toMatchObject({
      ok: true,
      detail: "win32 x64",
    });
    expect(result.checks.find(({ name }) => name === "ghidra")).toMatchObject({
      ok: true,
    });
    expect(
      result.checks.find(({ name }) => name === "ghidra-java"),
    ).toMatchObject({ ok: true });
    expect(
      result.checks.find(({ name }) => name === "ghidra-native_authority"),
    ).toMatchObject({
      ok: false,
      classification: "missing_dependency",
      detail: "Authored native artifact unavailable diagnostic",
      remediation: expect.stringContaining(
        "matching published Windows x64 REA package",
      ),
    });
  });

  it("reports the verified NTFS and ReFS native authority boundary", async () => {
    vi.mocked(nativeLoader.systemWindowsNativeAuthority).mockReturnValue({
      available: true,
      authority: {
        inspection: {
          abiVersion: 1,
          nodeApiVersion: 8,
          architecture: "x64",
          filesystem: {
            requestedPath: "D:\\probe",
            finalPath: "D:\\probe",
            filesystem: "ReFS",
            volumeSerial: "0".repeat(16),
            fileId: "0".repeat(32),
            size: 0,
            directory: true,
          },
          privateDacl: true,
          privateBridgeDescriptorAccess: true,
          atomicJobAssignment: true,
          killOnOwnerClose: true,
        },
        call: () => {
          throw new Error("Unexpected native call");
        },
      },
    });
    const projected = projectGhidraDoctorInspection(
      await inspection({
        installDir: "C:\\tools\\ghidra_12.2_PUBLIC",
        platform: "win32",
      }),
    );
    expect(projected.checks).toContainEqual(
      expect.objectContaining({
        name: "native_authority",
        ok: true,
        code: null,
        remediation: null,
        classification: "healthy",
        detail: expect.stringContaining("local NTFS/ReFS only"),
      }),
    );
  });

  it("fails provider-scoped Windows readiness without blaming installation", async () => {
    const ghidra = await inspection({
      installDir: "C:\\tools\\ghidra_12.2_PUBLIC",
      platform: "win32",
    });
    const result = await runDoctor(
      undefined,
      {
        ...doctorHost(ghidra),
        platform: "win32",
        linuxDistribution: () => Promise.resolve(undefined),
      },
      { providers: ["ghidra"] },
    );
    expect(result.healthy).toBe(false);
    expect(result.scope_checks).toContainEqual(
      expect.objectContaining({
        name: "ghidra-native_authority",
        classification: "missing_dependency",
        detail: "Authored native artifact unavailable diagnostic",
      }),
    );
  });
});

describe("Windows native doctor failure diagnostics", () => {
  beforeEach(() => {
    vi.spyOn(nativeLoader, "systemWindowsNativeAuthority").mockReturnValue({
      available: false,
      failureStage: "artifact",
      reason: "Authored native artifact unavailable diagnostic",
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["host", "unsupported_host", "unsupported_host", "Windows x64 host"],
    [
      "artifact",
      "runtime_missing",
      "missing_dependency",
      "native/windows/README.md",
    ],
    [
      "self-test",
      "runtime_unavailable",
      "runtime_failure",
      "preserved native self-test error",
    ],
    [
      "inspection",
      "runtime_unavailable",
      "runtime_failure",
      "every required security control",
    ],
  ] as const)(
    "projects %s failure without blaming Ghidra",
    async (failureStage, code, classification, remediation) => {
      const reason =
        "Windows native failure: remove_owned_directory: directory is not empty (145)";
      const load = vi.mocked(nativeLoader.systemWindowsNativeAuthority);
      load.mockReturnValue({ available: false, failureStage, reason });
      const result = await runDoctor(
        undefined,
        {
          ...doctorHost(
            await inspection({ installDir: INSTALL, platform: "win32" }),
          ),
          platform: "win32",
          linuxDistribution: () => Promise.resolve(undefined),
        },
        { providers: ["ghidra"] },
      );
      expect(load).toHaveBeenCalledTimes(1);
      expect(result.healthy).toBe(false);
      expect(result.providerInspections?.[0]).toMatchObject({
        available: false,
        registrationEnvironment: { GHIDRA_INSTALL_DIR: INSTALL },
        checks: expect.arrayContaining([
          expect.objectContaining({
            name: "native_authority",
            ok: false,
            code,
            detail: reason,
          }),
        ]),
      });
      expect(result.scope_checks).toContainEqual(
        expect.objectContaining({
          name: "ghidra-native_authority",
          classification,
          detail: reason,
          remediation: expect.stringContaining(remediation),
        }),
      );
    },
  );

  it("keeps one failure observation even when the next query would differ", async () => {
    const load = vi.mocked(nativeLoader.systemWindowsNativeAuthority);
    load.mockReturnValueOnce({
      available: false,
      failureStage: "self-test",
      retryable: true,
      reason: "cleanup failed (145)",
    });
    const ghidra = await inspection({ installDir: INSTALL, platform: "win32" });
    const failed = projectGhidraDoctorInspection(ghidra);
    expect(load).toHaveBeenCalledTimes(1);
    expect(failed.checks).toContainEqual(
      expect.objectContaining({
        name: "native_authority",
        ok: false,
        code: "runtime_unavailable",
        detail: "cleanup failed (145)",
      }),
    );
    const later = projectGhidraDoctorInspection(ghidra);
    expect(load).toHaveBeenCalledTimes(2);
    expect(later.checks).toContainEqual(
      expect.objectContaining({
        name: "native_authority",
        code: "runtime_missing",
        detail: "Authored native artifact unavailable diagnostic",
      }),
    );
  });

  it("keeps missing Windows Java actionable as a dependency failure", async () => {
    const projected = projectGhidraDoctorInspection(
      await inspection(
        {
          installDir: "C:\\tools\\ghidra_12.2_PUBLIC",
          platform: "win32",
        },
        { probeJava: () => missingJavaProbe },
      ),
    );
    expect(projected.available).toBe(false);
    expect(projected.checks).toContainEqual(
      expect.objectContaining({
        name: "java",
        ok: false,
        classification: "missing_dependency",
        remediation: expect.any(String),
      }),
    );
  });
});

describe("Windows Ghidra temporary directory check", () => {
  const WINDOWS_INSTALL = "C:\\tools\\ghidra_12.2_PUBLIC";

  it("fails the provider closed and keeps restricted-host remediation when the probe fails", async () => {
    const projected = projectGhidraDoctorInspection(
      await inspection({ installDir: WINDOWS_INSTALL, platform: "win32" }),
      {
        ok: false,
        directory: "C:\\sandbox\\tmp",
        stage: "write",
        code: "EPERM",
        message: "EPERM: operation not permitted",
      },
    );
    expect(projected.available).toBe(false);
    const check = projected.checks.find(
      ({ name }) => name === "temp_directory",
    );
    expect(check).toMatchObject({
      ok: false,
      code: "temp_directory_unwritable",
      classification: "runtime_failure",
      remediation: expect.stringMatching(
        /TMP and TEMP.*allowed tree.*no dot-prefixed element.*restart REA/iu,
      ),
      details: { directory: "C:\\sandbox\\tmp", system_code: "EPERM" },
    });
    expect(check?.detail).toContain("C:\\sandbox\\tmp");
    expect(check?.detail).not.toMatch(/antivirus|DACL/iu);
    expect(check?.remediation).toMatch(
      /java_home\.save.*creating that file in advance does not help/iu,
    );
  });

  it("reports a retained probe file whose cleanup doctor retries", async () => {
    const projected = projectGhidraDoctorInspection(
      await inspection({ installDir: WINDOWS_INSTALL, platform: "win32" }),
      {
        ok: false,
        directory: "C:\\work",
        stage: "cleanup",
        code: "EPERM",
        message: "EPERM: operation not permitted",
        retainedPath: "C:\\work\\rea-doctor-probe-1",
      },
    );
    const check = projected.checks.find(
      ({ name }) => name === "temp_directory",
    );
    expect(check).toMatchObject({
      details: {
        directory: "C:\\work",
        stage: "cleanup",
        retained_path: "C:\\work\\rea-doctor-probe-1",
      },
    });
    expect(check?.detail).toContain("retries removal when doctor finishes");
  });

  it("reports a passing probe without claiming child-process access", async () => {
    const projected = projectGhidraDoctorInspection(
      await inspection({ installDir: WINDOWS_INSTALL, platform: "win32" }),
      { ok: true, directory: "C:\\Temp" },
    );
    expect(projected.checks).toContainEqual(
      expect.objectContaining({
        name: "temp_directory",
        ok: true,
        code: null,
        remediation: null,
        classification: "healthy",
        detail: expect.stringContaining(
          "does not test writes by Ghidra's child JVM",
        ),
      }),
    );
  });

  it("omits the temporary directory check when no Windows installation was selected", async () => {
    const projected = await inspectSystemGhidraProvider(
      {},
      inspectionResources.owner,
    );
    expect(projected.checks.map(({ name }) => name)).not.toContain(
      "temp_directory",
    );
  });
});

const unavailableAuthority = {
  available: false,
  failureStage: "self-test",
  retryable: true,
  reason: "cleanup failed (145)",
} as const;

it.each([
  { name: "selects", environment: { REA_GHIDRA_PROJECT_PATH: "C:\\p\\a.gpr" } },
  { name: "omits", environment: {} },
] as const)(
  "reads REA_GHIDRA_PROJECT_PATH from the registration when it $name a project on Windows",
  async ({ environment }) => {
    const authority = vi
      .spyOn(nativeLoader, "systemWindowsNativeAuthority")
      .mockReturnValue(unavailableAuthority);
    onTestFinished(() => authority.mockRestore());
    const projected = await inspectSystemGhidraProvider(
      { GHIDRA_INSTALL_DIR: "C:\\tools\\ghidra", ...environment },
      inspectionResources.owner,
      undefined,
      "win32",
    );
    expect(projected.available).toBe(false);
    const check = projected.checks.find(
      ({ name }) => name === "existing_project",
    );
    if ("REA_GHIDRA_PROJECT_PATH" in environment)
      expect(check).toMatchObject({
        ok: false,
        code: "unsupported_host",
        classification: "unsupported_host",
      });
    else expect(check).toBeUndefined();
  },
);

it("does not claim probe deletion failed when only descriptor cleanup remains", async () => {
  const projected = projectGhidraDoctorInspection(
    await inspection({ installDir: "C:\\tools\\ghidra", platform: "win32" }),
    {
      ok: false,
      directory: "C:\\work",
      stage: "cleanup",
      code: "EIO",
      message: "descriptor close not confirmed",
    },
  );
  const check = projected.checks.find(({ name }) => name === "temp_directory");
  expect(check).toMatchObject({ ok: false, details: { stage: "cleanup" } });
  expect(check?.detail).toContain("could not clean up a probe file");
  expect(check?.detail).not.toContain("could not delete");
  expect(check?.detail).not.toContain("remains");
});

it.each([
  {
    name: "a usable Linux installation",
    platform: "linux",
    java: true,
    native: undefined,
    project: false,
  },
  {
    name: "missing Java",
    platform: "linux",
    java: false,
    native: undefined,
    project: false,
  },
  {
    name: "unavailable Windows native authority",
    platform: "win32",
    java: true,
    native: unavailableAuthority,
    project: false,
  },
  {
    name: "an existing project on Linux",
    platform: "linux",
    java: true,
    native: undefined,
    project: true,
  },
  {
    name: "an existing project on Windows",
    platform: "win32",
    java: true,
    native: unavailableAuthority,
    project: true,
  },
] as const)(
  "doctor and provider readiness project one admission: $name",
  async ({ platform, java, native, project }) => {
    if (native !== undefined) {
      const authority = vi
        .spyOn(nativeLoader, "systemWindowsNativeAuthority")
        .mockReturnValue(native);
      onTestFinished(() => authority.mockRestore());
    }
    const overrides = java ? {} : { probeJava: () => missingJavaProbe };
    const doctor = projectGhidraDoctorInspection(
      await inspection({ installDir: INSTALL, platform }, overrides),
      undefined,
      { existingProject: project },
    );
    const config = parseConfig({
      GHIDRA_INSTALL_DIR: INSTALL,
      ...(project ? { REA_GHIDRA_PROJECT_PATH: "/projects/target.gpr" } : {}),
    });
    if (!config.ok) throw config.error;
    const provider = new GhidraProvider(
      config.value,
      silentLogger,
      {},
      {
        ...installationHost(overrides, platform),
        platform,
        architecture: "x64",
      },
    );
    try {
      const availability = await provider.inspectAvailability();
      expect(doctor.available).toBe(availability.status === "available");
      expect(doctor.available).toBe(
        !(project && platform === "win32") &&
          java &&
          native?.available !== false,
      );
      if (availability.status === "unavailable")
        expect(doctor.checks).toContainEqual(
          expect.objectContaining({
            ok: false,
            remediation: availability.remediation,
          }),
        );
    } finally {
      await provider.closeOwnedResources();
    }
  },
);
