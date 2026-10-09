import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseJsonc } from "jsonc-parser";

import { readClientRegistrationStatuses } from "../../../src/application/ClientRegistrationStatus.js";
import { configureClientConfiguration } from "../../../src/application/SetupClientConfiguration.js";
import { supportedClients } from "../../../src/application/SupportedClients.js";
import { systemUninstallHost } from "../../../src/application/Uninstall.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  clearClientLocationEnvironment,
  NPX_REGISTRATION_COMMAND,
} from "../../fixtures/clientEnvironment.js";

const command = NPX_REGISTRATION_COMMAND;

beforeEach(clearClientLocationEnvironment);
afterEach(() => vi.unstubAllEnvs());

const piPath = (
  env: Parameters<typeof supportedClients>[2],
  platform: NodeJS.Platform = "linux",
) =>
  supportedClients("/home/a", platform, env).find(({ name }) => name === "pi");

describe("Pi configuration paths", () => {
  it("uses ~/.pi/agent and Pi's absolute agent-directory override", () => {
    expect(piPath({})).toEqual({
      name: "pi",
      displayName: "Pi",
      configPath: "/home/a/.pi/agent/mcp.json",
      markerPath: "/home/a/.pi/agent",
      format: "pi",
    });
    expect(piPath({ PI_CODING_AGENT_DIR: "" })?.configPath).toBe(
      "/home/a/.pi/agent/mcp.json",
    );
    expect(piPath({ PI_CODING_AGENT_DIR: "/custom/agent" })?.configPath).toBe(
      "/custom/agent/mcp.json",
    );
    expect(piPath({ PI_CODING_AGENT_DIR: "~/agents/pi" })?.configPath).toBe(
      "/home/a/agents/pi/mcp.json",
    );
    expect(piPath({ PI_CODING_AGENT_DIR: "~" })?.configPath).toBe(
      "/home/a/mcp.json",
    );
    expect(
      piPath({ PI_CODING_AGENT_DIR: "~\\agent" }, "win32")?.markerPath,
    ).toBe(join("/home/a", "agent"));
    // A relative override names a different file in every working directory.
    expect(piPath({ PI_CODING_AGENT_DIR: "agent" })?.configPath).toBe(
      "/home/a/.pi/agent/mcp.json",
    );
    expect(piPath({ PI_CODING_AGENT_DIR: "~\\agent" })?.configPath).toBe(
      "/home/a/.pi/agent/mcp.json",
    );
  });
});

describe("Pi MCP registration", () => {
  const piClient = async () => {
    const home = await createTestTempDirectory("rea-pi-");
    const client = supportedClients(home, process.platform, {}).find(
      ({ name }) => name === "pi",
    );
    if (client?.markerPath === undefined) throw new Error("missing Pi client");
    await mkdir(client.markerPath, { recursive: true });
    return { home, client };
  };

  it("writes a direct stdio entry and leaves sibling servers in place", async () => {
    const { home, client } = await piClient();
    await writeFile(
      client.configPath,
      `{
  // Keep this note.
  "mcpServers": { "other": { "command": "other-server" } }
}
`,
    );
    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const text = await readFile(client.configPath, "utf8");
    expect(text).toContain("// Keep this note.");
    expect(parseJsonc(text)).toEqual({
      mcpServers: {
        other: { command: "other-server" },
        rea: {
          type: "stdio",
          command: "npx",
          args: command.slice(1),
          exposure: "direct",
        },
      },
    });
    expect(await configureClientConfiguration(client, {}, command)).toEqual({
      status: "unchanged",
    });
    expect((await systemUninstallHost(home).removeClient(client)).status).toBe(
      "removed",
    );
    expect(parseJsonc(await readFile(client.configPath, "utf8"))).toEqual({
      mcpServers: { other: { command: "other-server" } },
    });
  });

  it("treats a hidden or non-stdio entry as not aligned", async () => {
    const { home, client } = await piClient();
    const entry = resolve("scripts/rea.mjs");
    const registration = {
      type: "stdio",
      command: process.execPath,
      args: [entry, "mcp"],
      exposure: "direct",
    };
    const status = async () =>
      (
        await readClientRegistrationStatuses(home, entry, { environment: {} })
      ).find(({ client: name }) => name === "pi");
    await writeFile(
      client.configPath,
      JSON.stringify({ mcpServers: { rea: registration } }),
    );
    expect(await status()).toMatchObject({ state: "aligned" });
    await writeFile(
      client.configPath,
      JSON.stringify({
        mcpServers: { rea: { ...registration, enabled: false } },
      }),
    );
    expect(await status()).toMatchObject({ state: "stale" });
    await writeFile(
      client.configPath,
      JSON.stringify({
        mcpServers: { rea: { ...registration, exposure: "codemode" } },
      }),
    );
    expect(await status()).toMatchObject({ state: "stale" });
    await writeFile(
      client.configPath,
      JSON.stringify({
        mcpServers: {
          rea: { command: registration.command, args: registration.args },
        },
      }),
    );
    expect(await status()).toMatchObject({ state: "stale" });
    await writeFile(
      client.configPath,
      JSON.stringify({
        mcpServers: { rea: { ...registration, type: "http" } },
      }),
    );
    expect(await status()).toMatchObject({ state: "invalid" });
    expect(join(home, ".pi", "agent", "mcp.json")).toBe(client.configPath);
  });
});
