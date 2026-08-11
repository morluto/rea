import { describe, expect, it } from "vitest";

import {
  registrationPermissionEnvironment,
  runSetup,
  type SetupProgressEvent,
} from "./Setup.js";
import { FakeSetupHost, options } from "./Setup.fixture.js";

describe("setup workflow", () => {
  it("propagates only the explicit non-secret investigation root policy", () => {
    expect(
      registrationPermissionEnvironment({
        REA_INVESTIGATION_INPUT_ROOTS_JSON: '["/approved/apps"]',
        AUTHORIZATION: "secret",
      }),
    ).toEqual({
      REA_INVESTIGATION_INPUT_ROOTS_JSON: '["/approved/apps"]',
    });
    expect(registrationPermissionEnvironment({})).toEqual({});
  });

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
    expect(host.doctorCalls).toBe(1);
  });

  it("treats an empty interactive selection as cancellation", async () => {
    const host = new FakeSetupHost();
    host.clients = [{ name: "codex", configPath: "/codex.toml" }];

    const result = await runSetup(
      { ...options(false), structured: false },
      host,
      () => Promise.resolve({ approved: false, selectedActionIds: [] }),
    );

    expect(result.status).toBe("planned");
    expect(result.plannedActions).toEqual([]);
    expect(result.appliedActions).toEqual([]);
    expect(host.configurations).toBe(0);
    expect(host.skillInstalls).toBe(0);
    expect(host.hopperInstalls).toBe(0);
    expect(host.doctorCalls).toBe(1);
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
});

describe("setup workflow lifecycle and provider planning", () => {
  it("reports append-only lifecycle progress for each selected action", async () => {
    const host = new FakeSetupHost();
    host.hopper = "/Applications/Hopper";
    host.clients = [
      {
        name: "codex",
        displayName: "Codex",
        configPath: "/codex.toml",
      },
    ];
    const progress: SetupProgressEvent[] = [];
    await runSetup(
      { ...options(true), onProgress: (event) => progress.push(event) },
      host,
    );
    expect(progress).toEqual([
      { actionId: "configure_client:codex", label: "Codex", state: "started" },
      {
        actionId: "configure_client:codex",
        label: "Codex",
        state: "completed",
      },
      {
        actionId: "install_skill",
        label: "REA reverse-engineering skill",
        state: "started",
      },
      {
        actionId: "install_skill",
        label: "REA reverse-engineering skill",
        state: "completed",
      },
    ]);
  });

  it("plans and propagates BYO Ghidra without installing software", async () => {
    const host = new FakeSetupHost("linux");
    host.distribution = {
      id: "ubuntu",
      versionId: "24.04",
      packageFamily: "deb",
      supported: true,
    };
    host.ghidra = "/opt/ghidra_12.1.2_PUBLIC";
    host.javaHome = "/usr/lib/jvm/jdk-21";
    host.doctorHealthy = true;
    host.skill = "unchanged";
    host.clients = [{ name: "cursor", configPath: "/cursor.json" }];

    const plan = await runSetup(options(false), host);
    expect(plan.plannedActions.map(({ kind }) => kind)).toEqual([
      "configure_client",
    ]);
    expect(plan.plannedActions[0]?.detail).toContain(
      "GHIDRA_INSTALL_DIR=/opt/ghidra_12.1.2_PUBLIC",
    );
    expect(plan.plannedActions[0]?.detail).toContain(
      "JAVA_HOME=/usr/lib/jvm/jdk-21",
    );
    expect(host.hopperInstalls).toBe(0);
    expect(host.configurations).toBe(0);

    const applied = await runSetup(options(true), host);
    expect(applied.status).toBe("ready");
    expect(host.hopperInstalls).toBe(0);
    expect(host.configuredProviderEnvironments).toContainEqual({
      GHIDRA_INSTALL_DIR: "/opt/ghidra_12.1.2_PUBLIC",
      JAVA_HOME: "/usr/lib/jvm/jdk-21",
    });
  });

  it("reinstalls existing Hopper when explicitly requested", async () => {
    const host = new FakeSetupHost();
    host.hopper = "/Applications/Hopper";
    host.skill = "unchanged";
    host.clients = [{ name: "codex", configPath: "/codex.toml" }];
    host.clientResults.set("codex", { status: "unchanged" });

    const result = await runSetup(options(true, true), host);

    expect(result.plannedActions.map(({ kind }) => kind)).toEqual([
      "install_hopper",
      "configure_client",
    ]);
    expect(result.appliedActions).toEqual(["installed_hopper"]);
    expect(host.hopperInstalls).toBe(1);
    expect(host.hopperReplaceRequests).toEqual([true]);
    expect(host.configurations).toBe(0);
    expect(host.checkedHopperPaths).toEqual(["/manual/Hopper"]);
  });
});
