import { describe, expect, it } from "vitest";

import { FakeSetupHost, options } from "./Setup.fixture.js";
import { runSetup } from "./Setup.js";

describe("setup workflow", () => {
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

  it("uses requested readiness scope without hiding environment drift", async () => {
    const host = new FakeSetupHost();
    host.hopper = "/Applications/Hopper";
    host.doctorHealthy = false;
    host.scopedDoctorHealthy = true;
    const readinessScope = {
      clients: ["codex"],
      providers: [] as string[],
      skill: true,
    };

    const result = await runSetup(
      {
        ...options(true),
        proposeHopper: false,
        installSkill: false,
        readinessScope,
      },
      host,
    );

    expect(result).toMatchObject({
      status: "ready",
      doctor: { healthy: true, environment_healthy: false },
    });
    expect(host.doctorScopes).toEqual(expect.arrayContaining([readinessScope]));
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
      "Automated Hopper setup supports Ubuntu 24.04+, Fedora 41+, and 64-bit Arch Linux; configure an existing supported provider instead.",
    );
  });

  it("configures BYO Ghidra on Linux outside Hopper's installer matrix", async () => {
    const host = new FakeSetupHost("linux");
    host.distribution = {
      id: "debian",
      versionId: "13",
      packageFamily: "deb",
      supported: false,
    };
    host.ghidra = "/opt/ghidra_12.1.2_PUBLIC";
    host.javaHome = "/usr/lib/jvm/jdk-21";
    host.doctorHealthy = true;
    host.skill = "unchanged";
    host.clients = [{ name: "codex", configPath: "/codex.toml" }];

    const result = await runSetup(options(true), host);

    expect(result.status).toBe("ready");
    expect(host.hopperInstalls).toBe(0);
    expect(host.configuredProviderEnvironments).toContainEqual({
      GHIDRA_INSTALL_DIR: "/opt/ghidra_12.1.2_PUBLIC",
      JAVA_HOME: "/usr/lib/jvm/jdk-21",
    });
  });
});
