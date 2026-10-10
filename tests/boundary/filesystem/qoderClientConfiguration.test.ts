import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readClientRegistrationStatuses } from "../../../src/application/ClientRegistrationStatus.js";
import { npxRegistrationCommand } from "../../../src/application/ClientRegistrationIdentity.js";
import { configureClientConfiguration } from "../../../src/application/SetupClientConfiguration.js";
import { supportedClients } from "../../../src/application/SupportedClients.js";
import { systemUninstallHost } from "../../../src/application/Uninstall.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { clearClientLocationEnvironment } from "../../fixtures/clientEnvironment.js";

/**
 * The registration command setup writes on the host running the tests. Windows
 * wraps it in `cmd.exe /d /c`, so the expected entry follows the host too.
 */
const command = npxRegistrationCommand(process.platform);

beforeEach(clearClientLocationEnvironment);
afterEach(() => vi.unstubAllEnvs());

const qoderPath = (
  home: string,
  platform: NodeJS.Platform = "linux",
  env: Parameters<typeof supportedClients>[2] = {},
) => supportedClients(home, platform, env).find(({ name }) => name === "qoder");

describe("Qoder configuration paths", () => {
  it("resolves the user settings file and marker directory", () => {
    expect(qoderPath("/home/a")).toEqual({
      name: "qoder",
      displayName: "Qoder",
      configPath: join("/home/a", ".qoder", "settings.json"),
      markerPath: join("/home/a", ".qoder"),
      format: "json",
    });
    expect(qoderPath("/Users/a", "darwin")?.configPath).toBe(
      join("/Users/a", ".qoder", "settings.json"),
    );
    expect(qoderPath("C:\\Users\\a", "win32")?.configPath).toBe(
      join("C:\\Users\\a", ".qoder", "settings.json"),
    );
  });

  it("honors the QODER_CONFIG_DIR override", () => {
    expect(
      qoderPath("/home/a", "linux", { QODER_CONFIG_DIR: "/opt/qoder" })
        ?.configPath,
    ).toBe(join("/opt/qoder", "settings.json"));
    expect(
      qoderPath("/home/a", "linux", { QODER_CONFIG_DIR: "" })?.configPath,
    ).toBe(join("/home/a", ".qoder", "settings.json"));
  });
});

describe("Qoder JSON registration", () => {
  const qoderClient = async () => {
    const home = await createTestTempDirectory("rea-qoder-");
    const client = qoderPath(home, process.platform);
    if (client?.markerPath === undefined)
      throw new Error("missing Qoder client");
    await mkdir(client.markerPath, { recursive: true });
    return { home, client };
  };

  it("upserts rea into mcpServers while preserving unrelated settings", async () => {
    const { home, client } = await qoderClient();
    await writeFile(
      client.configPath,
      `{
  "mcpServers": {
    "other": { "command": "other-server" }
  },
  "model": { "name": "qoder-model" }
}`,
    );

    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const parsed = JSON.parse(await readFile(client.configPath, "utf8"));
    expect(parsed.mcpServers.other).toEqual({ command: "other-server" });
    expect(parsed.model).toEqual({ name: "qoder-model" });
    expect(parsed.mcpServers.rea).toEqual({
      command: command[0],
      args: command.slice(1),
    });

    expect(await configureClientConfiguration(client, {}, command)).toEqual({
      status: "unchanged",
    });
    expect(
      (
        await readClientRegistrationStatuses(home, undefined, {
          platform: process.platform,
          environment: {},
        })
      ).find(({ client }) => client === "qoder"),
    ).toMatchObject({ state: "aligned", command });
  });

  it("creates the mcpServers table in an existing settings file without servers", async () => {
    const { client } = await qoderClient();
    await writeFile(
      client.configPath,
      JSON.stringify({ general: { vimMode: false } }, null, 2),
    );
    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const parsed = JSON.parse(await readFile(client.configPath, "utf8"));
    expect(parsed.general).toEqual({ vimMode: false });
    expect(parsed.mcpServers.rea).toEqual({
      command: command[0],
      args: command.slice(1),
    });
  });

  it("registers into an empty settings file", async () => {
    const { client } = await qoderClient();
    await writeFile(client.configPath, "");
    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const parsed = JSON.parse(await readFile(client.configPath, "utf8"));
    expect(parsed.mcpServers.rea).toEqual({
      command: command[0],
      args: command.slice(1),
    });
  });

  it("removes only the rea entry on uninstall", async () => {
    const { home, client } = await qoderClient();
    await writeFile(
      client.configPath,
      JSON.stringify(
        { mcpServers: { other: { command: "other-server" } } },
        null,
        2,
      ),
    );
    await configureClientConfiguration(client, {}, command);

    expect((await systemUninstallHost(home).removeClient(client)).status).toBe(
      "removed",
    );
    const parsed = JSON.parse(await readFile(client.configPath, "utf8"));
    expect(parsed.mcpServers.other).toEqual({ command: "other-server" });
    expect(parsed.mcpServers.rea).toBeUndefined();
  });
});
