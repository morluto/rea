import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { expect, it } from "vitest";

import { readClientRegistrationStatuses } from "../../../src/application/ClientRegistrationStatus.js";
import {
  configureClientConfiguration,
  inspectClientConfiguration,
} from "../../../src/application/SetupClientConfiguration.js";
import { supportedClients } from "../../../src/application/SupportedClients.js";
import { systemUninstallHost } from "../../../src/application/Uninstall.js";
import { PRODUCT_IDENTITY } from "../../../src/identity.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it.each(["codebuddy", "workbuddy"] as const)(
  "%s retains ownership independently of its partial native write profile",
  async (name) => {
    const home = await createTestTempDirectory("rea-partial-client-profile-");
    const environment = {
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, "xdg"),
      APPDATA: join(home, "appdata"),
      LOCALAPPDATA: join(home, "localappdata"),
    };
    const client = supportedClients(home, process.platform, environment).find(
      (candidate) => candidate.name === name,
    );
    if (client === undefined) throw new Error(`Missing native client ${name}`);
    const command = [
      "npx",
      "-y",
      PRODUCT_IDENTITY.registrationPackageSpecifier,
      "mcp",
    ];
    await mkdir(dirname(client.configPath), { recursive: true });
    expect(
      await configureClientConfiguration(client, {}, command),
    ).toMatchObject({ status: "configured" });
    expect(await configureClientConfiguration(client, {}, command)).toEqual({
      status: "unchanged",
    });

    // This field has no established native interpretation in the documented
    // stdio-only profile. Its presence does not erase the parsed REA launcher.
    const source = `${JSON.stringify({
      mcpServers: {
        rea: {
          command: command[0],
          args: command.slice(1),
          caller_native_policy: { selected: true },
        },
        peer: { command: "peer", args: [] },
      },
    })}\n`;
    await writeFile(client.configPath, source);
    const directoryEntries = await readdir(dirname(client.configPath));
    expect(await inspectClientConfiguration(client, {}, command)).toMatchObject(
      {
        status: "invalid",
        remediation: expect.stringContaining("Write applicability"),
      },
    );
    expect(
      await configureClientConfiguration(client, {}, command),
    ).toMatchObject({ status: "failed", reason: "readback" });
    expect(await readFile(client.configPath, "utf8")).toBe(source);
    expect(await readdir(dirname(client.configPath))).toEqual(directoryEntries);
    expect(
      (
        await readClientRegistrationStatuses(home, undefined, {
          environment,
          selectedClientIds: [name],
        })
      ).find((status) => status.client === name),
    ).toMatchObject({
      state: "unknown",
      command_identity: "owned",
      command,
    });

    const uninstall = systemUninstallHost(
      home,
      undefined,
      environment,
      process.platform,
    );
    try {
      expect(await uninstall.inspectClient(client)).toBeUndefined();
      expect(await uninstall.removeClient(client)).toMatchObject({
        status: "removed",
      });
      expect(JSON.parse(await readFile(client.configPath, "utf8"))).toEqual({
        mcpServers: { peer: { command: "peer", args: [] } },
      });
    } finally {
      expect(await uninstall.close?.()).toBeUndefined();
    }
  },
);
