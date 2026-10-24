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

const bobPath = (
  home: string,
  platform: NodeJS.Platform = process.platform,
  env: Parameters<typeof supportedClients>[2] = {},
) => supportedClients(home, platform, env).find(({ name }) => name === "bob");

describe("IBM Bob configuration paths", () => {
  it("resolves the global settings mcp.json under the home root", () => {
    expect(bobPath("/home/a")?.configPath).toBe(
      join("/home/a", ".bob", "settings", "mcp.json"),
    );
    expect(bobPath("/Users/a")?.markerPath).toBe(join("/Users/a", ".bob"));
    expect(bobPath("C:\\Users\\a", "win32")?.configPath).toBe(
      join("C:\\Users\\a", ".bob", "settings", "mcp.json"),
    );
  });

  it("resolves the registration format as the plain mcpServers JSON dialect", () => {
    expect(bobPath("/home/a")?.format).toBe("json");
    expect(bobPath("/home/a")?.displayName).toBe("IBM Bob");
  });

  it("resolves the personal skills directory under the home root", () => {
    expect(
      skillDestinations("/home/a", ["bob"]).map(({ path }) => path),
    ).toEqual([join("/home/a", ".bob", "skills", "reverse-engineer-anything")]);
    expect(
      skillDestinations("C:\\Users\\a", ["bob"], {}, "win32").map(
        ({ path }) => path,
      ),
    ).toEqual([
      join("C:\\Users\\a", ".bob", "skills", "reverse-engineer-anything"),
    ]);
  });
});

describe("IBM Bob JSON registration", () => {
  const bobClient = async () => {
    const home = await createTestTempDirectory("rea-bob-");
    const client = bobPath(home, process.platform);
    if (client?.markerPath === undefined) throw new Error("missing Bob client");
    await mkdir(join(home, ".bob", "settings"), { recursive: true });
    return { home, client };
  };

  it("upserts rea into mcpServers while preserving unrelated servers", async () => {
    const { home, client } = await bobClient();
    await writeFile(
      client.configPath,
      `{
  "mcpServers": {
    "other": { "type": "streamable-http", "url": "http://127.0.0.1:1/mcp" }
  }
}`,
    );

    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const parsed = JSON.parse(await readFile(client.configPath, "utf8"));
    expect(parsed.mcpServers.other).toEqual({
      type: "streamable-http",
      url: "http://127.0.0.1:1/mcp",
    });
    expect(parsed.mcpServers.rea).toEqual({
      command: command[0],
      args: command.slice(1),
      env: { REA_MCP_INPUT_SCHEMA_PROFILE: "compact" },
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
      ).find(({ client }) => client === "bob"),
    ).toMatchObject({ state: "aligned", command });
  });

  it("registers into an empty mcpServers table", async () => {
    const { client } = await bobClient();
    await writeFile(client.configPath, '{\n  "mcpServers": {}\n}\n');
    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const parsed = JSON.parse(await readFile(client.configPath, "utf8"));
    expect(parsed.mcpServers.rea).toEqual({
      command: command[0],
      args: command.slice(1),
      env: { REA_MCP_INPUT_SCHEMA_PROFILE: "compact" },
    });
  });

  it("adds compact to an existing entry that sets no profile", async () => {
    const { client } = await bobClient();
    await writeFile(
      client.configPath,
      JSON.stringify({
        mcpServers: { rea: { command: command[0], args: command.slice(1) } },
      }),
    );
    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    expect(
      JSON.parse(await readFile(client.configPath, "utf8")).mcpServers.rea.env,
    ).toEqual({ REA_MCP_INPUT_SCHEMA_PROFILE: "compact" });
  });

  it("keeps an explicitly configured input schema profile", async () => {
    const { client } = await bobClient();
    await writeFile(
      client.configPath,
      JSON.stringify({
        mcpServers: {
          rea: {
            command: command[0],
            args: command.slice(1),
            env: { REA_MCP_INPUT_SCHEMA_PROFILE: "full" },
          },
        },
      }),
    );
    await configureClientConfiguration(client, {}, command);
    const parsed = JSON.parse(await readFile(client.configPath, "utf8"));
    expect(parsed.mcpServers.rea.env).toEqual({
      REA_MCP_INPUT_SCHEMA_PROFILE: "full",
    });
  });

  it("removes only the rea entry on uninstall", async () => {
    const { home, client } = await bobClient();
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
