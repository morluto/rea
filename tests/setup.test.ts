import { describe, expect, it } from "vitest";

import {
  runSetup,
  type ClientConfigurationResult,
  type SetupClient,
  type SetupHost,
  type SetupOptions,
  type SetupHopperInstallResult,
} from "../src/application/Setup.js";
import type { DoctorCheck } from "../src/application/Doctor.js";
import type { LinuxDistribution } from "../src/application/LinuxHopper.js";

class FakeSetupHost implements SetupHost {
  readonly platform: NodeJS.Platform;
  nodeVersion = "25.1.0";
  version: string | undefined = "14.5";
  distribution: LinuxDistribution | undefined;
  hopper: string | undefined;
  hopperInstallSucceeds = true;
  skill: "installed" | "unchanged" | "failed" = "installed";
  clients: readonly SetupClient[] = [];
  clientResults = new Map<string, ClientConfigurationResult>();
  hopperInstalls = 0;
  configurations = 0;
  skillInstalls = 0;
  doctorHealthy: boolean | undefined;
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
  installHopper = (): Promise<SetupHopperInstallResult> => {
    this.hopperInstalls += 1;
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
  ): Promise<ClientConfigurationResult> => {
    this.configurations += 1;
    return Promise.resolve(
      this.clientResults.get(client.name) ?? { status: "configured" },
    );
  };
  clientNeedsConfigure = (client: SetupClient): Promise<boolean> =>
    Promise.resolve(
      this.clientResults.get(client.name)?.status !== "unchanged",
    );
  skillNeedsInstall = (): Promise<boolean> =>
    Promise.resolve(this.skill !== "unchanged");
  installSkill = (): Promise<"installed" | "unchanged" | "failed"> => {
    this.skillInstalls += 1;
    return Promise.resolve(this.skill);
  };
  doctor = (): Promise<{
    healthy: boolean;
    hopperPath?: string;
    checks: readonly DoctorCheck[];
  }> => {
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
    return Promise.resolve({
      healthy:
        this.doctorHealthy ??
        (this.hopper !== undefined &&
          !this.linuxDemoRuntimeMissing &&
          !this.unsupportedHopperVersion),
      ...(this.hopper === undefined ? {} : { hopperPath: this.hopper }),
      checks,
    });
  };
}

const options = (approved: boolean, installHopper = false): SetupOptions => ({
  approved,
  installHopper,
  structured: true,
});

describe("setup workflow", () => {
  it("returns a complete plan without mutation", async () => {
    const host = new FakeSetupHost();
    host.clients = [{ name: "cursor", configPath: "/cursor.json" }];
    const result = await runSetup(options(false), host);
    expect(result.status).toBe("needs_confirmation");
    expect(result.plannedActions.map(({ kind }) => kind)).toEqual([
      "install_hopper",
      "configure_client",
      "install_skill",
    ]);
    expect(host.hopperInstalls).toBe(0);
    expect(host.configurations).toBe(0);
    expect(result.remediation).toBe(
      "Review the setup plan, then rerun interactively or with --yes.",
    );
  });

  it("reports ready after an accepted Linux plan installs healthy Hopper", async () => {
    const host = new FakeSetupHost("linux");
    host.distribution = {
      id: "ubuntu",
      versionId: "24.04",
      packageFamily: "deb",
      supported: true,
    };
    const result = await runSetup(
      { ...options(false), structured: false },
      host,
      () => Promise.resolve(true),
    );
    expect(result.status).toBe("ready");
    expect(result.appliedActions).toEqual([
      "installed_hopper",
      "installed_skill",
    ]);
    expect(host.hopperInstalls).toBe(1);
    expect(result.remediation).toBeUndefined();
  });

  it("requires first-run activation after installing Hopper on macOS", async () => {
    const host = new FakeSetupHost();
    const result = await runSetup(
      { ...options(false), structured: false },
      host,
      () => Promise.resolve(true),
    );
    expect(result.status).toBe("needs_human");
    expect(result.remediation).toContain("choose its demo mode");
  });

  it("declines an interactive plan without mutation", async () => {
    const host = new FakeSetupHost();
    const result = await runSetup(
      { ...options(false), structured: false },
      host,
      () => Promise.resolve(false),
    );
    expect(result.status).toBe("planned");
    expect(result.appliedActions).toEqual([]);
    expect(host.hopperInstalls).toBe(0);
  });

  it("requires the Hopper flag for unattended setup", async () => {
    const host = new FakeSetupHost();
    const result = await runSetup(options(true), host);
    expect(result.status).toBe("needs_human");
    expect(host.hopperInstalls).toBe(0);
    expect(result.appliedActions).toEqual(["installed_skill"]);
    expect(result.remediation).toContain("--install-hopper");
    expect(result.remediation).toBe(
      "Hopper is optional for non-Hopper providers. Rerun with --yes --install-hopper for deep native analysis.",
    );
  });

  it("installs Hopper when unattended authorization is explicit", async () => {
    const host = new FakeSetupHost("linux");
    host.distribution = {
      id: "ubuntu",
      versionId: "24.04",
      packageFamily: "deb",
      supported: true,
    };
    const result = await runSetup(options(true, true), host);
    expect(result.appliedActions).toEqual([
      "installed_hopper",
      "installed_skill",
    ]);
    expect(host.hopperInstalls).toBe(1);
    expect(result.status).toBe("ready");
    expect(result.remediation).toBeUndefined();
  });

  it("reuses existing Hopper and configures detected clients", async () => {
    const host = new FakeSetupHost();
    host.hopper = "/Applications/Hopper";
    host.clients = [
      { name: "claude", configPath: "/claude.json" },
      { name: "cursor", configPath: "/cursor.json" },
    ];
    const result = await runSetup(options(true), host);
    expect(result.status).toBe("ready");
    expect(result.appliedActions).toEqual([
      "configured_claude",
      "configured_cursor",
      "installed_skill",
    ]);
    expect(host.hopperInstalls).toBe(0);
  });

  it("omits an aligned managed skill from an otherwise empty plan", async () => {
    const host = new FakeSetupHost();
    host.hopper = "/Applications/Hopper";
    host.skill = "unchanged";
    const result = await runSetup(options(false), host);
    expect(result.status).toBe("ready");
    expect(result.plannedActions).toEqual([]);
    expect(result.appliedActions).toEqual([]);
    expect(host.skillInstalls).toBe(0);
  });

  it("installs missing Linux demo dependencies for existing Hopper", async () => {
    const host = new FakeSetupHost("linux");
    host.distribution = {
      id: "ubuntu",
      versionId: "24.04",
      packageFamily: "deb",
      supported: true,
    };
    host.hopper = "/opt/hopper/bin/Hopper";
    host.linuxDemoRuntimeMissing = true;
    const result = await runSetup(
      { ...options(false), structured: false },
      host,
      () => Promise.resolve(true),
    );
    expect(result.status).toBe("ready");
    expect(host.hopperInstalls).toBe(1);
    expect(result.plannedActions.map(({ kind }) => kind)).toContain(
      "install_hopper",
    );
  });

  it("does not reinstall Hopper for an unsupported configured path", async () => {
    const host = new FakeSetupHost("linux");
    host.distribution = {
      id: "ubuntu",
      versionId: "24.04",
      packageFamily: "deb",
      supported: true,
    };
    host.hopper = "/custom/Hopper";
    host.unsupportedHopperVersion = true;
    const result = await runSetup(
      { ...options(false), structured: false },
      host,
      () => Promise.resolve(true),
    );
    expect(result.status).toBe("needs_human");
    expect(host.hopperInstalls).toBe(0);
    expect(result.plannedActions.map(({ kind }) => kind)).not.toContain(
      "install_hopper",
    );
  });

  it("reports a failed Hopper installation without configuring clients", async () => {
    const host = new FakeSetupHost();
    host.hopperInstallSucceeds = false;
    host.clients = [{ name: "cursor", configPath: "/cursor.json" }];
    const result = await runSetup(options(true, true), host);
    expect(result.status).toBe("needs_human");
    expect(result.code).toBe("download_failed");
    expect(result.remediation).toBe("Download failed.");
    expect(host.configurations).toBe(0);
  });

  it.each([
    [
      "path",
      "Agent configuration path could not be safely verified. Check its permissions and, if it is a symbolic link, verify that the link resolves to a regular file owned by the current user, then rerun setup.",
    ],
    [
      "backup",
      "Agent configuration could not be backed up, so no change was made. Check file permissions, then rerun setup.",
    ],
    [
      "write",
      "Agent configuration could not be updated. Check file permissions, then rerun setup.",
    ],
    [
      "readback",
      "Agent configuration could not be verified after writing. Repair the configuration file or restore its `.rea.backup`, then rerun setup.",
    ],
  ] as const)("explains %s configuration recovery", async (reason, message) => {
    const host = new FakeSetupHost();
    host.hopper = "/Applications/Hopper";
    host.clients = [{ name: "internal_client_key", configPath: "/agent.json" }];
    host.clientResults.set("internal_client_key", { status: "failed", reason });
    const result = await runSetup(options(true), host);
    expect(result.status).toBe("needs_human");
    expect(result.remediation).toBe(message);
    expect(result.remediation).not.toContain("internal_client_key");
  });

  it("records every detected client outcome after an earlier failure", async () => {
    const host = new FakeSetupHost();
    host.hopper = "/Applications/Hopper";
    host.clients = [
      { name: "first", configPath: "/first.json" },
      { name: "second", configPath: "/second.json" },
      { name: "third", configPath: "/third.json" },
    ];
    host.clientResults.set("first", { status: "failed", reason: "write" });
    host.clientResults.set("second", { status: "configured" });
    host.clientResults.set("third", { status: "failed", reason: "readback" });

    const result = await runSetup(options(true), host);

    expect(host.configurations).toBe(3);
    expect(result.clients).toEqual({
      first: { status: "failed", reason: "write" },
      second: { status: "configured" },
      third: { status: "failed", reason: "readback" },
    });
    expect(result.appliedActions).toEqual(["configured_second"]);
    expect(result.status).toBe("needs_human");
    expect(result.remediation).toContain("could not be updated");
  });

  it("explains skill installation recovery", async () => {
    const host = new FakeSetupHost();
    host.hopper = "/Applications/Hopper";
    host.skill = "failed";
    const result = await runSetup(options(true), host);
    expect(result.status).toBe("needs_human");
    expect(result.remediation).toBe(
      "REA analysis skill could not be installed or verified. Check permissions for `~/.agents/skills`, then rerun setup.",
    );
  });

  it("delegates remaining unhealthy checks to doctor remediation", async () => {
    const host = new FakeSetupHost();
    host.hopper = "/Applications/Hopper";
    host.doctorHealthy = false;
    const result = await runSetup(options(true), host);
    expect(result.remediation).toBe(
      "Run rea doctor and apply each reported remediation.",
    );
  });

  it("explains unsupported Node and macOS recovery", async () => {
    const platformHost = new FakeSetupHost("win32");
    expect((await runSetup(options(true), platformHost)).remediation).toBe(
      "REA supports Hopper on macOS and selected 64-bit Linux distributions.",
    );

    const nodeHost = new FakeSetupHost();
    nodeHost.nodeVersion = "20.0.0";
    expect((await runSetup(options(true), nodeHost)).remediation).toBe(
      "Install Node.js 22.19+ or 24.11+ and rerun setup.",
    );

    const macHost = new FakeSetupHost();
    macHost.version = "11.7";
    expect((await runSetup(options(true), macHost)).remediation).toBe(
      "Upgrade to macOS 12 or newer.",
    );
  });

  it("rejects unsupported hosts before mutation", async () => {
    const host = new FakeSetupHost("linux");
    host.distribution = {
      id: "debian",
      versionId: "13",
      packageFamily: "deb",
      supported: false,
    };
    const result = await runSetup(options(true, true), host);
    expect(result.status).toBe("needs_human");
    expect(host.hopperInstalls).toBe(0);
    expect(result.remediation).toBe(
      "REA supports Hopper on Ubuntu 24.04+, Fedora 41+, and 64-bit Arch Linux.",
    );
  });
});
