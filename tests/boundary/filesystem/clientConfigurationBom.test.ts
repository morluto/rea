import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  clientConfigurationServersKey,
  clientRegistrationEntry,
  parseClientConfiguration,
} from "../../../src/application/ClientConfigurationDocument.js";
import { readClientRegistrationStatuses } from "../../../src/application/ClientRegistrationStatus.js";
import {
  clientConfigurationAligned,
  configureClientConfiguration,
  inspectClientConfiguration,
} from "../../../src/application/SetupClientConfiguration.js";
import { supportedClients } from "../../../src/application/SupportedClients.js";
import { PRODUCT_IDENTITY } from "../../../src/identity.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

describe.each([
  "claude_code",
  "vscode",
  "copilot_cli",
  "opencode",
  "commandcode",
])("client configuration for %s", (name) => {
  it.each(["", "\uFEFF"])(
    "preflights, configures, and reads back prefix %j in an isolated home",
    async (bom) => {
      const home = await createTestTempDirectory("rea-client-config-bom-");
      const client = supportedClients(home, "linux", {}).find(
        (candidate) => candidate.name === name,
      );
      if (client?.format === undefined) throw new Error(`missing ${name}`);
      const serversKey = clientConfigurationServersKey(client.format);
      const original = `${bom}// Keep the client preferences.\r\n${JSON.stringify(
        {
          label: "left\uFEFFright",
          [serversKey]: { other: { command: "other" } },
          theme: "dark",
        },
        null,
        2,
      ).replaceAll("\n", "\r\n")}\r\n`;
      await mkdir(dirname(client.configPath), { recursive: true });
      await writeFile(client.configPath, original);
      const currentCommandPath = join(home, "rea");

      for (const command of [
        ["npx", "-y", PRODUCT_IDENTITY.registrationPackageSpecifier, "mcp"],
        [currentCommandPath, "mcp"],
      ]) {
        expect(await inspectClientConfiguration(client, {}, command)).toEqual({
          status: "update",
          backupPath: `${client.configPath}.rea.backup`,
        });
        expect(await clientConfigurationAligned(client, {}, command)).toBe(
          false,
        );
        expect(await configureClientConfiguration(client, {}, command)).toEqual(
          {
            status: "configured",
            backupPath: `${client.configPath}.rea.backup`,
          },
        );
        const updated = await readFile(client.configPath, "utf8");
        expect(
          updated.startsWith(`${bom}// Keep the client preferences.\r\n`),
        ).toBe(true);
        expect(
          parseClientConfiguration(updated, client.format).document,
        ).toEqual({
          label: "left\uFEFFright",
          [serversKey]: {
            other: { command: "other" },
            rea: clientRegistrationEntry(client.format, command, {}),
          },
          theme: "dark",
        });
        expect(await clientConfigurationAligned(client, {}, command)).toBe(
          true,
        );
        expect(await inspectClientConfiguration(client, {}, command)).toEqual({
          status: "already_current",
        });
        expect(
          await readClientRegistrationStatuses(home, currentCommandPath, {
            platform: "linux",
            environment: {},
          }),
        ).toEqual([
          {
            client: name,
            config_path: client.configPath,
            state: "aligned",
            command,
            remediation: null,
          },
        ]);
        expect(await configureClientConfiguration(client, {}, command)).toEqual(
          {
            status: "unchanged",
          },
        );
        expect(await readFile(client.configPath)).toEqual(Buffer.from(updated));
        expect(await readFile(`${client.configPath}.rea.backup`)).toEqual(
          Buffer.from(original),
        );
      }
    },
  );
});

it("rejects malformed BOM-prefixed JSON without writing or backing it up", async () => {
  const home = await createTestTempDirectory("rea-client-config-bom-invalid-");
  const configPath = join(home, "mcp.json");
  const client = { name: "vscode", format: "vscode", configPath } as const;
  const original = '\uFEFF{"servers": {"rea": @}}';
  await writeFile(configPath, original);

  expect(
    await inspectClientConfiguration(client, {}, ["rea", "mcp"]),
  ).toMatchObject({ status: "invalid" });
  expect(
    await configureClientConfiguration(client, {}, ["rea", "mcp"]),
  ).toEqual({ status: "failed", reason: "readback" });
  expect(await readFile(configPath)).toEqual(Buffer.from(original));
  expect(await readdir(home)).toEqual(["mcp.json"]);
});
