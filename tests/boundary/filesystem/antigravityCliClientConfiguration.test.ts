import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readClientRegistrationStatuses } from "../../../src/application/ClientRegistrationStatus.js";
import * as clientConfigurationFiles from "../../../src/application/ClientConfigurationFiles.js";
import { currentClientRegistrationCommand } from "../../../src/application/ClientRegistrationIdentity.js";
import { configureClientConfiguration } from "../../../src/application/SetupClientConfiguration.js";
import { skillDestinations } from "../../../src/application/SetupSkill.js";
import { supportedClients } from "../../../src/application/SupportedClients.js";
import { existingMaintenanceScope } from "../../../src/application/UpdateMaintenance.js";
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

const antigravityCliPath = (
  home: string,
  platform: NodeJS.Platform = "linux",
  env: Parameters<typeof supportedClients>[2] = {},
) =>
  supportedClients(home, platform, env).find(
    ({ name }) => name === "antigravity_cli",
  );

const antigravityIdePath = (
  home: string,
  platform: NodeJS.Platform = "linux",
) =>
  supportedClients(home, platform).find(({ name }) => name === "antigravity");

describe("Antigravity CLI configuration paths", () => {
  it("shares the app's MCP file while keeping its own marker and skills root", () => {
    expect(antigravityCliPath("/home/a")).toEqual({
      name: "antigravity_cli",
      displayName: "Antigravity CLI",
      configPath: join("/home/a", ".gemini", "config", "mcp_config.json"),
      markerPath: join("/home/a", ".gemini", "antigravity-cli"),
      format: "json",
      evidencePath: join("/home/a", ".gemini", "antigravity-cli"),
      registrationGroup: "antigravity",
    });
    expect(antigravityCliPath("/home/a")?.configPath).toBe(
      antigravityIdePath("/home/a")?.configPath,
    );
    expect(antigravityCliPath("C:\\Users\\a", "win32")?.configPath).toBe(
      join("C:\\Users\\a", ".gemini", "config", "mcp_config.json"),
    );
  });

  it("installs a separate skill copy beside the app's own skills root", () => {
    expect(
      skillDestinations("/home/a", ["antigravity", "antigravity_cli"]).map(
        ({ path }) => path,
      ),
    ).toEqual([
      join(
        "/home/a",
        ".gemini",
        "antigravity-cli",
        "skills",
        "reverse-engineer-anything",
      ),
      join(
        "/home/a",
        ".gemini",
        "config",
        "skills",
        "reverse-engineer-anything",
      ),
    ]);
  });
});

describe("Antigravity CLI JSON registration", () => {
  const antigravityCliClient = async () => {
    const home = await createTestTempDirectory("rea-antigravity-cli-");
    const client = antigravityCliPath(home, process.platform);
    if (client?.markerPath === undefined)
      throw new Error("missing Antigravity CLI client");
    await mkdir(client.markerPath, { recursive: true });
    // The shared MCP file lives beside the app's own root, not the CLI marker.
    await mkdir(dirname(client.configPath), { recursive: true });
    return { home, client };
  };

  it("upserts rea into the shared mcpServers table while preserving unrelated settings", async () => {
    const { home, client } = await antigravityCliClient();
    await writeFile(
      client.configPath,
      `{
  "mcpServers": {
    "other": { "command": "other-server" }
  },
  "telemetry": { "enabled": false }
}`,
    );

    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const parsed = JSON.parse(await readFile(client.configPath, "utf8"));
    expect(parsed.mcpServers.other).toEqual({ command: "other-server" });
    expect(parsed.telemetry).toEqual({ enabled: false });
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
      ).find(({ client }) => client === "antigravity_cli"),
    ).toMatchObject({ state: "aligned", command });
  });

  it("creates the mcpServers table in an existing config without servers", async () => {
    const { client } = await antigravityCliClient();
    await writeFile(
      client.configPath,
      JSON.stringify({ ui: { theme: "dark" } }, null, 2),
    );
    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const parsed = JSON.parse(await readFile(client.configPath, "utf8"));
    expect(parsed.ui).toEqual({ theme: "dark" });
    expect(parsed.mcpServers.rea).toEqual({
      command: command[0],
      args: command.slice(1),
    });
  });

  it("removes the shared registration once and skips the second surface", async () => {
    const { home, client } = await antigravityCliClient();
    const ideClient = antigravityIdePath(home, process.platform);
    if (ideClient === undefined) throw new Error("missing Antigravity client");
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
    // The app surface reads the same file; its removal reports the now-absent
    // entry instead of failing the shared configuration.
    expect(
      (await systemUninstallHost(home).removeClient(ideClient)).status,
    ).toBe("skipped");
    const parsed = JSON.parse(await readFile(client.configPath, "utf8"));
    expect(parsed.mcpServers.other).toEqual({ command: "other-server" });
    expect(parsed.mcpServers.rea).toBeUndefined();
  });
});

describe("Antigravity CLI detection", () => {
  const statusFor = async (home: string) =>
    (
      await readClientRegistrationStatuses(home, undefined, {
        platform: process.platform,
        environment: {},
      })
    ).find(({ client }) => client === "antigravity_cli");

  it("stays undetected on an IDE-only home with the shared configuration", async () => {
    const home = await createTestTempDirectory("rea-antigravity-ide-only-");
    await mkdir(join(home, ".gemini", "config"), { recursive: true });
    await writeFile(
      join(home, ".gemini", "config", "mcp_config.json"),
      JSON.stringify({ mcpServers: { other: { command: "other-server" } } }),
    );

    await mkdir(join(home, ".gemini", "config", "skills"), { recursive: true });
    await expect(statusFor(home)).resolves.toBeUndefined();
    expect(
      (
        await readClientRegistrationStatuses(home, undefined, {
          platform: process.platform,
          environment: {},
        })
      ).find(({ client }) => client === "antigravity"),
    ).toBeDefined();
  });

  it("is detected from its own marker on a CLI-only home", async () => {
    const home = await createTestTempDirectory("rea-antigravity-cli-only-");
    await mkdir(join(home, ".gemini", "antigravity-cli"), { recursive: true });

    const client = antigravityCliPath(home, process.platform);
    if (client === undefined) throw new Error("missing CLI");
    await mkdir(dirname(client.configPath), { recursive: true });
    await configureClientConfiguration(client, {}, command);
    expect(
      (
        await readClientRegistrationStatuses(home, undefined, {
          platform: process.platform,
          environment: {},
        })
      ).find(({ client }) => client === "antigravity"),
    ).toBeUndefined();
    await expect(statusFor(home)).resolves.toMatchObject({
      state: "aligned",
    });
  });
});

describe("Antigravity doctor shared snapshot", () => {
  it("reads the shared registration once and reports both surfaces from it", async () => {
    const home = await createTestTempDirectory(
      "rea-antigravity-shared-snapshot-",
    );
    const client = antigravityCliPath(home, process.platform);
    if (client?.markerPath === undefined)
      throw new Error("missing Antigravity CLI client");
    await mkdir(client.markerPath, { recursive: true });
    await mkdir(dirname(client.configPath), { recursive: true });
    await configureClientConfiguration(client, {}, command);
    // Both evidence roots exist, so one doctor run inspects both surfaces.
    await mkdir(join(home, ".gemini", "config", "skills"), { recursive: true });

    const reads = vi.spyOn(
      clientConfigurationFiles,
      "readEffectiveClientRegistrationConfiguration",
    );
    try {
      const statuses = await readClientRegistrationStatuses(home, undefined, {
        platform: process.platform,
        environment: {},
      });
      expect(
        statuses.filter(({ client }) => client.startsWith("antigravity")),
      ).toEqual([
        expect.objectContaining({ client: "antigravity", state: "aligned" }),
        expect.objectContaining({
          client: "antigravity_cli",
          state: "aligned",
        }),
      ]);
      // Other clients may legitimately read their own configurations; only
      // the shared registration must be read once for both surfaces.
      expect(
        reads.mock.calls.filter(([client]) =>
          client.name.startsWith("antigravity"),
        ),
      ).toHaveLength(1);
    } finally {
      reads.mockRestore();
    }
  });
});

it.each(["disabled", "foreign", "invalid"] as const)(
  "does not maintain a config-only Antigravity registration that is %s",
  async (state) => {
    const home = await createTestTempDirectory(
      "rea-antigravity-maintenance-scope-",
    );
    const client = antigravityCliPath(home, process.platform);
    if (client === undefined) throw new Error("missing CLI");
    await mkdir(dirname(client.configPath), { recursive: true });
    const registration =
      state === "foreign"
        ? { command: "node", args: ["foreign-server.js"] }
        : { command: command[0], args: command.slice(1), disabled: true };
    await writeFile(
      client.configPath,
      state === "invalid"
        ? "{"
        : JSON.stringify({ mcpServers: { rea: registration } }),
    );
    const scope = await existingMaintenanceScope(home, "/current/rea", {});
    expect(scope.clients).not.toContain("antigravity");
    expect(scope.clients).not.toContain("antigravity_cli");
    expect(scope.skill).toBe(false);
  },
);
