import { currentClientRegistrationCommand } from "../../../src/application/ClientRegistrationIdentity.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, win32 } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readClientRegistrationStatuses } from "../../../src/application/ClientRegistrationStatus.js";

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
const command = currentClientRegistrationCommand({
  platform: process.platform,
});

beforeEach(clearClientLocationEnvironment);
afterEach(() => vi.unstubAllEnvs());

const workbuddyPath = (
  home: string,
  platform: NodeJS.Platform = process.platform,
  env: Parameters<typeof supportedClients>[2] = {},
) =>
  supportedClients(home, platform, env).find(
    ({ name }) => name === "workbuddy",
  );

describe("WorkBuddy configuration paths", () => {
  it("resolves the global mcp.json under the home root", () => {
    expect(workbuddyPath("/home/a")?.configPath).toBe(
      join("/home/a", ".workbuddy", "mcp.json"),
    );
    expect(workbuddyPath("/Users/a")?.markerPath).toBe(
      join("/Users/a", ".workbuddy"),
    );
    expect(workbuddyPath("C:\\Users\\a", "win32")?.configPath).toBe(
      join("C:\\Users\\a", ".workbuddy", "mcp.json"),
    );
  });

  it("resolves the registration format as the plain mcpServers JSON dialect", () => {
    expect(workbuddyPath("/home/a")?.format).toBe("json");
  });

  it("resolves the personal skills directory under the home root", () => {
    expect(
      skillDestinations("/home/a", ["workbuddy"]).map(({ path }) => path),
    ).toEqual([
      join("/home/a", ".workbuddy", "skills", "reverse-engineer-anything"),
    ]);
    expect(
      skillDestinations("C:\\Users\\a", ["workbuddy"], {}, "win32").map(
        ({ path }) => path,
      ),
    ).toEqual([
      win32.join(
        "C:\\Users\\a",
        ".workbuddy",
        "skills",
        "reverse-engineer-anything",
      ),
    ]);
  });
});

describe("WorkBuddy JSON registration", () => {
  const workbuddyClient = async () => {
    const home = await createTestTempDirectory("rea-workbuddy-");
    const client = workbuddyPath(home, process.platform);
    if (client?.markerPath === undefined)
      throw new Error("missing WorkBuddy client");
    await mkdir(client.markerPath, { recursive: true });
    return { home, client };
  };

  it("upserts rea into mcpServers while preserving unrelated settings", async () => {
    const { home, client } = await workbuddyClient();
    await writeFile(
      client.configPath,
      `{
  "mcpServers": {
    "other": { "command": "other-server" }
  }
}`,
    );

    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const parsed = JSON.parse(await readFile(client.configPath, "utf8"));
    expect(parsed.mcpServers.other).toEqual({ command: "other-server" });
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
      ).find(({ client }) => client === "workbuddy"),
    ).toMatchObject({ state: "aligned", command });
  });

  it("creates the mcpServers table in an existing mcp.json without servers", async () => {
    const { client } = await workbuddyClient();
    await writeFile(
      client.configPath,
      JSON.stringify({ unrelated: { setting: true } }, null, 2),
    );
    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const parsed = JSON.parse(await readFile(client.configPath, "utf8"));
    expect(parsed.unrelated).toEqual({ setting: true });
    expect(parsed.mcpServers.rea).toEqual({
      command: command[0],
      args: command.slice(1),
    });
  });

  it("registers into an empty mcp.json", async () => {
    const { client } = await workbuddyClient();
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
    const { home, client } = await workbuddyClient();
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
