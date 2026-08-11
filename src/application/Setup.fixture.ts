import {
  type ClientConfigurationInspection,
  type ClientConfigurationResult,
  type SetupClient,
  type SetupHost,
  type SetupOptions,
  type SetupHopperInstallResult,
  type SetupProviderEnvironment,
} from "./Setup.js";
import type { DoctorCheck, DoctorReport, DoctorScope } from "./Doctor.js";
import type { LinuxDistribution } from "./LinuxHopper.js";

/** Recording setup host for service-level planning and recovery tests. */
export class FakeSetupHost implements SetupHost {
  readonly platform: NodeJS.Platform;
  nodeVersion = "25.1.0";
  version: string | undefined = "14.5";
  distribution: LinuxDistribution | undefined;
  hopper: string | undefined;
  ghidra: string | undefined;
  javaHome: string | undefined;
  hopperInstallSucceeds = true;
  skill: "installed" | "unchanged" | "failed" = "installed";
  clients: readonly SetupClient[] = [];
  clientResults = new Map<string, ClientConfigurationResult>();
  clientInspections = new Map<string, ClientConfigurationInspection>();
  hopperInstalls = 0;
  hopperReplaceRequests: boolean[] = [];
  configurations = 0;
  skillInstalls = 0;
  doctorCalls = 0;
  doctorScopes: Array<DoctorScope | undefined> = [];
  checkedHopperPaths: Array<string | undefined> = [];
  configuredProviderEnvironments: SetupProviderEnvironment[] = [];
  doctorHealthy: boolean | undefined;
  scopedDoctorHealthy: boolean | undefined;
  linuxDemoRuntimeMissing = false;
  unsupportedHopperVersion = false;

  constructor(platform: NodeJS.Platform = "darwin") {
    this.platform = platform;
  }

  macosVersion = (): Promise<string | undefined> =>
    Promise.resolve(this.version);
  linuxDistribution = (): Promise<LinuxDistribution | undefined> =>
    Promise.resolve(this.distribution);
  hopperPath = (): Promise<string | undefined> => Promise.resolve(this.hopper);
  providerEnvironment = (): Promise<SetupProviderEnvironment> =>
    Promise.resolve({
      ...(this.hopper === undefined
        ? {}
        : { HOPPER_LAUNCHER_PATH: this.hopper }),
      ...(this.ghidra === undefined ? {} : { GHIDRA_INSTALL_DIR: this.ghidra }),
      ...(this.javaHome === undefined ? {} : { JAVA_HOME: this.javaHome }),
    });
  installHopper = (
    replaceExisting: boolean,
  ): Promise<SetupHopperInstallResult> => {
    this.hopperInstalls += 1;
    this.hopperReplaceRequests.push(replaceExisting);
    this.linuxDemoRuntimeMissing = false;
    if (this.hopperInstallSucceeds) {
      this.hopper = "/manual/Hopper";
      return Promise.resolve({
        status: "installed",
        launcherPath: this.hopper,
      });
    }
    return Promise.resolve({
      status: "failed",
      code: "download_failed",
      remediation: "Download failed.",
    });
  };
  detectedClients = (): Promise<readonly SetupClient[]> =>
    Promise.resolve(this.clients);
  configureClient = (
    client: SetupClient,
    providerEnvironment: SetupProviderEnvironment,
  ): Promise<ClientConfigurationResult> => {
    this.configurations += 1;
    this.configuredProviderEnvironments.push(providerEnvironment);
    return Promise.resolve(
      this.clientResults.get(client.name) ?? { status: "configured" },
    );
  };
  clientNeedsConfigure = (
    client: SetupClient,
    providerEnvironment: SetupProviderEnvironment,
  ): Promise<boolean> => {
    this.checkedHopperPaths.push(providerEnvironment.HOPPER_LAUNCHER_PATH);
    return Promise.resolve(
      this.clientResults.get(client.name)?.status !== "unchanged",
    );
  };
  inspectClientConfiguration = (
    client: SetupClient,
  ): Promise<ClientConfigurationInspection> =>
    Promise.resolve(
      this.clientInspections.get(client.name) ?? { status: "update" },
    );
  skillNeedsInstall = (): Promise<boolean> =>
    Promise.resolve(this.skill !== "unchanged");
  installSkill = (): Promise<"installed" | "unchanged" | "failed"> => {
    this.skillInstalls += 1;
    return Promise.resolve(this.skill);
  };
  doctor = (scope?: DoctorScope): Promise<DoctorReport> => {
    this.doctorCalls += 1;
    this.doctorScopes.push(scope);
    const checks: DoctorCheck[] = [
      ...(this.linuxDemoRuntimeMissing
        ? ([
            {
              name: "hopper-demo-runtime",
              ok: false,
              classification: "missing_dependency",
            },
          ] as const)
        : []),
      ...(this.unsupportedHopperVersion
        ? ([
            {
              name: "hopper-version",
              ok: false,
              classification: "config_drift",
              detail: this.hopper ?? "",
            },
          ] as const)
        : []),
    ];
    const environmentHealthy =
      this.doctorHealthy ??
      (this.hopper !== undefined &&
        !this.linuxDemoRuntimeMissing &&
        !this.unsupportedHopperVersion);
    const healthy =
      scope === undefined
        ? environmentHealthy
        : (this.scopedDoctorHealthy ?? environmentHealthy);
    return Promise.resolve({
      healthy,
      environment_healthy: environmentHealthy,
      scope: {
        mode: scope === undefined ? "audit-wide" : "explicit",
        clients: scope?.clients ?? [],
        providers: scope?.providers ?? [],
        skill: scope?.skill === true,
        target: null,
      },
      scope_checks: checks,
      informational_checks: [],
      ...(this.hopper === undefined ? {} : { hopperPath: this.hopper }),
      checks,
    });
  };
}

/** Build setup options for approved or planning-only service tests. */
export const options = (
  approved: boolean,
  installHopper = false,
): SetupOptions => ({
  approved,
  installHopper,
  structured: true,
});
