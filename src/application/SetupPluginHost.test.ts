import { expect, it } from "vitest";
import { setupPluginOperation } from "../../tests/fixtures/setupPluginProtocol.mjs";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { runSetup } from "./Setup.js";
import { FakeSetupHost, options } from "./Setup.fixture.js";
import { preferPluginSetup, withPluginSetup } from "./SetupPluginHost.js";
import type { SetupPluginCommandLauncher } from "./SetupPluginCommand.js";
import type { SupportedClientName } from "./SupportedClients.js";
import { supportedClientRegistrationProfile } from "../../tests/fixtures/clientRegistrationProfile.js";

it.each([
  { client: "cursor", args: ["plugin", "list", "--json"] },
  { client: "codex", args: ["plugin", "remove", "rea@rea"] },
  { client: "codex", args: ["plugin", "list", "--xml"] },
  { client: "codex", args: ["plugin", "marketplace", "add", "other/repo"] },
  { client: "claude", args: ["plugin", "add", "rea@rea"] },
  {
    client: "claude",
    args: ["plugin", "install", "rea@rea", "--scope", "project"],
  },
  { client: "codex", args: ["plugin", "enable", "rea@rea", "--force"] },
])("rejects an unmodeled plugin fixture command: %j", ({ client, args }) => {
  expect(() => setupPluginOperation(client, args)).toThrow(/Unmodeled/u);
});

const fixture = (clientId = "codex", platform: NodeJS.Platform = "win32") => {
  const base = new FakeSetupHost(platform);
  base.clients = [
    {
      name: clientId,
      configPath: "/fixture/config",
      format: "toml",
      registrationProfile: supportedClientRegistrationProfile(
        clientId as SupportedClientName,
      ),
    },
  ];
  base.clientInspections.set(clientId, { status: "create" });
  base.productRegistrations = [
    {
      client: clientId,
      config_path: "/fixture/config",
      command: [],
      command_identity: "unknown",
      state: "missing",
      remediation: "Install REA.",
    },
  ];
  base.doctorHealthy = true;
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  let nodeVersion: string | undefined = "v24.22.1";
  let dropNodeOnInstall = false;
  let installed = false;
  let enabled = false;
  let failure: string | undefined;
  let inspectionFailure: string | undefined;
  let inventory: string | undefined;
  let failReadback = false;
  let interruptAt: number | undefined;
  let doctorsAtInterrupt = 0;
  const launch: SetupPluginCommandLauncher = async (command, args) => {
    if (command === "node")
      return {
        exitCode: nodeVersion === undefined ? 1 : 0,
        signal: null,
        stdout: nodeVersion ?? "",
        stderr: "",
        timedOut: false,
        ...(nodeVersion === undefined
          ? { spawnError: "ENOENT: node missing" }
          : {}),
      };
    calls.push({ command, args });
    const operation = setupPluginOperation(command, args);
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
    const listing = operation === "list";
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
    if (operation === "enable") expect(installed).toBe(true);
    if (operation === "install" || operation === "enable") {
      installed = true;
      enabled = true;
      if (dropNodeOnInstall) nodeVersion = undefined;
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
    host: (
      preferPlugins = true,
      environment: Readonly<NodeJS.ProcessEnv> = {},
    ) => withPluginSetup(base, environment, { preferPlugins }, launch),
    nodeDisappearsOnInstall: () => {
      dropNodeOnInstall = true;
    },
    node: (version: string | undefined) => {
      nodeVersion = version;
    },
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
      {
        name: "gemini_cli",
        configPath: "/fixture/gemini.json",
        format: "json",
        registrationProfile: supportedClientRegistrationProfile("gemini_cli"),
      },
    ];
    f.base.clientInspections.set("gemini_cli", {
      status: "invalid",
      remediation: "Malformed Gemini configuration",
    });
    const result = await runSetup(
      {
        ...f.setupOptions,
        approved: false,
        dryRun,
        clientIds: ["claude_code", "gemini_cli"],
        readinessScope: {
          clients: ["claude_code", "gemini_cli"],
          providers: [],
          skill: true,
        },
      },
      f.host(),
    );
    expect(result.status).toBe("needs_human");
    expect(result.remediation).toContain("Malformed Gemini");
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
    {
      name: "gemini_cli",
      configPath: "/fixture/gemini.json",
      format: "json",
      registrationProfile: supportedClientRegistrationProfile("gemini_cli"),
    },
  ];
  const result = await runSetup(
    { ...f.setupOptions, clientIds: ["claude_code", "gemini_cli"] },
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
      {
        name: "gemini_cli",
        configPath: "/fixture/gemini.json",
        format: "json",
        registrationProfile: supportedClientRegistrationProfile("gemini_cli"),
      },
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
        { ...f.setupOptions, clientIds: ["claude_code", "gemini_cli"] },
        host,
      ),
    ).rejects.toBeInstanceOf(AnalysisCancelledError);
    expect(closed).toBe(true);
    expect(f.calls).toHaveLength(at);
    expect(f.base.doctorCalls).toBe(f.doctorsAtInterrupt());
    // The final verification happens after the earlier approved Gemini write.
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
      command_identity: "owned",
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
  "uses direct setup without standalone Node when plugin commands are unavailable: %s",
  async (reason) => {
    const f = fixture();
    f.inspectionFailure(reason);
    f.node(undefined);
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
    {
      name: "gemini_cli",
      configPath: "/fixture/gemini.json",
      format: "json",
      registrationProfile: supportedClientRegistrationProfile("gemini_cli"),
    },
  ];
  const result = await runSetup(
    { ...f.setupOptions, clientIds: ["codex", "gemini_cli"] },
    f.host(),
  );
  expect(result.status).toBe("ready");
  expect(f.base.configurations).toBe(1);
  expect(f.base.skillInstalls).toBe(1);
  expect(f.base.skillDirectoryValidations).toContainEqual(["gemini_cli"]);
  expect(f.base.doctorScopes.at(-1)?.clients).toEqual(["gemini_cli"]);
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
  expect(
    (
      await runSetup(
        f.setupOptions,
        f.host(true, { GHIDRA_INSTALL_DIR: "/custom/ghidra" }),
      )
    ).status,
  ).toBe("ready");
  expect(f.mutations()).toEqual([]);
  expect(f.base.configurations).toBe(1);
  expect(f.base.configuredProviderEnvironments[0]).toMatchObject({
    GHIDRA_INSTALL_DIR: "/custom/ghidra",
  });
});

it.each([
  {
    label: "--tool-catalog-profile hot-cold",
    options: { toolCatalogProfile: "hot-cold" },
  },
  {
    label: "--tool-catalog-profile full",
    options: { toolCatalogProfile: "full" },
  },
  { label: "--tool-families", options: { toolFamilies: "session" } },
  { label: "--desktop-build", options: { desktopBuild: true } },
  { label: "--install-agentenv", options: { installAgentenv: true } },
  {
    label: "--desktop-build --install-agentenv",
    options: { desktopBuild: true, installAgentenv: true },
  },
  { label: "--skill=false", options: { skill: false } },
  { label: "--skill-client", options: { skillClientIds: ["shared"] } },
])("keeps $label on the direct registration path", ({ options }) => {
  expect(preferPluginSetup(options)).toBe(false);
});

it("prefers plugins when no registration settings need the direct path", () => {
  expect(preferPluginSetup({})).toBe(true);
});

it("saves --tool-catalog-profile hot-cold on the direct path instead of a plugin", async () => {
  const f = fixture();
  const selection = { toolCatalogProfile: "hot-cold" as const };
  expect(preferPluginSetup(selection)).toBe(false);
  const result = await runSetup(
    { ...f.setupOptions, ...selection },
    f.host(preferPluginSetup(selection)),
  );
  expect(result.status).toBe("ready");
  expect(f.mutations()).toEqual([]);
  expect(f.base.configurations).toBe(1);
  expect(f.base.configuredProviderEnvironments[0]).toMatchObject({
    REA_MCP_TOOL_CATALOG_PROFILE: "hot-cold",
  });
  expect(result.doctor.scope.plugin_clients).toBeUndefined();
});

it("cannot persist a selected catalog profile through the plugin route", async () => {
  const f = fixture();
  const result = await runSetup(
    { ...f.setupOptions, toolCatalogProfile: "hot-cold" },
    f.host(true),
  );
  expect(result.status).toBe("ready");
  expect(f.mutations()).toHaveLength(2);
  expect(f.base.configurations).toBe(0);
  expect(f.base.configuredProviderEnvironments).toEqual([]);
});

it("saves desktop-build client environments on the direct path instead of a plugin", async () => {
  const f = fixture();
  const archive = "/fixture/cache/rea-build.tar.xz";
  const settings = {
    REA_AGENT_ENV_COMMAND: "/fixture/bin/agent-env",
    REA_DOCKER_COMMAND: "/usr/bin/docker",
    REA_BUILD_COMPUTER_REA_ARCHIVE: archive,
  };
  Object.assign(f.base, {
    desktopBuild: {
      facts: () =>
        Promise.resolve({
          settings,
          selected: [],
          archive,
          archivePacked: true,
          agentEnvVersion: "0.9.1485",
          recorded: {},
        }),
      packRuntime: () => Promise.resolve(undefined),
      installAgentenv: () => Promise.resolve(undefined),
    },
  });
  const selection = { desktopBuild: true, installAgentenv: true };
  expect(preferPluginSetup(selection)).toBe(false);
  const result = await runSetup(
    {
      ...f.setupOptions,
      ...selection,
      readinessScope: {
        clients: ["codex"],
        providers: ["desktop_build"],
        skill: true,
      },
    },
    f.host(preferPluginSetup(selection)),
  );
  expect(result.status).toBe("ready");
  expect(f.mutations()).toEqual([]);
  expect(f.base.configurations).toBe(1);
  expect(f.base.configuredProviderEnvironments[0]).toMatchObject(settings);
  expect(result.doctor.scope.plugin_clients).toBeUndefined();
});

it("cannot persist desktop-build client environments through the plugin route", async () => {
  const f = fixture();
  const archive = "/fixture/cache/rea-build.tar.xz";
  Object.assign(f.base, {
    desktopBuild: {
      facts: () =>
        Promise.resolve({
          settings: {
            REA_AGENT_ENV_COMMAND: "/fixture/bin/agent-env",
            REA_DOCKER_COMMAND: "/usr/bin/docker",
            REA_BUILD_COMPUTER_REA_ARCHIVE: archive,
          },
          selected: [],
          archive,
          archivePacked: true,
          agentEnvVersion: "0.9.1485",
          recorded: {},
        }),
      packRuntime: () => Promise.resolve(undefined),
      installAgentenv: () => Promise.resolve(undefined),
    },
  });
  const result = await runSetup(
    {
      ...f.setupOptions,
      desktopBuild: true,
      installAgentenv: true,
      readinessScope: {
        clients: ["codex"],
        providers: ["desktop_build"],
        skill: true,
      },
    },
    f.host(true),
  );
  expect(result.status).toBe("ready");
  expect(f.mutations()).toHaveLength(2);
  expect(f.base.configurations).toBe(0);
  expect(f.base.configuredProviderEnvironments).toEqual([]);
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

it("requires a fresh plan when the plugin is removed while approval is open", async () => {
  const f = fixture();
  f.installed(true, false);
  const result = await runSetup(
    { ...f.setupOptions, approved: false, structured: false },
    f.host(),
    async () => {
      f.installed(false, false);
      return true;
    },
  );
  expect(result.status).toBe("needs_human");
  expect(result.remediation).toContain("fresh plan");
  expect(result.remediation).toContain("no marketplace or install commands");
  expect(f.mutations()).toEqual([]);
  expect(f.base.configurations + f.base.skillInstalls).toBe(0);
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

it.each(["codex", "claude_code"])(
  "keeps an installed %s plugin after Hopper is discovered on a rerun",
  async (id) => {
    const f = fixture(id);
    expect((await runSetup(f.setupOptions, f.host())).status).toBe("ready");
    f.base.hopper = "/Applications/Hopper.app/Contents/MacOS/Hopper";
    expect((await runSetup(f.setupOptions, f.host())).status).toBe("ready");
    expect(f.base.configurations + f.base.skillInstalls).toBe(0);
    expect(f.mutations()).toHaveLength(2);
  },
);
it.each([undefined, "v20.0.0", "invalid"])(
  "does not install a plugin or report readiness without a supported standalone Node (%s)",
  async (version) => {
    const f = fixture("claude_code");
    f.node(version);
    const result = await runSetup(f.setupOptions, f.host());
    expect(result.status).toBe("needs_human");
    expect(result.remediation).toContain("Node");
    expect(f.calls).toEqual([]);
    expect(f.base.configurations + f.base.skillInstalls).toBe(0);
  },
);
it("reports a plugin's Node prerequisite disappearing after installation", async () => {
  const f = fixture();
  expect((await runSetup(f.setupOptions, f.host())).status).toBe("ready");
  f.node(undefined);
  const result = await runSetup(f.setupOptions, f.host());
  expect(result.status).toBe("needs_human");
  expect(f.base.configurations).toBe(0);
});

it("readiness retains the Node failure when it disappears during plugin installation", async () => {
  const f = fixture();
  f.nodeDisappearsOnInstall();
  const result = await runSetup(f.setupOptions, f.host());
  expect(result.status).toBe("needs_human");
  expect(result.doctor.healthy).toBe(false);
  expect(result.remediation).toContain("standalone");
  expect(result.remediation).toContain("Node");
  expect(result.doctor).toMatchObject({
    pluginChecks: [
      {
        name: "plugin:codex",
        ok: false,
        detail: expect.stringContaining("standalone"),
      },
    ],
  });
  expect(f.base.configurations + f.base.skillInstalls).toBe(0);
});
