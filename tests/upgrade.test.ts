import { describe, expect, it } from "vitest";

import {
  detectNpmInstallation,
  runUpgrade,
  type UpgradeHost,
  type UpgradeOutput,
  type NpmInstallationHost,
} from "../src/application/Upgrade.js";

class FakeUpgradeHost implements UpgradeHost {
  latest: string | undefined = "0.6.0";
  installationResult: { readonly prefix: string } | undefined = {
    prefix: "/fixture",
  };
  installSucceeds = true;
  installs = 0;
  output: UpgradeOutput | undefined;

  latestVersion = (): Promise<string | undefined> =>
    Promise.resolve(this.latest);
  installation = (): Promise<{ readonly prefix: string } | undefined> =>
    Promise.resolve(this.installationResult);
  installLatest = (
    _installation: { readonly prefix: string },
    output: UpgradeOutput,
  ): Promise<boolean> => {
    this.installs += 1;
    this.output = output;
    return Promise.resolve(this.installSucceeds);
  };
}

describe("CLI upgrade", () => {
  it("reports an already-current release without mutation", async () => {
    const host = new FakeUpgradeHost();

    expect(await runUpgrade("0.6.0", host)).toEqual({
      status: "current",
      currentVersion: "0.6.0",
      latestVersion: "0.6.0",
      installMethod: "npm",
    });
    expect(host.installs).toBe(0);
  });

  it("upgrades an outdated global npm installation", async () => {
    const host = new FakeUpgradeHost();

    expect(await runUpgrade("0.5.0", host)).toEqual({
      status: "upgraded",
      previousVersion: "0.5.0",
      latestVersion: "0.6.0",
      versionCheck: "available",
      installMethod: "npm",
      command: "npm install --global rea-agents@latest",
      clientRestartRequired: true,
      remediation:
        "Rerun rea setup to refresh registrations and the skill, then restart clients that may retain an older MCP server.",
    });
    expect(host.installs).toBe(1);
  });

  it("does not mutate when the registry check is unavailable", async () => {
    const host = new FakeUpgradeHost();
    host.latest = undefined;

    expect(await runUpgrade("0.5.0", host)).toMatchObject({
      status: "failed",
      latestVersion: null,
      reason: "version-check",
    });
    expect(host.installs).toBe(0);
  });

  it.each([
    ["1.10.0", "1.9.0"],
    ["1.0.0", "1.0.0-rc.1"],
  ])(
    "does not downgrade installed version %s to registry version %s",
    async (currentVersion, latestVersion) => {
      const host = new FakeUpgradeHost();
      host.latest = latestVersion;

      expect(await runUpgrade(currentVersion, host)).toEqual({
        status: "current",
        currentVersion,
        latestVersion,
        installMethod: "npm",
      });
      expect(host.installs).toBe(0);
    },
  );

  it("upgrades a prerelease when the final release is available", async () => {
    const host = new FakeUpgradeHost();
    host.latest = "1.0.0";

    expect(await runUpgrade("1.0.0-rc.1", host)).toMatchObject({
      status: "upgraded",
      previousVersion: "1.0.0-rc.1",
      latestVersion: "1.0.0",
    });
    expect(host.installs).toBe(1);
  });

  it("rejects invalid registry version metadata without mutation", async () => {
    const host = new FakeUpgradeHost();
    host.latest = "latest";

    expect(await runUpgrade("1.0.0", host)).toMatchObject({
      status: "failed",
      currentVersion: "1.0.0",
      latestVersion: "latest",
      reason: "version-check",
    });
    expect(host.installs).toBe(0);
  });

  it("preserves stdout for an explicitly structured CLI response", async () => {
    const host = new FakeUpgradeHost();

    await runUpgrade("0.5.0", host, "structured");

    expect(host.output).toBe("structured");
  });

  it("refuses to mutate an unrelated installation", async () => {
    const host = new FakeUpgradeHost();
    host.installationResult = undefined;

    expect(await runUpgrade("0.5.0", host)).toMatchObject({
      status: "failed",
      reason: "unknown-install-method",
      remediation:
        "Update manually with: npm install --global rea-agents@latest",
    });
    expect(host.installs).toBe(0);
  });

  it("reports npm installation failure", async () => {
    const host = new FakeUpgradeHost();
    host.installSucceeds = false;

    expect(await runUpgrade("0.5.0", host)).toMatchObject({
      status: "failed",
      reason: "install",
      remediation:
        "REA could not update through npm. Check npm registry access and global install permissions, then run: npm install --global rea-agents@latest",
    });
    expect(host.installs).toBe(1);
  });
});

describe("npm installation detection", () => {
  const host = (root: string, prefix = "/usr/local"): NpmInstallationHost => ({
    canonicalPath: (path) => Promise.resolve(path),
    globalRoot: () => Promise.resolve(root),
    globalPrefix: () => Promise.resolve(prefix),
  });

  it("returns the prefix for the global package that owns the running CLI", async () => {
    await expect(
      detectNpmInstallation(
        "/usr/local/lib/node_modules/rea-agents",
        host("/usr/local/lib/node_modules"),
      ),
    ).resolves.toEqual({ prefix: "/usr/local" });
  });

  it("infers the prefix used by the curl installer's custom npm layout", async () => {
    await expect(
      detectNpmInstallation(
        "/home/user/.local/lib/node_modules/rea-agents",
        host("/usr/local/lib/node_modules"),
      ),
    ).resolves.toEqual({ prefix: "/home/user/.local" });
  });

  it("rejects a source checkout when a different global copy exists", async () => {
    await expect(
      detectNpmInstallation("/work/rea", host("/usr/local/lib/node_modules")),
    ).resolves.toBeUndefined();
  });
});
