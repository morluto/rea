import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readClientRegistrationStatuses } from "../../../src/application/ClientRegistrationStatus.js";
import { npxRegistrationCommand } from "../../../src/application/ClientRegistrationIdentity.js";
import { configureClientConfiguration } from "../../../src/application/SetupClientConfiguration.js";
import { skillDestinations } from "../../../src/application/SetupSkill.js";
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

const zcodePath = (
  home: string,
  platform: NodeJS.Platform = "linux",
  env: Parameters<typeof supportedClients>[2] = {},
) => supportedClients(home, platform, env).find(({ name }) => name === "zcode");

describe("ZCode configuration paths", () => {
  it("resolves the user config file and marker directory", () => {
    expect(zcodePath("/home/a")).toEqual({
      name: "zcode",
      displayName: "ZCode",
      configPath: join("/home/a", ".zcode", "cli", "config.json"),
      markerPath: join("/home/a", ".zcode", "cli"),
      format: "zcode",
    });
    expect(zcodePath("/Users/a", "darwin")?.configPath).toBe(
      join("/Users/a", ".zcode", "cli", "config.json"),
    );
    expect(zcodePath("C:\\Users\\a", "win32")?.configPath).toBe(
      join("C:\\Users\\a", ".zcode", "cli", "config.json"),
    );
  });

  it("resolves the personal skills directory beside the config root", () => {
    expect(
      skillDestinations("/home/a", ["zcode"]).map(({ path }) => path),
    ).toEqual([
      join("/home/a", ".zcode", "skills", "reverse-engineer-anything"),
    ]);
  });
});

describe("ZCode JSON registration", () => {
  const zcodeClient = async () => {
    const home = await createTestTempDirectory("rea-zcode-");
    const client = zcodePath(home, process.platform);
    if (client?.markerPath === undefined)
      throw new Error("missing ZCode client");
    await mkdir(client.markerPath, { recursive: true });
    return { home, client };
  };

  it("upserts rea into mcp.servers while preserving unrelated settings", async () => {
    const { home, client } = await zcodeClient();
    await writeFile(
      client.configPath,
      `{
  "mcp": {
    "servers": {
      "other": { "command": "other-server" }
    }
  }
}`,
    );

    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const parsed = JSON.parse(await readFile(client.configPath, "utf8"));
    expect(parsed.mcp.servers.other).toEqual({ command: "other-server" });
    expect(parsed.mcp.servers.rea).toEqual({
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
      ).find(({ client }) => client === "zcode"),
    ).toMatchObject({ state: "aligned", command });
  });

  it("creates the mcp.servers table in an existing config without servers", async () => {
    const { client } = await zcodeClient();
    await writeFile(
      client.configPath,
      JSON.stringify({ ui: { theme: "dark" } }, null, 2),
    );
    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const parsed = JSON.parse(await readFile(client.configPath, "utf8"));
    expect(parsed.ui).toEqual({ theme: "dark" });
    expect(parsed.mcp.servers.rea).toEqual({
      command: command[0],
      args: command.slice(1),
    });
  });

  it("registers into an empty config file", async () => {
    const { client } = await zcodeClient();
    await writeFile(client.configPath, "");
    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const parsed = JSON.parse(await readFile(client.configPath, "utf8"));
    expect(parsed.mcp.servers.rea).toEqual({
      command: command[0],
      args: command.slice(1),
    });
  });

  it("removes only the rea entry on uninstall", async () => {
    const { home, client } = await zcodeClient();
    await writeFile(
      client.configPath,
      JSON.stringify(
        { mcp: { servers: { other: { command: "other-server" } } } },
        null,
        2,
      ),
    );
    await configureClientConfiguration(client, {}, command);

    expect((await systemUninstallHost(home).removeClient(client)).status).toBe(
      "removed",
    );
    const parsed = JSON.parse(await readFile(client.configPath, "utf8"));
    expect(parsed.mcp.servers.other).toEqual({ command: "other-server" });
    expect(parsed.mcp.servers.rea).toBeUndefined();
  });
});
