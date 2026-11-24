import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { currentClientRegistrationCommand } from "../../src/application/ClientRegistrationIdentity.js";
import { readClientRegistrationStatuses } from "../../src/application/ClientRegistrationStatus.js";
import { configureClientConfiguration } from "../../src/application/SetupClientConfiguration.js";
import { supportedClients } from "../../src/application/SupportedClients.js";
import { systemUninstallHost } from "../../src/application/Uninstall.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

/** Marker and config paths the registration cases write and read. */
type JsonClientLocation = {
  readonly markerPath: string;
  readonly configPath: string;
};

const defaultUnrelatedServer = { command: "other-server" } as const;

type JsonClientRegistrationContractInput = {
  readonly clientName:
    | "codebuddy"
    | "droid"
    | "freebuff"
    | "qoder"
    | "trae"
    | "workbuddy";
  readonly displayName: string;
  readonly initialSettings: Record<string, unknown>;
  readonly settingsWithoutServers: Record<string, unknown>;
  /**
   * Sibling server left beside `rea`. Defaults to `{ command: "other-server" }`.
   * A caller passes its own object when that object is the preserved caller data.
   */
  readonly unrelatedServer?: Record<string, unknown>;
} & (
  | {
      readonly directory: string;
      readonly filename: string;
      readonly resolveLocation?: undefined;
    }
  | {
      /**
       * Expected paths when they are not `join(home, directory, filename)`.
       * Trae's directory follows the platform, and FreeBuff's marker and
       * config file live in different roots.
       */
      readonly resolveLocation: (
        home: string,
        platform: NodeJS.Platform,
      ) => JsonClientLocation;
      readonly directory?: undefined;
      readonly filename?: undefined;
    }
);

/** Run the JSON registration contract against each client's independently supplied location. */
export const jsonClientRegistrationContract = (
  options: JsonClientRegistrationContractInput,
): void => {
  const {
    clientName,
    displayName,
    initialSettings,
    settingsWithoutServers,
    unrelatedServer = defaultUnrelatedServer,
  } = options;
  const command = currentClientRegistrationCommand({
    platform: process.platform,
  });
  const expectedLocation = (home: string): JsonClientLocation => {
    if (options.resolveLocation !== undefined)
      return options.resolveLocation(home, process.platform);
    if (options.directory === undefined || options.filename === undefined)
      throw new Error(
        `${displayName} JSON registration needs a directory and filename or a location resolver`,
      );
    return {
      markerPath: join(home, options.directory),
      configPath: join(home, options.directory, options.filename),
    };
  };

  describe(`${displayName} JSON registration`, () => {
    const createClient = async () => {
      const home = await createTestTempDirectory(`rea-${clientName}-`);
      const client = supportedClients(home, process.platform, {}).find(
        ({ name }) => name === clientName,
      );
      if (client?.markerPath === undefined)
        throw new Error(`missing ${displayName} client`);
      const location = expectedLocation(home);
      expect(client.markerPath).toBe(location.markerPath);
      expect(client.configPath).toBe(location.configPath);
      // The marker and the config file can live in different directories.
      await mkdir(location.markerPath, { recursive: true });
      await mkdir(dirname(location.configPath), { recursive: true });
      return { home, client };
    };

    it("upserts rea into mcpServers while preserving unrelated settings", async () => {
      const { home, client } = await createClient();
      await writeFile(
        client.configPath,
        JSON.stringify({
          ...initialSettings,
          mcpServers: { other: unrelatedServer },
        }),
      );
      expect(
        (await configureClientConfiguration(client, {}, command)).status,
      ).toBe("configured");
      const parsed = JSON.parse(await readFile(client.configPath, "utf8"));
      for (const [key, value] of Object.entries(initialSettings))
        expect(parsed[key]).toEqual(value);
      expect(parsed.mcpServers.other).toEqual(unrelatedServer);
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
        ).find(({ client }) => client === clientName),
      ).toMatchObject({ state: "aligned", command });
    });

    it("creates the mcpServers table in existing settings without servers", async () => {
      const { client } = await createClient();
      await writeFile(
        client.configPath,
        JSON.stringify(settingsWithoutServers),
      );
      expect(
        (await configureClientConfiguration(client, {}, command)).status,
      ).toBe("configured");
      const parsed = JSON.parse(await readFile(client.configPath, "utf8"));
      for (const [key, value] of Object.entries(settingsWithoutServers))
        expect(parsed[key]).toEqual(value);
      expect(parsed.mcpServers.rea).toEqual({
        command: command[0],
        args: command.slice(1),
      });
    });

    it("registers into an empty settings file", async () => {
      const { client } = await createClient();
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
      const { home, client } = await createClient();
      await writeFile(
        client.configPath,
        JSON.stringify({
          mcpServers: { other: { command: "other-server" } },
        }),
      );
      await configureClientConfiguration(client, {}, command);
      expect(
        (await systemUninstallHost(home).removeClient(client)).status,
      ).toBe("removed");
      const parsed = JSON.parse(await readFile(client.configPath, "utf8"));
      expect(parsed.mcpServers.other).toEqual({ command: "other-server" });
      expect(parsed.mcpServers.rea).toBeUndefined();
    });
  });
};
