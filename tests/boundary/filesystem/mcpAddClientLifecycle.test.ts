import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { parseClientConfiguration } from "../../../src/application/ClientConfigurationDocument.js";
import { currentClientRegistrationCommand } from "../../../src/application/ClientRegistrationIdentity.js";
import { readClientRegistrationStatuses } from "../../../src/application/ClientRegistrationStatus.js";
import { registerMcpClients } from "../../../src/application/McpClientRegistration.js";
import { resolveMcpRegistrationClients } from "../../../src/application/McpRegistrationCatalog.js";
import {
  configureClientConfiguration,
  inspectClientConfiguration,
} from "../../../src/application/SetupClientConfiguration.js";
import { supportedClients } from "../../../src/application/SupportedClients.js";
import { detectClients } from "../../../src/application/SetupHost.js";
import {
  runUninstall,
  systemUninstallHost,
} from "../../../src/application/Uninstall.js";
import { existingMaintenanceScope } from "../../../src/application/UpdateMaintenance.js";
import { ArtifactResourceScope } from "../../../src/artifacts/ArtifactResourceScope.js";
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
])(
  "inspects, refreshes and removes the $agent registration that mcp add wrote as $client",
  async ({ agent, client }) => {
    const home = await createTestTempDirectory(`rea-mcp-add-${client}-`);
    const environment = {};
    const resources = new ArtifactResourceScope();
    const selected = await resolveMcpRegistrationClients(
      { agents: [agent], global: true, cwd: home, home, platform, environment },
      resources,
    );
    if (!selected.ok) throw selected.error;
    const row = supportedClients(home, platform, environment).find(
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
      existingMaintenanceScope(home, command[1] ?? "", environment),
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
      systemUninstallHost(home, undefined, environment, platform),
    );
    expect(uninstall.items).toContainEqual(
      expect.objectContaining({ name: client, status: "removed" }),
    );
    const remaining = parseClientConfiguration(
      await readFile(row.configPath, "utf8"),
      row.format,
    );
    expect(remaining.servers).not.toHaveProperty("rea");
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
