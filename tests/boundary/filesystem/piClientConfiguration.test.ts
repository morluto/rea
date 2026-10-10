import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readClientRegistrationStatuses } from "../../../src/application/ClientRegistrationStatus.js";
import {
  clientConfigurationAligned,
  configureClientConfiguration,
  inspectClientConfiguration,
} from "../../../src/application/SetupClientConfiguration.js";
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
  cwd = "/workspace",
) =>
  supportedClients("/home/a", platform, env, cwd).find(
    ({ name }) => name === "pi",
  );

const piClient = async () => {
  const home = await createTestTempDirectory("rea-pi-");
  const client = supportedClients(home, process.platform, {}).find(
    ({ name }) => name === "pi",
  );
  if (client?.markerPath === undefined) throw new Error("missing Pi client");
  await mkdir(client.markerPath, { recursive: true });
  return { home, client };
};

const callableExposures = [
  undefined,
  "codemode",
  "codemode-deferred",
  "deferred",
  "direct",
] as const;

const piStatus = async (home: string) =>
  (
    await readClientRegistrationStatuses(home, undefined, { environment: {} })
  ).find(({ client }) => client === "pi");

const readDocument = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(path, "utf8"));

describe("Pi configuration paths", () => {
  it("uses ~/.pi/agent and expands absolute, relative, and tilde overrides", () => {
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
    expect(piPath({ PI_CODING_AGENT_DIR: "agent" })?.configPath).toBe(
      "/workspace/agent/mcp.json",
    );
    expect(piPath({ PI_CODING_AGENT_DIR: "../agent" })?.configPath).toBe(
      "/agent/mcp.json",
    );
    expect(piPath({ PI_CODING_AGENT_DIR: "~\\agent" })?.configPath).toBe(
      "/workspace/~\\agent/mcp.json",
    );
    expect(
      supportedClients("/home/a", "linux", {
        PI_CODING_AGENT_DIR: "agent",
      }).find(({ name }) => name === "pi")?.configPath,
    ).toBe(resolve("agent", "mcp.json"));
  });

  it("uses a relative override for setup and doctor without creating the default file", async () => {
    const home = await createTestTempDirectory("rea-pi-relative-");
    const agentDirectory = join(home, "selected-agent");
    const environment = {
      PI_CODING_AGENT_DIR: relative(process.cwd(), agentDirectory),
    };
    const client = supportedClients(home, process.platform, environment).find(
      ({ name }) => name === "pi",
    );
    if (client === undefined) throw new Error("missing Pi client");
    expect(client.configPath).toBe(join(agentDirectory, "mcp.json"));
    expect(await inspectClientConfiguration(client, {}, command)).toEqual({
      status: "create",
    });
    expect(await configureClientConfiguration(client, {}, command)).toEqual({
      status: "configured",
    });
    expect(
      await readClientRegistrationStatuses(home, undefined, { environment }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          client: "pi",
          state: "aligned",
          config_path: client.configPath,
        }),
      ]),
    );
    await expect(
      readFile(join(home, ".pi", "agent", "mcp.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("Pi MCP registration", () => {
  it("writes a default-codemode stdio entry and leaves sibling servers in place", async () => {
    const { home, client } = await piClient();
    await writeFile(
      client.configPath,
      JSON.stringify({
        autoEnableCodemode: true,
        mcpServers: { other: { command: "other-server" } },
      }),
    );
    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    expect(await readDocument(client.configPath)).toEqual({
      autoEnableCodemode: true,
      mcpServers: {
        other: { command: "other-server" },
        rea: {
          type: "stdio",
          command: "npx",
          args: command.slice(1),
        },
      },
    });
    expect(await configureClientConfiguration(client, {}, command)).toEqual({
      status: "unchanged",
    });
    expect((await systemUninstallHost(home).removeClient(client)).status).toBe(
      "removed",
    );
    expect(await readDocument(client.configPath)).toEqual({
      autoEnableCodemode: true,
      mcpServers: { other: { command: "other-server" } },
    });
  });

  it.each(callableExposures)(
    "accepts callable exposure %s with explicit or inferred stdio",
    async (exposure) => {
      const { home, client } = await piClient();
      for (const type of [undefined, "stdio"]) {
        await writeFile(
          client.configPath,
          JSON.stringify({
            mcpServers: {
              rea: { type, command: "npx", args: command.slice(1), exposure },
            },
          }),
        );
        expect(await piStatus(home)).toMatchObject({ state: "aligned" });
      }
    },
  );

  it.each([
    [{ exposure: "hidden" }, "stale"],
    [{ enabled: false }, "stale"],
    [{ disabled: true }, "stale"],
    [{ exposure: "invalid" }, "stale"],
    [{ exposure: 1 }, "invalid"],
    [{ type: "http" }, "invalid"],
  ] as const)(
    "does not align an unavailable or invalid entry %j",
    async (preferences, state) => {
      const { home, client } = await piClient();
      await writeFile(
        client.configPath,
        JSON.stringify({
          mcpServers: {
            rea: { command: "npx", args: command.slice(1), ...preferences },
          },
        }),
      );
      expect(await piStatus(home)).toMatchObject({ state });
    },
  );
});

describe("Pi exposure preference preservation", () => {
  it.each([...callableExposures, "hidden"])(
    "preserves exposure %s and toolExposure when refreshing command and environment",
    async (exposure) => {
      const { home, client } = await piClient();
      const toolExposure = {
        inspect_binary: "direct",
        "get_*": "codemode",
        "find_*": "codemode-deferred",
        "list_*": "deferred",
        "delete_*": "hidden",
      };
      const original = JSON.stringify({
        mcpServers: {
          rea: {
            command: "old-command",
            env: { OLD: "old-value" },
            exposure,
            toolExposure,
            unrelated: "do not carry forward",
          },
        },
      });
      await writeFile(client.configPath, original);
      const environment = { REA_GHIDRA_INSTALL_DIR: "/selected/ghidra" };
      expect(
        await inspectClientConfiguration(client, environment, command),
      ).toMatchObject({ status: "update" });
      expect(
        await clientConfigurationAligned(client, environment, command),
      ).toBe(false);
      expect(
        await configureClientConfiguration(client, environment, command),
      ).toMatchObject({ status: "configured" });
      expect(await readDocument(client.configPath)).toEqual({
        mcpServers: {
          rea: {
            type: "stdio",
            command: "npx",
            args: command.slice(1),
            env: environment,
            ...(exposure === undefined ? {} : { exposure }),
            toolExposure,
          },
        },
      });
      expect(await readFile(`${client.configPath}.rea.backup`, "utf8")).toBe(
        original,
      );
      expect(
        await inspectClientConfiguration(client, environment, command),
      ).toEqual({ status: "already_current" });
      expect(
        await clientConfigurationAligned(client, environment, command),
      ).toBe(true);
      expect(
        await configureClientConfiguration(client, environment, command),
      ).toEqual({ status: "unchanged" });
      expect(await piStatus(home)).toMatchObject({
        state: exposure === "hidden" ? "stale" : "aligned",
      });
    },
  );

  it.each([
    [
      { exposure: "invalid", toolExposure: { "delete_*": "hidden" } },
      { toolExposure: { "delete_*": "hidden" } },
    ],
    [
      { exposure: "hidden", toolExposure: { "get_*": "invalid" } },
      { exposure: "hidden" },
    ],
    [{ exposure: "invalid", toolExposure: [] }, {}],
  ])(
    "preserves only valid exposure preferences from %j",
    async (preferences, preserved) => {
      const { client } = await piClient();
      await writeFile(
        client.configPath,
        JSON.stringify({
          mcpServers: { rea: { command: "old", ...preferences } },
        }),
      );
      expect(
        await configureClientConfiguration(client, {}, command),
      ).toMatchObject({ status: "configured" });
      expect(await readDocument(client.configPath)).toEqual({
        mcpServers: {
          rea: {
            type: "stdio",
            command: "npx",
            args: command.slice(1),
            ...preserved,
          },
        },
      });
    },
  );
});

describe("Pi strict JSON configuration", () => {
  it.each([
    ["comments", '{ // Pi does not accept JSONC\n "mcpServers": {} }'],
    ["trailing comma", '{ "mcpServers": {}, }'],
    ["BOM", '\uFEFF{ "mcpServers": {} }'],
    ["empty file", ""],
    ["whitespace-only file", " \n\t"],
  ])(
    "rejects %s in setup, doctor, and preflight without mutation",
    async (_name, original) => {
      const { home, client } = await piClient();
      await writeFile(client.configPath, original);
      expect(
        await inspectClientConfiguration(client, {}, command),
      ).toMatchObject({ status: "invalid" });
      expect(await clientConfigurationAligned(client, {}, command)).toBe(false);
      expect(await piStatus(home)).toMatchObject({ state: "invalid" });
      expect(await configureClientConfiguration(client, {}, command)).toEqual({
        status: "failed",
        reason: "readback",
      });
      expect(await readFile(client.configPath, "utf8")).toBe(original);
      expect(await readdir(join(home, ".pi", "agent"))).toEqual(["mcp.json"]);
      await expect(
        readFile(`${client.configPath}.rea.backup`),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
});
