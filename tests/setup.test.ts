import { describe, expect, it } from "vitest";

import {
  runSetup,
  type ClientConfigurationResult,
  type SetupClient,
  type SetupHost,
} from "../src/application/Setup.js";
import type { DoctorCheck } from "../src/application/Doctor.js";
import type { LinuxDistribution } from "../src/application/LinuxHopper.js";

class FakeSetupHost implements SetupHost {
  readonly platform: NodeJS.Platform;
  readonly nodeVersion = "24.18.0";
  version: string | undefined = "14.5";
  brew = false;
  hopper: string | undefined;
  homebrewInstallSucceeds = true;
  hopperInstallSucceeds = true;
  skill: "installed" | "unchanged" | "failed" = "installed";
  clients: readonly SetupClient[] = [];
  clientResults = new Map<string, ClientConfigurationResult>();
  homebrewInstalls = 0;
  hopperInstalls = 0;
  configurations = 0;
  configuredHopperPaths: string[] = [];
  distribution: LinuxDistribution | undefined;

  constructor(platform: NodeJS.Platform = "darwin") {
    this.platform = platform;
  }

  macosVersion = (): Promise<string | undefined> =>
    Promise.resolve(this.version);
  linuxDistribution = (): Promise<LinuxDistribution | undefined> =>
    Promise.resolve(this.distribution);
  hasHomebrew = (): Promise<boolean> => Promise.resolve(this.brew);
  installHomebrew = (): Promise<boolean> => {
    this.homebrewInstalls += 1;
    if (this.homebrewInstallSucceeds) this.brew = true;
    return Promise.resolve(this.homebrewInstallSucceeds);
  };
  hopperPath = (): Promise<string | undefined> => Promise.resolve(this.hopper);
  installHopper = (): Promise<boolean> => {
    this.hopperInstalls += 1;
    if (this.hopperInstallSucceeds) this.hopper = "/manual/Hopper";
    return Promise.resolve(this.hopperInstallSucceeds);
  };
  detectedClients = (): Promise<readonly SetupClient[]> =>
    Promise.resolve(this.clients);
  configureClient = (
    client: SetupClient,
    hopperPath: string,
  ): Promise<ClientConfigurationResult> => {
    this.configurations += 1;
    this.configuredHopperPaths.push(hopperPath);
    return Promise.resolve(
      this.clientResults.get(client.name) ?? {
        status: "configured",
        backupPath: `${client.configPath}.backup`,
      },
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
      healthy:
        (this.platform === "linux" || this.brew) && this.hopper !== undefined,
      ...(this.hopper === undefined ? {} : { hopperPath: this.hopper }),
      checks: [],
    });
}

describe("setup workflow", () => {
  it("installs Homebrew and Hopper on a clean approved machine", async () => {
    const host = new FakeSetupHost();
    const result = await runSetup(true, host);
    expect(result.status).toBe("needs_human");
    expect(result.actions).toEqual([
      "installed_homebrew",
      "installed_hopper",
      "installed_skill",
    ]);
  });

  it("installs Hopper without Homebrew on supported Linux", async () => {
    const host = new FakeSetupHost("linux");
    host.distribution = {
      id: "ubuntu",
      versionId: "24.04",
      packageFamily: "deb",
      supported: true,
    };
    const result = await runSetup(true, host);
    expect(result.status).toBe("needs_human");
    expect(result.actions).toEqual(["installed_hopper", "installed_skill"]);
    expect(host.homebrewInstalls).toBe(0);
  });

  it("rejects unsupported Linux before mutation", async () => {
    const host = new FakeSetupHost("linux");
    host.distribution = {
      id: "debian",
      versionId: "13",
      packageFamily: "deb",
      supported: false,
    };
    const result = await runSetup(true, host);
    expect(result.status).toBe("needs_human");
    expect(host.hopperInstalls).toBe(0);
    expect(host.configurations).toBe(0);
  });

  it("requires --yes before installing Homebrew", async () => {
    const host = new FakeSetupHost();
    const result = await runSetup(false, host);
    expect(result.status).toBe("needs_human");
    expect(host.homebrewInstalls).toBe(0);
    expect(result.remediation).toContain("--yes");
  });

  it("requires --yes before installing Hopper", async () => {
    const host = new FakeSetupHost();
    host.brew = true;
    const result = await runSetup(false, host);
    expect(result.status).toBe("needs_human");
    expect(host.hopperInstalls).toBe(0);
    expect(result.remediation).toContain("--yes");
  });

  it("accepts existing Homebrew and manually installed Hopper", async () => {
    const host = new FakeSetupHost();
    host.brew = true;
    host.hopper = "/Applications/Manual Hopper";
    expect((await runSetup(true, host)).actions).toEqual(["installed_skill"]);
    expect(host.hopperInstalls).toBe(0);
    expect(host.configuredHopperPaths).toEqual([]);
  });

  it.each(["homebrew", "hopper"] as const)(
    "returns needs_human when %s installation is interrupted",
    async (stage) => {
      const host = new FakeSetupHost();
      if (stage === "homebrew") host.homebrewInstallSucceeds = false;
      else {
        host.brew = true;
        host.hopperInstallSucceeds = false;
      }
      const result = await runSetup(true, host);
      expect(result.status).toBe("needs_human");
      expect(result.remediation).toContain("interrupted");
    },
  );

  it("configures every detected client and reports backup paths", async () => {
    const host = new FakeSetupHost();
    host.brew = true;
    host.hopper = "/Hopper";
    host.clients = [
      { name: "claude", configPath: "/claude.json" },
      { name: "cursor", configPath: "/cursor.json" },
    ];
    const result = await runSetup(true, host);
    expect(Object.keys(result.clients)).toEqual(["claude", "cursor"]);
    expect(host.configurations).toBe(2);
    expect(host.configuredHopperPaths).toEqual(["/Hopper", "/Hopper"]);
  });

  it.each(["backup", "write", "readback"] as const)(
    "stops with precise remediation after a %s failure",
    async (reason) => {
      const host = new FakeSetupHost();
      host.brew = true;
      host.hopper = "/Hopper";
      host.clients = [{ name: "cursor", configPath: "/cursor.json" }];
      host.clientResults.set("cursor", { status: "failed", reason });
      const result = await runSetup(true, host);
      expect(result.status).toBe("needs_human");
      expect(result.remediation).toContain(reason);
    },
  );

  it("is idempotent on repeated setup", async () => {
    const host = new FakeSetupHost();
    host.brew = true;
    host.hopper = "/Hopper";
    host.skill = "unchanged";
    host.clients = [{ name: "cursor", configPath: "/cursor.json" }];
    host.clientResults.set("cursor", { status: "unchanged" });
    const first = await runSetup(true, host);
    const second = await runSetup(true, host);
    expect(first.actions).toEqual([]);
    expect(second.actions).toEqual([]);
    expect(host.homebrewInstalls).toBe(0);
    expect(host.hopperInstalls).toBe(0);
  });

  it.each(["11.7", undefined])(
    "rejects unsupported macOS %s before mutation",
    async (version) => {
      const host = new FakeSetupHost();
      host.version = version;
      expect((await runSetup(true, host)).status).toBe("needs_human");
      expect(host.homebrewInstalls).toBe(0);
    },
  );
});
