import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  clientConfigurationRecordSchema,
  parseClientConfiguration,
} from "../../../src/application/ClientConfigurationDocument.js";
import { parseGooseConfigurationYaml } from "../../../src/application/GooseConfigurationYaml.js";

import { currentClientRegistrationCommand } from "../../../src/application/ClientRegistrationIdentity.js";
import {
  readClientRegistrationInspections,
  readClientRegistrationStatuses,
} from "../../../src/application/ClientRegistrationStatus.js";
import { registerMcpClients } from "../../../src/application/McpClientRegistration.js";
import { resolveMcpRegistrationClients } from "../../../src/application/McpRegistrationCatalog.js";
import {
  clientConfigurationAligned,
  configureClientConfiguration,
  inspectClientConfiguration,
} from "../../../src/application/SetupClientConfiguration.js";
import { supportedClients } from "../../../src/application/SupportedClients.js";
import { detectClients } from "../../../src/application/SetupHost.js";
import {
  runUninstall,
  systemUninstallHost,
  type UninstallFileSystem,
} from "../../../src/application/Uninstall.js";
import { ClientConfigurationPublication } from "../../../src/application/ClientConfigurationPublication.js";
import { existingMaintenanceScope } from "../../../src/application/UpdateMaintenance.js";
import { ArtifactResourceScope } from "../../../src/artifacts/ArtifactResourceScope.js";
import { OwnedFileHandle } from "../../../src/filesystem/OwnedFileHandle.js";
import { clearClientLocationEnvironment } from "../../fixtures/clientEnvironment.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const platform = process.platform;
const command = currentClientRegistrationCommand({ platform });

beforeEach(clearClientLocationEnvironment);
afterEach(() => vi.unstubAllEnvs());

// Each client REA registers through `rea mcp add` is one client-table row, so
// doctor, update and uninstall see what mcp add wrote (#7181).
it.each([
  { agent: "cline", client: "cline_vscode" },
  { agent: "kiro-cli", client: "kiro" },
  { agent: "mastracode", client: "mastracode" },
  { agent: "zed", client: "zed" },
  { agent: "amp", client: "amp" },
  { agent: "mcporter", client: "mcporter" },
  { agent: "fx", client: "fx" },
  { agent: "junie", client: "junie" },
  { agent: "goose", client: "goose" },
  { agent: "kilo", client: "kilo" },
])(
  "inspects, refreshes and removes the $agent registration that mcp add wrote as $client",
  async ({ agent, client }) => {
    const home = await createTestTempDirectory(`rea-mcp-add-${client}-`);
    const environment = {};
    // Goose's system layer stays inside the temporary home.
    const systemPaths = { gooseSystemConfig: join(home, "goose-system.yaml") };
    const resources = new ArtifactResourceScope();
    const selected = await resolveMcpRegistrationClients(
      {
        agents: [agent],
        global: true,
        cwd: home,
        home,
        platform,
        environment,
        systemPaths,
      },
      resources,
    );
    if (!selected.ok) throw selected.error;
    const row = supportedClients(home, platform, environment, systemPaths).find(
      ({ name }) => name === client,
    );
    if (row === undefined) throw new Error(`${client} has no table row`);
    expect(selected.value.map(({ configPath }) => configPath)).toEqual([
      row.configPath,
    ]);

    // An older, still REA-owned launcher: the package runner form that
    // current setup migrates to the selected installation.
    const legacy = { command: "npx", args: ["-y", "rea-agents@1.0.0", "mcp"] };
    const [outcome] = await registerMcpClients(
      selected.value,
      legacy,
      undefined,
      resources,
    );
    expect(outcome).toMatchObject({
      status: "completed",
      result: { ok: true, value: { status: "configured" } },
    });
    const status = async () =>
      (
        await readClientRegistrationStatuses(home, command[1], {
          platform,
          environment,
          systemPaths,
        })
      ).find((entry) => entry.client === client);

    // Doctor reads the registration from the same row.
    expect(await status()).toMatchObject({
      config_path: row.configPath,
      command: [legacy.command, ...legacy.args],
      command_identity: "owned",
      state: "stale",
    });
    // Update selects it, and setup refreshes it to the current launcher.
    await expect(
      existingMaintenanceScope(home, command[1] ?? "", environment, {
        systemPaths,
      }),
    ).resolves.toMatchObject({ clients: [client] });
    await expect(
      inspectClientConfiguration(row, {}, command),
    ).resolves.toMatchObject({ status: "update" });
    await expect(
      configureClientConfiguration(row, {}, command),
    ).resolves.toMatchObject({ status: "configured" });
    expect(await status()).toMatchObject({
      command: [...command],
      command_identity: "owned",
    });

    // Uninstall removes only REA's row and keeps the file.
    const uninstall = await runUninstall(
      false,
      systemUninstallHost(home, undefined, environment, platform, systemPaths),
    );
    expect(uninstall.items).toContainEqual(
      expect.objectContaining({ name: client, status: "removed" }),
    );
    const remaining = parseClientConfiguration(
      await readFile(row.configPath, "utf8"),
      row.format,
    );
    expect(remaining.servers).not.toHaveProperty("rea");
    if (row.privateProfile !== undefined && platform !== "win32")
      expect((await stat(row.configPath)).mode & 0o777).toBe(0o600);
  },
);

it("registers Amp in settings.jsonc when that is Amp's only settings file", async () => {
  const home = await createTestTempDirectory("rea-amp-jsonc-");
  const directory = join(home, ".config", "amp");
  const jsonc = join(directory, "settings.jsonc");
  await mkdir(directory, { recursive: true });
  await writeFile(jsonc, '{\n  // keep\n  "amp.theme": "dark"\n}\n');
  const resources = new ArtifactResourceScope();
  const selected = await resolveMcpRegistrationClients(
    {
      agents: ["amp"],
      global: true,
      cwd: home,
      home,
      platform,
      environment: {},
    },
    resources,
  );
  if (!selected.ok) throw selected.error;
  expect(selected.value[0]?.configPath).toBe(jsonc);
  await registerMcpClients(
    selected.value,
    { command: command[0] ?? "", args: command.slice(1) },
    undefined,
    resources,
  );
  const text = await readFile(jsonc, "utf8");
  expect(text).toContain("// keep");
  expect(parseClientConfiguration(text, "amp").servers).toHaveProperty("rea");

  // With both files present, which one Amp reads is unknown.
  await writeFile(join(directory, "settings.json"), "{}\n");
  const row = supportedClients(home, platform, {}).find(
    ({ name }) => name === "amp",
  );
  expect(row?.configPathError).toContain("Both");
  const ambiguous = await resolveMcpRegistrationClients(
    {
      agents: ["amp"],
      global: true,
      cwd: home,
      home,
      platform,
      environment: {},
    },
    resources,
  );
  expect(ambiguous.ok).toBe(false);
});

it.each([
  { client: "cline_vscode_insiders", folder: "Code - Insiders" },
  { client: "cline_vscodium", folder: "VSCodium" },
  { client: "cline_cursor", folder: "Cursor" },
  { client: "cline_windsurf", folder: "Windsurf" },
])(
  "manages Cline's registration in $folder's global storage",
  async ({ client, folder }) => {
    const home = await createTestTempDirectory(`rea-${client}-`);
    const row = supportedClients(home, "linux", {}).find(
      ({ name }) => name === client,
    );
    if (row === undefined) throw new Error(`${client} has no table row`);
    const settings = join(
      home,
      ".config",
      folder,
      "User",
      "globalStorage",
      "saoudrizwan.claude-dev",
      "settings",
    );
    expect(row.configPath).toBe(join(settings, "cline_mcp_settings.json"));
    // VSCODE_PORTABLE names VS Code's own portable data, not this editor's.
    expect(
      supportedClients(home, "linux", {
        VSCODE_PORTABLE: join(home, "portable"),
      }).find(({ name }) => name === client)?.configPath,
    ).toBe(row.configPath);
    expect(
      supportedClients(home, "linux", {
        VSCODE_PORTABLE: join(home, "portable"),
      }).find(({ name }) => name === "cline_vscode")?.configPath,
    ).toBe(
      join(
        home,
        "portable",
        "user-data",
        "User",
        "globalStorage",
        "saoudrizwan.claude-dev",
        "settings",
        "cline_mcp_settings.json",
      ),
    );
    // Detected only where that editor's Cline extension has run.
    expect(
      (await detectClients(home, "linux", {})).map(({ name }) => name),
    ).not.toContain(client);
    await mkdir(settings, { recursive: true });
    expect(
      (await detectClients(home, "linux", {})).map(({ name }) => name),
    ).toContain(client);

    await expect(
      configureClientConfiguration(row, {}, command),
    ).resolves.toMatchObject({ status: "configured" });
    const status = (
      await readClientRegistrationStatuses(home, command[1], {
        platform: "linux",
        environment: {},
      })
    ).find(({ client: name }) => name === client);
    expect(status).toMatchObject({ command_identity: "owned" });
    const uninstall = await runUninstall(
      false,
      systemUninstallHost(home, undefined, {}, "linux"),
    );
    expect(uninstall.items).toContainEqual(
      expect.objectContaining({ name: client, status: "removed" }),
    );
  },
);

it("selects the Zed configuration a Linux Flatpak Zed reads", async () => {
  const home = await createTestTempDirectory("rea-zed-flatpak-");
  const zed = (env: NodeJS.ProcessEnv = {}) =>
    supportedClients(home, "linux", env).find(({ name }) => name === "zed");
  const native = join(home, ".config", "zed");
  const sandboxed = join(home, ".var", "app", "dev.zed.Zed", "config", "zed");
  expect(zed()?.configPath).toBe(join(native, "settings.json"));
  await mkdir(sandboxed, { recursive: true });
  expect(zed()?.configPath).toBe(join(sandboxed, "settings.json"));
  await mkdir(native, { recursive: true });
  expect(zed()?.configPathError).toContain("cannot tell which Zed");
  // A native folder linked to the Flatpak folder is one configuration.
  await rm(native, { recursive: true });
  await symlink(sandboxed, native, "dir");
  expect(zed()?.configPath).toBe(join(native, "settings.json"));
  await rm(native);
  await mkdir(native, { recursive: true });
  // An XDG_CONFIG_HOME naming the Flatpak folder is one folder, not two.
  expect(
    zed({ XDG_CONFIG_HOME: join(home, ".var", "app", "dev.zed.Zed", "config") })
      ?.configPath,
  ).toBe(join(sandboxed, "settings.json"));
  expect(
    zed({ FLATPAK_XDG_CONFIG_HOME: join(home, "selected") })?.configPath,
  ).toBe(join(home, "selected", "zed", "settings.json"));
  expect(
    zed({ FLATPAK_XDG_CONFIG_HOME: "relative" })?.configPathError,
  ).toContain("FLATPAK_XDG_CONFIG_HOME is relative");
});

it("keeps MCPorter out of setup detection and doctor until REA registers it", async () => {
  const home = await createTestTempDirectory("rea-mcporter-applicability-");
  const environment = {};
  const row = supportedClients(home, platform, environment).find(
    ({ name }) => name === "mcporter",
  );
  if (row === undefined) throw new Error("mcporter has no table row");
  await mkdir(join(home, ".mcporter"), { recursive: true });
  await writeFile(
    row.configPath,
    `${JSON.stringify({ mcpServers: { peer: { command: "peer" } } })}\n`,
  );
  expect(
    (await detectClients(home, platform, environment)).map(({ name }) => name),
  ).not.toContain("mcporter");
  const statuses = await readClientRegistrationStatuses(home, command[1], {
    platform,
    environment,
  });
  expect(statuses.map(({ client }) => client)).not.toContain("mcporter");
  // An explicit selection still reports the missing registration.
  const selected = await readClientRegistrationStatuses(home, command[1], {
    platform,
    environment,
    selectedClientIds: ["mcporter"],
  });
  expect(selected.find(({ client }) => client === "mcporter")).toMatchObject({
    state: "missing",
  });
});

it("stops uninstall with MCPorter's recovery while its location is unknown", async () => {
  const home = await createTestTempDirectory("rea-mcporter-unknown-uninstall-");
  const environment = { MCPORTER_CONFIG: "config/mcporter.json" };
  const claude = join(home, ".claude.json");
  const original = `${JSON.stringify({ mcpServers: { rea: { command: command[0], args: command.slice(1) } } })}\n`;
  await writeFile(claude, original);
  const uninstall = await runUninstall(
    false,
    systemUninstallHost(home, undefined, environment, platform),
  );
  // REA cannot tell whether MCPorter's file holds its row, so nothing is
  // removed and the result names MCPorter's own recovery.
  expect(uninstall.items).toContainEqual(
    expect.objectContaining({
      name: "mcporter",
      status: "failed",
      detail: expect.stringContaining("MCPORTER_CONFIG is relative"),
    }),
  );
  expect(await readFile(claude, "utf8")).toBe(original);
});

it.skipIf(platform === "win32")(
  "setup publishes fx's profile privately and repairs its modes",
  async () => {
    const home = await createTestTempDirectory("rea-fx-private-");
    const row = supportedClients(home, platform, {}).find(
      ({ name }) => name === "fx",
    );
    if (row === undefined) throw new Error("fx has no table row");
    const modes = async () => ({
      directory: (await stat(dirname(row.configPath))).mode & 0o777,
      file: (await stat(row.configPath)).mode & 0o777,
    });
    await expect(
      configureClientConfiguration(row, {}, command),
    ).resolves.toMatchObject({ status: "configured" });
    expect(await modes()).toEqual({ directory: 0o700, file: 0o600 });
    await expect(inspectClientConfiguration(row, {}, command)).resolves.toEqual(
      { status: "already_current" },
    );

    // A current row in a readable profile still needs its modes restored.
    await chmod(row.configPath, 0o644);
    await chmod(dirname(row.configPath), 0o755);
    await expect(
      inspectClientConfiguration(row, {}, command),
    ).resolves.toMatchObject({ status: "update" });
    // Re-selection after a Hopper install uses the same modes rule.
    await expect(clientConfigurationAligned(row, {}, command)).resolves.toBe(
      false,
    );
    await expect(
      configureClientConfiguration(row, {}, command),
    ).resolves.toMatchObject({ status: "configured" });
    expect(await modes()).toEqual({ directory: 0o700, file: 0o600 });
    await expect(clientConfigurationAligned(row, {}, command)).resolves.toBe(
      true,
    );

    // A linked profile is judged by the folder and file it names.
    const target = join(home, "fx-profile");
    await rename(dirname(row.configPath), target);
    await symlink(target, dirname(row.configPath));
    await expect(inspectClientConfiguration(row, {}, command)).resolves.toEqual(
      { status: "already_current" },
    );
  },
);

it.skipIf(platform === "win32")(
  "setup surfaces the private folder handle it could not close",
  async () => {
    const home = await createTestTempDirectory("rea-fx-private-close-");
    const row = supportedClients(home, platform, {}).find(
      ({ name }) => name === "fx",
    );
    if (row === undefined) throw new Error("fx has no table row");
    const originalClose = OwnedFileHandle.prototype.close;
    const close = vi
      .spyOn(OwnedFileHandle.prototype, "close")
      .mockImplementation(async function (this: OwnedFileHandle) {
        if ((await this.handle.stat()).isDirectory())
          throw new Error("fixture private directory close denied");
        return originalClose.call(this);
      });
    try {
      // The failed close keeps its owner on the error instead of becoming a
      // write failure that drops it.
      await expect(
        configureClientConfiguration(row, {}, command),
      ).rejects.toMatchObject({ cleanupIncomplete: true });
    } finally {
      close.mockRestore();
    }
  },
);

it.skipIf(platform === "win32")(
  "keeps fx's backups owner-only when its profile file is a link",
  async () => {
    const home = await createTestTempDirectory("rea-fx-private-backup-");
    const row = supportedClients(home, platform, {}).find(
      ({ name }) => name === "fx",
    );
    if (row === undefined) throw new Error("fx has no table row");
    // ~/.fx/mcp.json links to a readable file inside a private folder, so the
    // backups beside the link are not protected by the folder setup secures.
    const target = join(home, "private", "mcp.json");
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, `${JSON.stringify({ mcpServers: {} })}\n`, {
      mode: 0o644,
    });
    await mkdir(dirname(row.configPath), { recursive: true });
    await chmod(dirname(row.configPath), 0o755);
    await symlink(target, row.configPath);
    await expect(
      configureClientConfiguration(row, {}, command),
    ).resolves.toMatchObject({ status: "configured" });
    const backupMode = async () =>
      (await stat(`${row.configPath}.rea.backup`)).mode & 0o777;
    expect(await backupMode()).toBe(0o600);

    const uninstall = await runUninstall(
      false,
      systemUninstallHost(home, undefined, {}, platform),
    );
    expect(uninstall.items).toContainEqual(
      expect.objectContaining({ name: "fx", status: "removed" }),
    );
    // Uninstall's backup of the registered file is owner-only too.
    const backups = (await readdir(dirname(row.configPath))).filter((name) =>
      name.startsWith("mcp.json.rea"),
    );
    expect(backups.length).toBeGreaterThan(1);
    for (const name of backups)
      expect(
        (await stat(join(dirname(row.configPath), name))).mode & 0o777,
      ).toBe(0o600);
  },
);

it("reports a Junie registration Junie would not load in doctor and setup", async () => {
  const home = await createTestTempDirectory("rea-junie-policy-");
  const environment = { JUNIE_MCP_DEFAULT_LOCATIONS: "false" };
  const row = supportedClients(home, platform, environment).find(
    ({ name }) => name === "junie",
  );
  if (row === undefined) throw new Error("junie has no table row");
  await mkdir(dirname(row.configPath), { recursive: true });
  await writeFile(
    row.configPath,
    `${JSON.stringify({ mcpServers: { rea: { command: command[0], args: command.slice(1) } } })}\n`,
  );
  const status = (
    await readClientRegistrationStatuses(home, command[1], {
      platform,
      environment,
    })
  ).find(({ client }) => client === "junie");
  expect(status).toMatchObject({
    state: "stale",
    remediation: expect.stringContaining("JUNIE_MCP_DEFAULT_LOCATIONS"),
  });
  await expect(
    inspectClientConfiguration(row, {}, command),
  ).resolves.toMatchObject({ status: "invalid" });
  // Setup would refuse Junie, so update reports it instead of failing the
  // other clients' maintenance plan.
  const scope = await existingMaintenanceScope(
    home,
    command[1] ?? "",
    environment,
  );
  expect(scope.clients).not.toContain("junie");
  expect(scope.unresolved).toEqual([
    expect.objectContaining({
      client: "junie",
      remediation: expect.stringContaining("JUNIE_MCP_DEFAULT_LOCATIONS"),
    }),
  ]);
});

it.skipIf(platform === "win32")(
  "reports Goose's effective registration across its read-only layers",
  async () => {
    const home = await createTestTempDirectory("rea-goose-layers-");
    const additional = join(home, "team", "goose.yaml");
    await mkdir(dirname(additional), { recursive: true });
    const lower = "extensions:\n  rea:\n    enabled: false\n";
    await writeFile(additional, lower);
    const environment = { GOOSE_ADDITIONAL_CONFIG_FILES: additional };
    // The system layer is injected so the host's /etc/goose is never read.
    const systemPaths = { gooseSystemConfig: join(home, "system.yaml") };
    const resources = new ArtifactResourceScope();
    const selected = await resolveMcpRegistrationClients(
      {
        agents: ["goose"],
        global: true,
        cwd: home,
        home,
        platform,
        environment,
        systemPaths,
      },
      resources,
    );
    if (!selected.ok) throw selected.error;
    const row = supportedClients(home, platform, environment, systemPaths).find(
      ({ name }) => name === "goose",
    );
    expect(row?.configPaths).toEqual([
      systemPaths.gooseSystemConfig,
      additional,
      row?.configPath,
    ]);
    expect(selected.value[0]).toMatchObject({
      configPaths: row?.configPaths,
    });
    const [outcome] = await registerMcpClients(
      selected.value,
      { command: command[0] ?? "", args: command.slice(1) },
      undefined,
      resources,
    );
    expect(outcome).toMatchObject({
      status: "completed",
      result: { ok: true },
    });
    // The user file does not set `enabled`, so the lower layer's false holds.
    const inspections = await readClientRegistrationInspections(
      home,
      command[1],
      { platform, environment, systemPaths },
    );
    expect(
      inspections.find(({ status }) => status.client === "goose"),
    ).toMatchObject({ activation: "disabled", status: { state: "stale" } });
    const uninstall = await runUninstall(
      false,
      systemUninstallHost(home, undefined, environment, platform, systemPaths),
    );
    expect(uninstall.items).toContainEqual(
      expect.objectContaining({ name: "goose", status: "removed" }),
    );
    // Uninstall changes only the user file Goose writes.
    expect(await readFile(additional, "utf8")).toBe(lower);
  },
);

it("orders Goose's layers as Goose loads them", () => {
  const home = "/fixture/home";
  const user = "/fixture/home/.config/goose/config.yaml";
  const unix = supportedClients(home, "linux", {
    GOOSE_ADDITIONAL_CONFIG_FILES: `${user}:/fixture/team.yaml`,
  }).find(({ name }) => name === "goose");
  // Goose loads the user file again last, so that load decides precedence.
  expect(unix?.configPaths).toEqual([
    "/etc/goose/config.yaml",
    "/fixture/team.yaml",
    user,
  ]);
  const windows = supportedClients("C:\\Users\\fixture", "win32", {
    APPDATA: "C:\\Users\\fixture\\AppData\\Roaming",
    PROGRAMDATA: "C:\\ProgramData",
    GOOSE_ADDITIONAL_CONFIG_FILES:
      '"C:\\Team Config\\a;b.yaml";C:\\Team\\goose.yaml',
  }).find(({ name }) => name === "goose");
  expect(windows?.configPathError).toBeUndefined();
  expect(windows?.configPaths?.slice(1, 3)).toEqual([
    "C:\\Team Config\\a;b.yaml",
    "C:\\Team\\goose.yaml",
  ]);
  // A drive-less Windows entry depends on Goose's current drive.
  const driveless = supportedClients("C:\\Users\\fixture", "win32", {
    APPDATA: "C:\\Users\\fixture\\AppData\\Roaming",
    GOOSE_ADDITIONAL_CONFIG_FILES: "\\team\\goose.yaml",
  }).find(({ name }) => name === "goose");
  expect(driveless?.configPathError).toContain(
    "\\team\\goose.yaml, which has no drive",
  );
});

it.skipIf(platform === "win32")(
  "refreshes Goose's environment through setup without losing inherited or aliased settings",
  async () => {
    const { team, row } = await gooseFixture("rea-goose-environment-");
    await mkdir(dirname(row.configPath), { recursive: true });
    const userEntry = async () =>
      (
        clientConfigurationRecordSchema.parse(
          parseGooseConfigurationYaml(await readFile(row.configPath, "utf8")),
        ).extensions as Record<string, Record<string, unknown>>
      ).rea;

    const launcher = `    type: stdio\n    cmd: ${JSON.stringify(command[0])}\n    args: ${JSON.stringify(command.slice(1))}\n`;

    // A lower map stays in effect when the user entry declares none.
    await writeFile(
      team,
      'extensions:\n  rea:\n    envs:\n      TEAM_SETTING: "1"\n',
    );
    await writeFile(row.configPath, `extensions:\n  rea:\n${launcher}`);
    await expect(
      configureClientConfiguration(row, {}, command),
    ).resolves.toMatchObject({ status: "configured" });
    expect(await userEntry()).not.toHaveProperty("envs");

    // The env alias is read and written back as envs.
    await writeFile(team, "{}\n");
    await writeFile(
      row.configPath,
      `extensions:\n  rea:\n${launcher}    env:\n      KEEP: "1"\n`,
    );
    await expect(
      configureClientConfiguration(row, {}, command),
    ).resolves.toMatchObject({ status: "configured" });
    expect(await userEntry()).toMatchObject({ envs: { KEEP: "1" } });
    expect(await userEntry()).not.toHaveProperty("env");

    // A requested setting replaces the recorded value.
    await expect(
      configureClientConfiguration(
        row,
        { REA_ANALYSIS_PROVIDER: "ghidra" },
        command,
      ),
    ).resolves.toMatchObject({ status: "configured" });
    expect(await userEntry()).toMatchObject({
      envs: { KEEP: "1", REA_ANALYSIS_PROVIDER: "ghidra" },
    });

    // A requested setting over an inherited map keeps the inherited values.
    await writeFile(
      team,
      'extensions:\n  rea:\n    envs:\n      TEAM_SETTING: "1"\n',
    );
    await writeFile(row.configPath, `extensions:\n  rea:\n${launcher}`);
    await expect(
      configureClientConfiguration(
        row,
        { REA_ANALYSIS_PROVIDER: "ghidra" },
        command,
      ),
    ).resolves.toMatchObject({ status: "configured" });
    expect((await userEntry())?.envs).toEqual({
      TEAM_SETTING: "1",
      REA_ANALYSIS_PROVIDER: "ghidra",
    });

    // An inherited map under the env alias is replaced under that spelling,
    // so the merged entry never declares both env and envs.
    await writeFile(team, 'extensions:\n  rea:\n    env:\n      KEEP: "1"\n');
    await writeFile(row.configPath, `extensions:\n  rea:\n${launcher}`);
    await expect(
      configureClientConfiguration(
        row,
        { REA_ANALYSIS_PROVIDER: "ghidra" },
        command,
      ),
    ).resolves.toMatchObject({ status: "configured" });
    expect(await userEntry()).toMatchObject({
      env: { KEEP: "1", REA_ANALYSIS_PROVIDER: "ghidra" },
    });
    expect(await userEntry()).not.toHaveProperty("envs");
    await expect(
      inspectClientConfiguration(
        row,
        { REA_ANALYSIS_PROVIDER: "ghidra" },
        command,
      ),
    ).resolves.toEqual({ status: "already_current" });
  },
);

it.skipIf(platform === "win32")(
  "mcp add leaves an inherited Goose env alias in force",
  async () => {
    const { home, team, environment, systemPaths } = await gooseFixture(
      "rea-goose-add-alias-",
    );
    await writeFile(team, 'extensions:\n  rea:\n    env:\n      KEEP: "1"\n');
    const resources = new ArtifactResourceScope();
    const selected = await resolveMcpRegistrationClients(
      {
        agents: ["goose"],
        global: true,
        cwd: home,
        home,
        platform,
        environment,
        systemPaths,
      },
      resources,
    );
    if (!selected.ok) throw selected.error;
    const [outcome] = await registerMcpClients(
      selected.value,
      { command: command[0] ?? "", args: command.slice(1) },
      undefined,
      resources,
    );
    expect(outcome).toMatchObject({
      status: "completed",
      result: { ok: true },
    });
    // Writing envs: {} beside the inherited alias would make the merged entry
    // ambiguous; the registration reads back as aligned instead.
    const inspections = await readClientRegistrationInspections(
      home,
      command[1],
      { platform, environment, systemPaths },
    );
    expect(
      inspections.find(({ status }) => status.client === "goose"),
    ).toMatchObject({ activation: "enabled", status: { state: "aligned" } });
  },
);

it.skipIf(platform === "win32")(
  "keeps Goose's user registration while a read-only layer would stay enabled",
  async () => {
    const { home, team, row, environment, systemPaths } = await gooseFixture(
      "rea-goose-uninstall-",
    );
    await writeFile(
      team,
      `extensions:\n  rea:\n    type: stdio\n    cmd: ${JSON.stringify(command[0])}\n    args: ${JSON.stringify(command.slice(1))}\n`,
    );
    await expect(
      configureClientConfiguration(row, {}, command),
    ).resolves.toMatchObject({ status: "configured" });
    const before = await readFile(row.configPath, "utf8");
    const uninstall = await runUninstall(
      false,
      systemUninstallHost(home, undefined, environment, platform, systemPaths),
    );
    expect(uninstall.items).toContainEqual(
      expect.objectContaining({ name: "goose", status: "failed" }),
    );
    expect(await readFile(row.configPath, "utf8")).toBe(before);
  },
);

it.skipIf(platform === "win32")(
  "reads an administrator's system layer without requiring the caller to own it",
  async () => {
    const { home, row, environment, systemPaths } = await gooseFixture(
      "rea-goose-system-owner-",
    );
    const system = systemPaths.gooseSystemConfig;
    await writeFile(
      system,
      `extensions:\n  rea:\n    type: stdio\n    cmd: ${JSON.stringify(command[0])}\n    args: ${JSON.stringify(command.slice(1))}\n    enabled: false\n`,
    );
    await expect(
      configureClientConfiguration(row, {}, command),
    ).resolves.toMatchObject({ status: "configured" });
    // The system layer belongs to another user; only REA's write target must
    // be the caller's.
    const fileSystem: UninstallFileSystem = {
      readText: (path) => readFile(path, "utf8"),
      copy: (source, destination) =>
        copyFile(source, destination, fsConstants.COPYFILE_EXCL),
      publishConfiguration: (path, contents, original) =>
        ClientConfigurationPublication.write(path, contents, original),
      stat: async (path) => {
        const stats = await lstat(path);
        if (path === system) stats.uid += 1;
        return stats;
      },
      realpath: (path) => realpath(path),
      remove: (path) => rm(path, { recursive: true }),
    };
    const uninstall = await runUninstall(
      false,
      systemUninstallHost(home, fileSystem, environment, platform, systemPaths),
    );
    expect(uninstall.items).toContainEqual(
      expect.objectContaining({ name: "goose", status: "removed" }),
    );
  },
);

it.skipIf(platform === "win32")(
  "keeps a timeout and activation only a lower Goose layer declares",
  async () => {
    const { team, row } = await gooseFixture("rea-goose-inherited-policy-");
    await writeFile(
      team,
      "extensions:\n  rea:\n    timeout: 900\n    enabled: false\n",
    );
    await mkdir(dirname(row.configPath), { recursive: true });
    await writeFile(
      row.configPath,
      `extensions:\n  rea:\n    type: stdio\n    cmd: ${JSON.stringify(command[0])}\n    args: ${JSON.stringify(command.slice(1))}\n`,
    );
    await expect(
      configureClientConfiguration(row, {}, command),
    ).resolves.toMatchObject({ status: "configured" });
    const entry = (
      clientConfigurationRecordSchema.parse(
        parseGooseConfigurationYaml(await readFile(row.configPath, "utf8")),
      ).extensions as Record<string, Record<string, unknown>>
    ).rea;
    expect(entry).not.toHaveProperty("timeout");
    expect(entry).not.toHaveProperty("enabled");
    // Setup is idempotent over the inherited settings.
    await expect(inspectClientConfiguration(row, {}, command)).resolves.toEqual(
      { status: "already_current" },
    );
  },
);

it.skipIf(platform === "win32")(
  "ignores an invalid environment map a higher Goose layer replaces",
  async () => {
    const { home, team, row, environment, systemPaths } = await gooseFixture(
      "rea-goose-shadowed-environment-",
    );
    // Goose replaces envs per layer, so the lower invalid value never runs.
    await writeFile(
      team,
      "extensions:\n  rea:\n    envs:\n      REA_LOG_LEVEL: verbose\n",
    );
    await mkdir(dirname(row.configPath), { recursive: true });
    await writeFile(
      row.configPath,
      `extensions:\n  rea:\n    type: stdio\n    cmd: ${JSON.stringify(command[0])}\n    args: ${JSON.stringify(command.slice(1))}\n    envs:\n      REA_LOG_LEVEL: info\n`,
    );
    const inspections = await readClientRegistrationInspections(
      home,
      command[1],
      { platform, environment, systemPaths },
    );
    expect(
      inspections.find(({ status }) => status.client === "goose"),
    ).toMatchObject({ activation: "enabled", status: { state: "aligned" } });
  },
);

it.skipIf(platform === "win32")(
  "reports REA's registration that only a read-only Goose layer defines",
  async () => {
    const { home, team, row, environment, systemPaths } = await gooseFixture(
      "rea-goose-lower-only-",
    );
    await writeFile(
      team,
      `extensions:\n  rea:\n    type: stdio\n    cmd: ${JSON.stringify(command[0])}\n    args: ${JSON.stringify(command.slice(1))}\n`,
    );
    const uninstall = () =>
      runUninstall(
        false,
        systemUninstallHost(
          home,
          undefined,
          environment,
          platform,
          systemPaths,
        ),
      );
    // Without a user file, and with one that has no REA entry, Goose still
    // loads the lower registration, so uninstall is not complete.
    const retained = expect.objectContaining({
      name: "goose",
      status: "failed",
      detail: expect.stringContaining("read-only configuration layer"),
    });
    await expect(uninstall()).resolves.toMatchObject({
      status: "failed",
      items: expect.arrayContaining([retained]),
    });
    await mkdir(dirname(row.configPath), { recursive: true });
    await writeFile(row.configPath, "extensions: {}\n");
    await expect(uninstall()).resolves.toMatchObject({
      status: "failed",
      items: expect.arrayContaining([retained]),
    });
    // A partial user entry inherits REA's launcher from the lower layer.
    await writeFile(
      row.configPath,
      "extensions:\n  rea:\n    envs:\n      KEEP: '1'\n",
    );
    await expect(uninstall()).resolves.toMatchObject({
      status: "failed",
      items: expect.arrayContaining([retained]),
    });
    expect(await readFile(team, "utf8")).toContain("rea:");
    // A disabled lower entry is not loaded, so nothing is retained.
    await writeFile(row.configPath, "extensions: {}\n");
    await writeFile(team, "extensions:\n  rea:\n    enabled: false\n");
    await expect(uninstall()).resolves.toMatchObject({ status: "complete" });
  },
);

it.skipIf(platform === "win32")(
  "stops uninstall before any removal when a lower Goose layer is unreadable",
  async () => {
    const { home, team, environment, systemPaths } = await gooseFixture(
      "rea-goose-lower-unreadable-",
    );
    await writeFile(team, "extensions: [\n");
    const codex = join(home, ".codex", "config.toml");
    await mkdir(dirname(codex), { recursive: true });
    const registration = `[mcp_servers.rea]\ncommand = ${JSON.stringify(command[0])}\nargs = ${JSON.stringify(command.slice(1))}\n`;
    await writeFile(codex, registration);
    const uninstall = await runUninstall(
      false,
      systemUninstallHost(home, undefined, environment, platform, systemPaths),
    );
    expect(uninstall).toMatchObject({
      status: "failed",
      items: expect.arrayContaining([
        expect.objectContaining({ name: "goose", status: "failed" }),
      ]),
    });
    expect(await readFile(codex, "utf8")).toBe(registration);
  },
);

const gooseFixture = async (prefix: string) => {
  const home = await createTestTempDirectory(prefix);
  const team = join(home, "team.yaml");
  const environment = { GOOSE_ADDITIONAL_CONFIG_FILES: team };
  const systemPaths = { gooseSystemConfig: join(home, "system.yaml") };
  const row = supportedClients(home, platform, environment, systemPaths).find(
    ({ name }) => name === "goose",
  );
  if (row === undefined) throw new Error("Goose has no table row");
  return { home, team, row, environment, systemPaths };
};
