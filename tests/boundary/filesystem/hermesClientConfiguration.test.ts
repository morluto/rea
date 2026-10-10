import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

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

const hermesPath = (
  env: Parameters<typeof supportedClients>[2],
  platform: NodeJS.Platform = "linux",
) =>
  supportedClients(join("/home/a"), platform, env).find(
    ({ name }) => name === "hermes",
  );

describe("Hermes configuration paths", () => {
  it("resolves config.yaml under the platform Hermes home", () => {
    expect(hermesPath({})).toEqual({
      name: "hermes",
      displayName: "Hermes",
      configPath: join("/home/a", ".hermes", "config.yaml"),
      markerPath: join("/home/a", ".hermes"),
      format: "hermes",
    });
    // Windows uses the native data directory, matching Hermes's own resolver.
    expect(
      hermesPath({ LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" }, "win32")
        ?.configPath,
    ).toBe(join("C:\\Users\\a\\AppData\\Local", "hermes", "config.yaml"));
  });

  it("honours HERMES_HOME and Hermes's data-directory suffix", () => {
    expect(
      hermesPath({ HERMES_HOME: join("/srv", "hermes") })?.configPath,
    ).toBe(join("/srv", "hermes", "config.yaml"));
    // A blank override falls through to the platform default.
    expect(hermesPath({ HERMES_HOME: "  " })?.configPath).toBe(
      join("/home/a", ".hermes", "config.yaml"),
    );
    // Hermes appends the suffix to the literal directory name.
    expect(hermesPath({ HERMES_DATA_DIR_SUFFIX: "-dev" })?.configPath).toBe(
      join("/home/a", ".hermes-dev", "config.yaml"),
    );
    expect(
      hermesPath(
        {
          HERMES_DATA_DIR_SUFFIX: "-dev",
          LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local",
        },
        "win32",
      )?.configPath,
    ).toBe(join("C:\\Users\\a\\AppData\\Local", "hermes-dev", "config.yaml"));
  });
});

describe("Hermes YAML registration", () => {
  const hermesClient = async () => {
    const home = await createTestTempDirectory("rea-hermes-");
    const client = supportedClients(home, process.platform, {}).find(
      ({ name }) => name === "hermes",
    );
    if (client?.markerPath === undefined)
      throw new Error("missing Hermes client");
    await mkdir(client.markerPath, { recursive: true });
    return { home, client };
  };

  it("writes mcp_servers, preserves comments, reads back, and uninstalls", async () => {
    const { home, client } = await hermesClient();
    await writeFile(
      client.configPath,
      `# Hermes configuration
display:
  language: en
mcp_servers:
  # An independently managed server.
  other:
    command: other-server
`,
    );

    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const text = await readFile(client.configPath, "utf8");
    expect(text).toContain("# Hermes configuration");
    expect(text).toContain("# An independently managed server.");
    expect(parseYaml(text)).toEqual({
      display: { language: "en" },
      mcp_servers: {
        other: { command: "other-server" },
        rea: { command: command[0], args: command.slice(1), enabled: true },
      },
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
      ).find(({ client: name }) => name === "hermes"),
    ).toMatchObject({ state: "aligned", command });

    expect((await systemUninstallHost(home).removeClient(client)).status).toBe(
      "removed",
    );
    expect(parseYaml(await readFile(client.configPath, "utf8"))).toEqual({
      display: { language: "en" },
      mcp_servers: { other: { command: "other-server" } },
    });
  });

  it("creates config.yaml when Hermes has no configuration yet", async () => {
    const { client } = await hermesClient();
    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    expect(parseYaml(await readFile(client.configPath, "utf8"))).toEqual({
      mcp_servers: {
        rea: { command: command[0], args: command.slice(1), enabled: true },
      },
    });
  });
});
