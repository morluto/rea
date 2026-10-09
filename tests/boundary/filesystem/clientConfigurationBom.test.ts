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
import { systemUninstallHost } from "../../../src/application/Uninstall.js";
import { supportedClients } from "../../../src/application/SupportedClients.js";
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
      const command = [currentCommandPath, "mcp"];
      expect(await inspectClientConfiguration(client, {}, command)).toEqual({
        status: "update",
        backupPath: `${client.configPath}.rea.backup`,
      });
      expect(await clientConfigurationAligned(client, {}, command)).toBe(false);
      expect(await configureClientConfiguration(client, {}, command)).toEqual({
        status: "configured",
        backupPath: `${client.configPath}.rea.backup`,
      });
      const updated = await readFile(client.configPath, "utf8");
      expect(
        updated.startsWith(`${bom}// Keep the client preferences.\r\n`),
      ).toBe(true);
      expect(parseClientConfiguration(updated, client.format).document).toEqual(
        {
          label: "left\uFEFFright",
          [serversKey]: {
            other: { command: "other" },
            rea: clientRegistrationEntry(client.format, command, {}),
          },
          theme: "dark",
        },
      );
      expect(await clientConfigurationAligned(client, {}, command)).toBe(true);
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
      expect(await configureClientConfiguration(client, {}, command)).toEqual({
        status: "unchanged",
      });
      expect(await readFile(client.configPath)).toEqual(Buffer.from(updated));
      expect(await readFile(`${client.configPath}.rea.backup`)).toEqual(
        Buffer.from(original),
      );
    },
  );
});

it.each(['\uFEFF{"servers": {"rea": @}}', '\uFEFF{"setting":\uFEFFtrue}'])(
  "rejects malformed BOM placement without mutation: %j",
  async (original) => {
    const home = await createTestTempDirectory(
      "rea-client-config-bom-invalid-",
    );
    const configPath = join(home, "mcp.json");
    const client = { name: "vscode", format: "vscode", configPath } as const;
    await writeFile(configPath, original);
    const invalidOffset = original.includes("@") ? original.indexOf("@") : 12;
    expect(() => parseClientConfiguration(original, client.format)).toThrow(
      `Invalid JSON/JSONC at offset ${invalidOffset}: InvalidSymbol`,
    );

    expect(
      await inspectClientConfiguration(client, {}, ["rea", "mcp"]),
    ).toMatchObject({ status: "invalid" });
    expect(
      await configureClientConfiguration(client, {}, ["rea", "mcp"]),
    ).toEqual({ status: "failed", reason: "readback" });
    expect(await readFile(configPath)).toEqual(Buffer.from(original));
    expect(await readdir(home)).toEqual(["mcp.json"]);
  },
);

it("restores original BOM-prefixed JSONC bytes after update and removal", async () => {
  const home = await createTestTempDirectory("rea-client-config-bom-cycle-");
  const client = supportedClients(home, "linux", {}).find(
    (candidate) => candidate.name === "cursor",
  );
  if (client?.format !== "json") throw new Error("missing Cursor JSON config");
  const serversKey = clientConfigurationServersKey(client.format);
  const prefix = `\uFEFF{\r\n  // Keep prefix \uFEFF comment.\r\n  "label": "left\uFEFFright",\r\n  "${serversKey}": {\r\n    // Keep this unrelated registration.\r\n    "other": {\r\n      "command": "other\uFEFFtool"\r\n    },\r\n`;
  const suffix = `  },\r\n  // Keep suffix comment.\r\n  "theme": "dark"\r\n}\r\n`;
  const original = `${prefix}${suffix}`;
  await mkdir(dirname(client.configPath), { recursive: true });
  await writeFile(client.configPath, original);

  const firstCommand = [join(home, "bin", "rea"), "mcp"];
  const updatedCommand = [join(home, "updated", "bin", "rea"), "mcp"];
  expect(
    await configureClientConfiguration(client, {}, firstCommand),
  ).toMatchObject({ status: "configured" });
  expect(
    await configureClientConfiguration(client, {}, updatedCommand),
  ).toMatchObject({ status: "configured" });
  const updated = await readFile(client.configPath, "utf8");
  expect(parseClientConfiguration(updated, client.format).servers).toEqual({
    other: { command: "other\uFEFFtool" },
    rea: clientRegistrationEntry(client.format, updatedCommand, {}),
  });

  expect(await systemUninstallHost(home).removeClient(client)).toMatchObject({
    name: "cursor",
    status: "removed",
  });
  expect(await readFile(client.configPath, "utf8")).toBe(original);
});

it.each(["", "\n  \n", "\uFEFF"])(
  "configures an empty client file %j as a new document",
  async (original) => {
    const home = await createTestTempDirectory("rea-client-config-empty-");
    const client = supportedClients(home, "linux", {}).find(
      (candidate) => candidate.name === "antigravity",
    );
    if (client?.format !== "json")
      throw new Error("missing Antigravity JSON config");
    await mkdir(dirname(client.configPath), { recursive: true });
    await writeFile(client.configPath, original);
    const command = [join(home, "rea"), "mcp"];

    expect(await inspectClientConfiguration(client, {}, command)).toEqual({
      status: "update",
      backupPath: `${client.configPath}.rea.backup`,
    });
    expect(await configureClientConfiguration(client, {}, command)).toEqual({
      status: "configured",
      backupPath: `${client.configPath}.rea.backup`,
    });
    expect(JSON.parse(await readFile(client.configPath, "utf8"))).toEqual({
      mcpServers: { rea: clientRegistrationEntry(client.format, command, {}) },
    });
    expect(await inspectClientConfiguration(client, {}, command)).toEqual({
      status: "already_current",
    });
  },
);
