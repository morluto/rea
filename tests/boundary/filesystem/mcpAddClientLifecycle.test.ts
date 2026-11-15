import { readFile } from "node:fs/promises";
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
