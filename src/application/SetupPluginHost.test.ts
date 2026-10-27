import { expect, it } from "vitest";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { runSetup } from "./Setup.js";
import { FakeSetupHost, options } from "./Setup.fixture.js";
import { withPluginSetup } from "./SetupPluginHost.js";
import type { RegistrationRunnerLauncher } from "./SetupRegistrationPrewarm.js";

const fixture = (clientId = "codex", platform: NodeJS.Platform = "win32") => {
  const base = new FakeSetupHost(platform);
  base.clients = [
    { name: clientId, configPath: "/fixture/config", format: "toml" },
  ];
  base.clientInspections.set(clientId, { status: "create" });
  base.productRegistrations = [
    {
      client: clientId,
      config_path: "/fixture/config",
      command: [],
      state: "missing",
      remediation: "Install REA.",
    },
  ];
  base.doctorHealthy = true;
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  let installed = false;
  let enabled = false;
  let failure: string | undefined;
  let inspectionFailure: string | undefined;
  let inventory: string | undefined;
  let failReadback = false;
  let interruptAt: number | undefined;
  let doctorsAtInterrupt = 0;
  const launch: RegistrationRunnerLauncher = async (command, args) => {
    calls.push({ command, args });
    if (calls.length === interruptAt) {
      doctorsAtInterrupt = base.doctorCalls;
      return {
        exitCode: 1,
        signal: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        interruptedSignal: "SIGINT",
        cleanupFailure: "controlled cleanup refusal",
      };
    }
    const listing = args[1] === "list";
    if (listing && inspectionFailure !== undefined)
      return {
        exitCode: 1,
        signal: null,
        stdout: "",
        stderr: inspectionFailure,
        timedOut: false,
      };
    if (!listing && failure !== undefined)
      return {
        exitCode: 1,
        signal: null,
        stdout: "",
        stderr: failure,
        timedOut: false,
      };
    if (!listing && args[1] !== "marketplace") {
      installed = true;
      enabled = true;
    }
    const entries =
      installed && !failReadback
        ? command === "codex"
          ? [{ pluginId: "rea@rea", name: "rea", enabled }]
          : [{ id: "rea@rea", scope: "user", enabled }]
        : [];
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      stderr: "",
      stdout: listing
        ? (inventory ??
          JSON.stringify(
            command === "codex" ? { installed: entries } : entries,
          ))
        : "Installed",
    };
  };
  return {
    base,
    calls,
    host: (preferPlugins = true) =>
      withPluginSetup(base, {}, preferPlugins, launch),
    setupOptions: {
      ...options(true),
      clientIds: [clientId],
      proposeHopper: false,
    },
    mutations: () => calls.filter(({ args }) => args[1] !== "list"),
    installed: (value = true, isEnabled = true) => {
      installed = value;
      enabled = isEnabled;
    },
    fail: (message: string) => {
      failure = message;
    },
    inspectionFailure: (message: string) => {
      inspectionFailure = message;
    },
    inventory: (value: string) => {
      inventory = value;
    },
    failReadback: () => {
      failReadback = true;
    },
    interrupt: (at: number) => {
      interruptAt = at;
    },
    doctorsAtInterrupt: () => doctorsAtInterrupt,
  };
};

it.each([true, false])(
  "does not inspect Claude on a failed preapproval plan (dryRun=%s)",
  async (dryRun) => {
    const f = fixture("claude_code");
    f.base.clients = [
      ...f.base.clients,
      { name: "cursor", configPath: "/fixture/cursor.json", format: "json" },
    ];
    f.base.clientInspections.set("cursor", {
      status: "invalid",
      remediation: "Malformed Cursor configuration",
    });
    const result = await runSetup(
      {
        ...f.setupOptions,
        approved: false,
        dryRun,
        clientIds: ["claude_code", "cursor"],
        readinessScope: {
          clients: ["claude_code", "cursor"],
          providers: [],
          skill: true,
        },
      },
      f.host(),
    );
    expect(result.status).toBe("needs_human");
    expect(result.remediation).toContain("Malformed Cursor");
    expect(f.calls).toEqual([]);
  },
);

it.each(["codex", "claude_code"])(
  "permits plugin-only %s setup when the direct launcher is private",
  async (id) => {
    const f = fixture(id);
    f.base.registrationCommandBlocker = "Install REA outside the package.";
    expect((await runSetup(f.setupOptions, f.host())).status).toBe("ready");
    expect(f.mutations()).toHaveLength(2);
    expect(f.base.configurations).toBe(0);
  },
);

it("retains the private-launcher blocker for mixed plugin and direct setup", async () => {
  const f = fixture("claude_code");
  f.base.registrationCommandBlocker = "Install REA outside the package.";
  f.base.clients = [
    ...f.base.clients,
    { name: "cursor", configPath: "/fixture/cursor.json", format: "json" },
  ];
  const result = await runSetup(
    { ...f.setupOptions, clientIds: ["claude_code", "cursor"] },
    f.host(),
  );
  expect(result.status).toBe("needs_human");
  expect(result.remediation).toBe(f.base.registrationCommandBlocker);
  expect(f.calls).toEqual([]);
  expect(f.base.configurations).toBe(0);
});

it.each([1, 2, 3, 4, 5])(
  "stops after a plugin interrupt at command %s and still closes setup",
  async (at) => {
    const f = fixture("claude_code");
    f.base.clients = [
      ...f.base.clients,
      { name: "cursor", configPath: "/fixture/cursor.json", format: "json" },
    ];
    let closed = false;
    const host = f.host();
    const close = host.close?.bind(host);
    host.close = async () => {
      closed = true;
      return close?.();
    };
    f.interrupt(at);
    await expect(
      runSetup(
        { ...f.setupOptions, clientIds: ["claude_code", "cursor"] },
        host,
      ),
    ).rejects.toBeInstanceOf(AnalysisCancelledError);
    expect(closed).toBe(true);
    expect(f.calls).toHaveLength(at);
    expect(f.base.doctorCalls).toBe(f.doctorsAtInterrupt());
    // The final verification happens after the earlier approved Cursor write.
    expect(f.base.configurations).toBe(at === 5 ? 1 : 0);
  },
);

it.each(["codex", "claude_code"])(
  "installs %s through its own marketplace without direct MCP or skill writes",
  async (id) => {
    const f = fixture(id);
    const result = await runSetup(f.setupOptions, f.host());
    expect(result.status).toBe("ready");
    expect(f.mutations().map(({ args }) => args)).toEqual([
      ["plugin", "marketplace", "add", "morluto/rea"],
      [
        "plugin",
        id === "codex" ? "add" : "install",
        "rea@rea",
        ...(id === "claude_code" ? ["--scope", "user"] : []),
      ],
    ]);
    expect(f.base.configurations).toBe(0);
    expect(f.base.skillInstalls).toBe(0);
    expect(result.doctor.scope.plugin_clients).toEqual([id]);
    expect(result.plannedActions[0]).toMatchObject({
      external: true,
      operation: "install",
    });
    const again = await runSetup(
      { ...f.setupOptions, approved: false },
      f.host(),
    );
    expect(again.status).toBe(id === "codex" ? "ready" : "needs_confirmation");
    if (id === "codex") expect(again.plannedActions).toEqual([]);
    expect(f.mutations()).toHaveLength(2);
  },
);

it.each(["plan", "dry-run", "decline"])(
  "makes no changes during %s",
  async (mode) => {
    const f = fixture();
    const result = await runSetup(
      {
        ...f.setupOptions,
        approved: false,
        structured: mode !== "decline",
        dryRun: mode === "dry-run",
      },
      f.host(),
      mode === "decline" ? async () => false : undefined,
    );
    expect(result.status).toBe(
      mode === "plan"
        ? "needs_confirmation"
        : mode === "dry-run"
          ? "planned"
          : "cancelled",
    );
    expect(f.mutations()).toEqual([]);
    expect(f.base.configurations + f.base.skillInstalls).toBe(0);
  },
);

it("does not launch Claude Code's migrating inventory before approval", async () => {
  const f = fixture("claude_code");
  const result = await runSetup(
    { ...f.setupOptions, approved: false, dryRun: true },
    f.host(),
  );
  expect(result.status).toBe("planned");
  expect(f.calls).toEqual([]);
});

it("preserves an existing direct registration", async () => {
  const f = fixture();
  f.base.clientInspections.set("codex", { status: "update" });
  f.base.productRegistrations = [
    {
      client: "codex",
      config_path: "/fixture/config",
      command: ["node", "rea.mjs", "mcp"],
      state: "aligned",
      remediation: null,
    },
  ];
  const result = await runSetup(f.setupOptions, f.host());
  expect(result.status).toBe("ready");
  expect(f.calls).toEqual([]);
  expect(f.base.configurations).toBe(1);
  expect(f.base.skillInstalls).toBe(1);
});

it("does not mistake unrelated plugin-manager settings for a direct REA registration", async () => {
  const f = fixture();
  f.base.clientInspections.set("codex", { status: "update" });
  expect((await runSetup(f.setupOptions, f.host())).status).toBe("ready");
  expect(f.mutations()).toHaveLength(2);
  expect(f.base.configurations).toBe(0);
});

it.each(["spawn codex ENOENT", "unknown subcommand 'plugin'"])(
  "uses direct setup when plugin commands are unavailable: %s",
  async (reason) => {
    const f = fixture();
    f.inspectionFailure(reason);
    expect((await runSetup(f.setupOptions, f.host())).status).toBe("ready");
    expect(f.mutations()).toEqual([]);
    expect(f.base.configurations).toBe(1);
    expect(f.base.skillInstalls).toBe(1);
  },
);

it("blocks inventory access errors rather than treating them as an absent plugin", async () => {
  const f = fixture();
  f.inspectionFailure("permission denied");
  expect((await runSetup(f.setupOptions, f.host())).status).toBe("needs_human");
  expect(f.mutations()).toEqual([]);
  expect(f.base.configurations).toBe(0);
});

it("keeps other clients' skill installations when a plugin client shares setup", async () => {
  const f = fixture();
  f.base.clients = [
    ...f.base.clients,
    { name: "cursor", configPath: "/fixture/cursor.json", format: "json" },
  ];
  const result = await runSetup(
    { ...f.setupOptions, clientIds: ["codex", "cursor"] },
    f.host(),
  );
  expect(result.status).toBe("ready");
  expect(f.base.configurations).toBe(1);
  expect(f.base.skillInstalls).toBe(1);
  expect(f.base.skillDirectoryValidations).toContainEqual(["cursor"]);
  expect(f.base.doctorScopes.at(-1)?.clients).toEqual(["cursor"]);
});

it("enables a disabled installation without reinstalling its marketplace", async () => {
  const f = fixture();
  f.installed(true, false);
  expect((await runSetup(f.setupOptions, f.host())).status).toBe("ready");
  expect(f.mutations().map(({ args }) => args)).toEqual([
    ["plugin", "enable", "rea@rea"],
  ]);
});

it("keeps client errors visible without falling back to a duplicate registration", async () => {
  const f = fixture();
  f.fail("permission denied");
  const result = await runSetup(f.setupOptions, f.host());
  expect(result.status).toBe("needs_human");
  expect(result.clients.codex).toMatchObject({
    status: "failed",
    reason: "plugin",
  });
  expect(f.base.configurations + f.base.skillInstalls).toBe(0);
});

it("requires installed-and-enabled readback after successful commands", async () => {
  const f = fixture();
  f.failReadback();
  const result = await runSetup(f.setupOptions, f.host());
  expect(result.status).toBe("needs_human");
  expect(result.remediation).toContain("did not confirm");
  expect(f.base.configurations).toBe(0);
});

it.each([
  "not json",
  '{"installed":[{"pluginId":"rea@elsewhere","name":"rea","enabled":true}]}',
])("refuses unknown or conflicting plugin state: %s", async (inventory) => {
  const f = fixture();
  f.inventory(inventory);
  expect((await runSetup(f.setupOptions, f.host())).status).toBe("needs_human");
  expect(f.mutations()).toEqual([]);
  expect(f.base.configurations + f.base.skillInstalls).toBe(0);
});

it("preserves custom provider registration settings", async () => {
  const f = fixture();
  f.base.ghidra = "/custom/ghidra";
  expect((await runSetup(f.setupOptions, f.host())).status).toBe("ready");
  expect(f.mutations()).toEqual([]);
  expect(f.base.configurations).toBe(1);
  expect(f.base.configuredProviderEnvironments[0]).toMatchObject({
    GHIDRA_INSTALL_DIR: "/custom/ghidra",
  });
});

it("does not launch plugin commands when direct installation is explicitly requested", async () => {
  const f = fixture();
  f.installed();
  const result = await runSetup(f.setupOptions, f.host(false));
  expect(result.status).toBe("ready");
  expect(f.calls).toEqual([]);
  expect(f.base.configurations).toBe(1);
});

it("rechecks direct configuration after approval before installing a plugin", async () => {
  const f = fixture();
  const result = await runSetup(
    { ...f.setupOptions, approved: false, structured: false },
    f.host(),
    async () => {
      f.base.clientInspections.set("codex", { status: "already_current" });
      return true;
    },
  );
  expect(result.status).toBe("needs_human");
  expect(f.mutations()).toEqual([]);
});

it("selects the plugin after an interactive user declines the optional Hopper installation", async () => {
  const f = fixture("codex", "darwin");
  const result = await runSetup(
    {
      ...options(false),
      structured: false,
      proposeHopper: true,
    },
    f.host(),
    async () => ({
      approved: true,
      selectedActionIds: ["configure_client:codex"],
    }),
  );
  expect(result.status).toBe("ready");
  expect(result.doctor.scope.plugin_clients).toEqual(["codex"]);
  expect(
    f.base.hopperInstalls + f.base.configurations + f.base.skillInstalls,
  ).toBe(0);
  expect(f.mutations()).toHaveLength(2);
});
