import { describe, expect, it } from "vitest";

import {
  runSetup,
  type ClientConfigurationResult,
  type SetupClient,
  type SetupHost,
  type SetupOptions,
} from "../src/application/Setup.js";
import type { DoctorCheck } from "../src/application/Doctor.js";
import type { LinuxDistribution } from "../src/application/LinuxHopper.js";

class FakeSetupHost implements SetupHost {
  readonly platform: NodeJS.Platform;
  readonly nodeVersion = "25.1.0";
  version: string | undefined = "14.5";
  distribution: LinuxDistribution | undefined;
  hopper: string | undefined;
  hopperInstallSucceeds = true;
  skill: "installed" | "unchanged" | "failed" = "installed";
  clients: readonly SetupClient[] = [];
  clientResults = new Map<string, ClientConfigurationResult>();
  hopperInstalls = 0;
  configurations = 0;

  constructor(platform: NodeJS.Platform = "darwin") {
    this.platform = platform;
  }

  macosVersion = (): Promise<string | undefined> =>
    Promise.resolve(this.version);
  linuxDistribution = (): Promise<LinuxDistribution | undefined> =>
    Promise.resolve(this.distribution);
  hopperPath = (): Promise<string | undefined> => Promise.resolve(this.hopper);
  installHopper = (): Promise<string | undefined> => {
    this.hopperInstalls += 1;
    if (this.hopperInstallSucceeds) this.hopper = "/manual/Hopper";
    return Promise.resolve(this.hopper);
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
  installSkill = (): Promise<"installed" | "unchanged" | "failed"> =>
    Promise.resolve(this.skill);
  doctor = (): Promise<{
    healthy: boolean;
    hopperPath?: string;
    checks: readonly DoctorCheck[];
  }> =>
    Promise.resolve({
      healthy: this.hopper !== undefined,
      ...(this.hopper === undefined ? {} : { hopperPath: this.hopper }),
      checks: [],
    });
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
  });

  it("applies an accepted interactive plan including Hopper", async () => {
    const host = new FakeSetupHost();
    const result = await runSetup(
      { ...options(false), structured: false },
      host,
      () => Promise.resolve(true),
    );
    expect(result.status).toBe("needs_human");
    expect(result.appliedActions).toEqual([
      "installed_hopper",
      "installed_skill",
    ]);
    expect(host.hopperInstalls).toBe(1);
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
  });

  it("installs Hopper when unattended authorization is explicit", async () => {
    const host = new FakeSetupHost();
    const result = await runSetup(options(true, true), host);
    expect(result.appliedActions).toEqual([
      "installed_hopper",
      "installed_skill",
    ]);
    expect(host.hopperInstalls).toBe(1);
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

  it("reports a failed Hopper installation without configuring clients", async () => {
    const host = new FakeSetupHost();
    host.hopperInstallSucceeds = false;
    host.clients = [{ name: "cursor", configPath: "/cursor.json" }];
    const result = await runSetup(options(true, true), host);
    expect(result.status).toBe("needs_human");
    expect(result.remediation).toContain("failed");
    expect(host.configurations).toBe(0);
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
  });
});
