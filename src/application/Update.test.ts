import { describe, expect, it } from "vitest";

import { err, ok, type Result } from "../domain/result.js";
import {
  runUpdate,
  type ReleaseLookupFailure,
  type UpdateHost,
  type UpdateOutput,
  type NpmInstallation,
} from "./Update.js";
import {
  detectNpmInstallation,
  type NpmInstallationHost,
} from "./UpdateRuntime.js";
import type { IntegrationMaintenance } from "./UpdateMaintenance.js";

class FakeUpdateHost implements UpdateHost {
  release: Result<string, ReleaseLookupFailure> = ok("3.3.0");
  installationResult: NpmInstallation | undefined = {
    prefix: "/fixture",
    packageRoot: "/fixture/lib/node_modules/rea-agents",
  };
  installResult: Result<void, string> = ok(undefined);
  verified: Result<string, string> = ok("3.3.0");
  maintenance: IntegrationMaintenance = {
    status: "current",
    plannedActions: [],
  };
  installedVersions: string[] = [];
  installationInspected = false;
  verifiedInstallation: NpmInstallation | undefined;
  maintenanceInspected = false;
  output: UpdateOutput | undefined;

  installation = (): Promise<NpmInstallation | undefined> => {
    this.installationInspected = true;
    return Promise.resolve(this.installationResult);
  };
  latestVersion = (): Promise<Result<string, ReleaseLookupFailure>> =>
    Promise.resolve(this.release);
  installVersion = (
    _installation: NpmInstallation,
    version: string,
    output: UpdateOutput,
  ): Promise<Result<void, string>> => {
    this.installedVersions.push(version);
    this.output = output;
    return Promise.resolve(this.installResult);
  };
  installedVersion = (
    installation: NpmInstallation,
  ): Promise<Result<string, string>> => {
    this.verifiedInstallation = installation;
    return Promise.resolve(this.verified);
  };
  planMaintenance = (): Promise<IntegrationMaintenance> => {
    this.maintenanceInspected = true;
    return Promise.resolve(this.maintenance);
  };
}

describe("REA update", () => {
  it("identifies an already-current installation without mutation", async () => {
    const host = new FakeUpdateHost();
    expect(await runUpdate("3.3.0", host)).toEqual({
      status: "current",
      currentVersion: "3.3.0",
      latestVersion: "3.3.0",
      installMethod: "npm",
    });
    expect(host.installationInspected).toBe(true);
    expect(host.installedVersions).toEqual([]);
    expect(host.maintenanceInspected).toBe(false);
  });

  it("reports an unknown current installation honestly", async () => {
    const host = new FakeUpdateHost();
    host.installationResult = undefined;
    expect(await runUpdate("3.3.0", host)).toMatchObject({
      status: "current",
      installMethod: "unknown",
    });
    expect(host.installedVersions).toEqual([]);
  });

  it("installs the resolved release and verifies the same package root", async () => {
    const host = new FakeUpdateHost();
    expect(await runUpdate("3.2.1", host, "structured")).toMatchObject({
      status: "updated",
      previousVersion: "3.2.1",
      latestVersion: "3.3.0",
      installedVersion: "3.3.0",
      command: [
        "npm",
        "install",
        "--global",
        "--ignore-scripts",
        "--prefix",
        "/fixture",
        "rea-agents@3.3.0",
      ],
    });
    expect(host.installedVersions).toEqual(["3.3.0"]);
    expect(host.verifiedInstallation).toEqual(host.installationResult);
    expect(host.output).toBe("structured");
  });

  it("does not report success or plan maintenance when the installed version differs", async () => {
    const host = new FakeUpdateHost();
    host.verified = ok("3.4.0");
    expect(await runUpdate("3.2.1", host)).toMatchObject({
      status: "failed",
      reason: "verification",
      latestVersion: "3.3.0",
      installedVersion: "3.4.0",
    });
    expect(host.maintenanceInspected).toBe(false);
  });

  it("preserves executable verification diagnostics after npm succeeded", async () => {
    const host = new FakeUpdateHost();
    host.verified = err("ENOENT /fixture/scripts/rea.mjs");
    const result = await runUpdate("3.2.1", host);
    expect(result).toMatchObject({ status: "failed", reason: "verification" });
    expect(result).toHaveProperty(
      "remediation",
      expect.stringContaining("ENOENT /fixture/scripts/rea.mjs"),
    );
    expect(host.maintenanceInspected).toBe(false);
  });

  it("returns integration maintenance without applying it", async () => {
    const host = new FakeUpdateHost();
    host.maintenance = {
      status: "planned",
      scope: { clients: ["codex"], skill: false },
      command: ["rea", "setup", "--client", "codex", "--skill=false"],
      plannedActions: [
        {
          id: "configure_client:codex",
          kind: "configure_client",
          label: "Codex",
          target: "/home/.codex/config.toml",
          detail: "Refresh REA",
          external: false,
          operation: "update",
        },
      ],
    };
    expect(await runUpdate("3.2.1", host)).toMatchObject({
      status: "updated",
      maintenance: host.maintenance,
    });
  });

  it("keeps a verified update successful when maintenance planning fails", async () => {
    const host = new FakeUpdateHost();
    host.maintenance = {
      status: "unavailable",
      remediation: "EACCES /home/.codex/config.toml",
    };
    expect(await runUpdate("3.2.1", host)).toMatchObject({
      status: "updated",
      installedVersion: "3.3.0",
      maintenance: host.maintenance,
    });
  });
});

describe("update failures and version boundaries", () => {
  it("normalizes accepted release metadata before installing and comparing versions", async () => {
    const host = new FakeUpdateHost();
    host.release = ok("v3.3.0");
    expect(await runUpdate("3.2.1", host)).toMatchObject({
      status: "updated",
      latestVersion: "3.3.0",
      installedVersion: "3.3.0",
    });
    expect(host.installedVersions).toEqual(["3.3.0"]);
  });

  it("preserves registry errors without installation", async () => {
    const host = new FakeUpdateHost();
    host.release = err({
      kind: "unavailable",
      detail: "npm registry returned HTTP 503",
    });
    const result = await runUpdate("3.2.1", host);
    expect(result).toMatchObject({
      status: "failed",
      reason: "version-check",
      latestVersion: null,
    });
    expect(result).toHaveProperty(
      "remediation",
      expect.stringContaining("HTTP 503"),
    );
    expect(result).toHaveProperty(
      "remediation",
      expect.stringContaining("registry access"),
    );
    expect(host.installedVersions).toEqual([]);
  });

  it.each(["latest", "", "3.3", "$(echo bad)"])(
    "rejects invalid release metadata %s before installation",
    async (version) => {
      const host = new FakeUpdateHost();
      host.release = ok(version);
      expect(await runUpdate("3.2.1", host)).toMatchObject({
        status: "failed",
        reason: "version-check",
      });
      expect(host.installedVersions).toEqual([]);
    },
  );

  it("describes invalid release metadata without blaming registry access", async () => {
    const host = new FakeUpdateHost();
    host.release = err({
      kind: "invalid-metadata",
      detail: "expected one version string",
    });
    const result = await runUpdate("3.2.1", host);
    expect(result).toMatchObject({
      status: "failed",
      reason: "version-check",
      latestVersion: null,
    });
    expect(result).toHaveProperty(
      "remediation",
      expect.stringContaining("expected one version string"),
    );
    expect(result).toHaveProperty(
      "remediation",
      expect.not.stringContaining("registry access"),
    );
    expect(host.installedVersions).toEqual([]);
  });

  it.each([
    ["3.4.0", "3.3.0"],
    ["3.3.0", "3.3.0-rc.1"],
  ])("does not downgrade %s to %s", async (currentVersion, release) => {
    const host = new FakeUpdateHost();
    host.release = ok(release);
    expect(await runUpdate(currentVersion, host)).toMatchObject({
      status: "current",
    });
    expect(host.installedVersions).toEqual([]);
  });

  it("updates a prerelease to its final release", async () => {
    const host = new FakeUpdateHost();
    expect(await runUpdate("3.3.0-rc.1", host)).toMatchObject({
      status: "updated",
      installedVersion: "3.3.0",
    });
  });

  it("refuses to create a global installation for an unrelated invocation", async () => {
    const host = new FakeUpdateHost();
    host.installationResult = undefined;
    const result = await runUpdate("3.2.1", host);
    expect(result).toMatchObject({
      status: "failed",
      reason: "unknown-install-method",
    });
    expect(result).toHaveProperty(
      "remediation",
      expect.not.stringContaining("npm install --global"),
    );
    expect(host.installedVersions).toEqual([]);
  });

  it("reports actual npm failures and skips verification", async () => {
    const host = new FakeUpdateHost();
    host.installResult = err("EACCES /fixture/lib/node_modules/rea-agents");
    const result = await runUpdate("3.2.1", host);
    expect(result).toMatchObject({ status: "failed", reason: "install" });
    expect(result).toHaveProperty(
      "remediation",
      expect.stringContaining("EACCES /fixture/lib/node_modules/rea-agents"),
    );
    expect(host.verifiedInstallation).toBeUndefined();
  });
});

describe("npm installation ownership", () => {
  const host = (root: string, prefix = "/usr/local"): NpmInstallationHost => ({
    canonicalPath: (path) => Promise.resolve(path),
    globalRoot: () => Promise.resolve(root),
    globalPrefix: () => Promise.resolve(prefix),
  });

  it("identifies the global prefix and package root", async () => {
    const packageRoot = "/usr/local/lib/node_modules/rea-agents";
    await expect(
      detectNpmInstallation(packageRoot, host("/usr/local/lib/node_modules")),
    ).resolves.toEqual({ prefix: "/usr/local", packageRoot });
  });

  it("retains the curl installer's custom Unix prefix", async () => {
    const packageRoot = "/home/user/.local/lib/node_modules/rea-agents";
    await expect(
      detectNpmInstallation(packageRoot, host("/usr/local/lib/node_modules")),
    ).resolves.toEqual({ prefix: "/home/user/.local", packageRoot });
  });

  it.each([
    "/work/rea",
    "/work/node_modules/rea-agents",
    "/cache/_npx/abc/node_modules/rea-agents",
  ])("rejects unrelated invocation %s", async (packageRoot) => {
    await expect(
      detectNpmInstallation(packageRoot, host("/usr/local/lib/node_modules")),
    ).resolves.toBeUndefined();
  });

  it("does not trust an unresolvable installation path", async () => {
    const failing = {
      ...host("/usr/local/lib/node_modules"),
      canonicalPath: (): Promise<string> => Promise.reject(new Error("EACCES")),
    };
    await expect(
      detectNpmInstallation(
        "/home/.local/lib/node_modules/rea-agents",
        failing,
      ),
    ).resolves.toBeUndefined();
  });
});
