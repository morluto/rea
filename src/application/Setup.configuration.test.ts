import { describe, expect, it } from "vitest";
import { resolve } from "node:path";

import { FakeSetupHost, options } from "./Setup.fixture.js";
import { runSetup } from "./Setup.js";
import { setupRegistrationCommand } from "./SetupHost.js";

describe("setup workflow", () => {
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
      {
        ...options(true),
        clientIds: [],
        installSkill: false,
        proposeHopper: false,
        readinessScope: { providers: ["hopper"] },
      },
      host,
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
    const result = await runSetup(
      { ...options(true, true), clientIds: [] },
      host,
    );
    expect(result.status).toBe("needs_human");
    expect(result.code).toBe("download_failed");
    expect(result.remediation).toBe("Download failed.");
    expect(host.configurations).toBe(0);
  });

  it("blocks malformed client configuration before Hopper or file mutation", async () => {
    const host = new FakeSetupHost();
    host.clients = [
      { name: "codex", displayName: "Codex", configPath: "/codex.toml" },
    ];
    host.clientInspections.set("codex", {
      status: "invalid",
      remediation: "Repair the existing TOML.",
    });

    const result = await runSetup(
      { ...options(true, true), clientIds: ["codex"] },
      host,
    );

    expect(result.status).toBe("needs_human");
    expect(result.remediation).toBe("Codex: Repair the existing TOML.");
    expect(host.hopperInstalls).toBe(0);
    expect(host.configurations).toBe(0);
    expect(host.skillInstalls).toBe(0);
  });

  it("blocks malformed configuration before unrelated writes with an existing provider", async () => {
    const host = new FakeSetupHost();
    host.hopper = "/Applications/Hopper";
    host.skill = "unchanged";
    host.clients = [
      {
        name: "claude_desktop",
        displayName: "Claude Desktop",
        configPath: "/claude.json",
      },
      { name: "cursor", displayName: "Cursor", configPath: "/cursor.json" },
    ];
    host.clientInspections.set("claude_desktop", {
      status: "invalid",
      remediation: "Repair the existing JSON.",
    });

    const result = await runSetup(
      { ...options(true), clientIds: ["claude_desktop"] },
      host,
    );

    expect(result.status).toBe("needs_human");
    expect(result.remediation).toBe(
      "Claude Desktop: Repair the existing JSON.",
    );
    expect(host.configurations).toBe(0);
    expect(host.skillInstalls).toBe(0);
  });

  it("plans a client update when Hopper installation changes its desired environment", async () => {
    const host = new FakeSetupHost();
    host.clients = [
      { name: "codex", displayName: "Codex", configPath: "/codex.toml" },
    ];
    host.clientInspections.set("codex", { status: "already_current" });

    const result = await runSetup(
      { ...options(false, true), clientIds: ["codex"] },
      host,
    );

    expect(
      result.plannedActions.map(({ id, operation }) => ({
        id,
        operation,
      })),
    ).toContainEqual({
      id: "configure_client:codex",
      operation: "update",
    });
    expect(host.configurations).toBe(0);
  });
});

describe("setup workflow action selection", () => {
  it("executes only actions selected by the interactive adapter", async () => {
    const host = new FakeSetupHost();
    host.hopper = "/Applications/Hopper";
    host.skill = "unchanged";
    host.clients = [
      { name: "codex", displayName: "Codex", configPath: "/codex.toml" },
      { name: "cursor", displayName: "Cursor", configPath: "/cursor.json" },
    ];

    const result = await runSetup(
      { ...options(false), structured: false },
      host,
      () =>
        Promise.resolve({
          approved: true,
          selectedActionIds: ["configure_client:codex"],
        }),
    );

    expect(result.plannedActions.map(({ id }) => id)).toEqual([
      "configure_client:codex",
    ]);
    expect(result.clients).toEqual({ codex: { status: "configured" } });
    expect(host.configurations).toBe(1);
    expect(host.skillInstalls).toBe(0);
  });

  it("preflights only selected clients and offers supported clients without markers", async () => {
    const host = new FakeSetupHost();
    host.hopper = "/Applications/Hopper";
    host.skill = "unchanged";
    host.clients = [];
    host.availableClients = [
      { name: "codex", displayName: "Codex", configPath: "/codex.toml" },
      { name: "cursor", displayName: "Cursor", configPath: "/cursor.json" },
    ];
    host.clientInspections.set("cursor", {
      status: "invalid",
      remediation: "Repair the deselected Cursor configuration.",
    });

    const result = await runSetup(
      { ...options(true), clientIds: ["codex"] },
      host,
    );

    expect(result.status).toBe("ready");
    expect(result.plannedActions.map(({ id }) => id)).toEqual([
      "configure_client:codex",
    ]);
    expect(host.configurations).toBe(1);
    expect(result.clientStates).toMatchObject([
      { client: { name: "codex" }, detected: false, status: "missing" },
      { client: { name: "cursor" }, detected: false, status: "missing" },
    ]);
  });

  it("does not default to a foreign command registered under the rea key", async () => {
    const host = new FakeSetupHost();
    host.hopper = "/Applications/Hopper";
    host.skill = "unchanged";
    host.clients = [{ name: "codex", configPath: "/codex.toml" }];
    host.productRegistrations = [
      {
        client: "codex",
        config_path: "/codex.toml",
        command: ["unrelated-agent", "serve"],
        state: "stale",
        remediation: "Refresh this registration.",
      },
    ];

    const result = await runSetup(options(true), host);

    expect(result.status).toBe("ready");
    expect(result.plannedActions).toEqual([]);
    expect(host.configurations).toBe(0);
    expect(result.clientStates).toMatchObject([
      { client: { name: "codex" }, configured: false },
    ]);
  });

  it("uses a Windows-safe executable command for an explicit client", async () => {
    const host = new FakeSetupHost("win32");
    host.scopedDoctorHealthy = true;
    host.skill = "unchanged";
    host.clients = [{ name: "codex", configPath: "C:\\config\\codex.toml" }];

    const result = await runSetup(
      { ...options(true), clientIds: ["codex"], installSkill: false },
      host,
    );

    expect(result.status).toBe("ready");
    expect(host.configuredCommands).toEqual([
      setupRegistrationCommand("win32"),
    ]);
    expect(setupRegistrationCommand("win32", false)).toEqual([
      process.execPath,
      resolve(process.argv[1] ?? "rea"),
      "mcp",
    ]);
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
    const result = await runSetup(
      { ...options(true), clientIds: ["internal_client_key"] },
      host,
    );
    expect(result.status).toBe("needs_human");
    expect(result.remediation).toBe(message);
    expect(result.remediation).not.toContain("internal_client_key");
  });
});
