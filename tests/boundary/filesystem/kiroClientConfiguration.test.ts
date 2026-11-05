import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readClientRegistrationStatuses } from "../../../src/application/ClientRegistrationStatus.js";
import { currentClientRegistrationCommand } from "../../../src/application/ClientRegistrationIdentity.js";
import {
  configureClientConfiguration,
  inspectClientConfiguration,
} from "../../../src/application/SetupClientConfiguration.js";
import { skillDestinations } from "../../../src/application/SetupSkill.js";
import { supportedClients } from "../../../src/application/SupportedClients.js";
import { systemUninstallHost } from "../../../src/application/Uninstall.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { clearClientLocationEnvironment } from "../../fixtures/clientEnvironment.js";

const command = currentClientRegistrationCommand();

const registration = {
  command: command[0],
  args: command.slice(1),
  disabled: false,
};

beforeEach(clearClientLocationEnvironment);
afterEach(() => vi.unstubAllEnvs());

const kiroPath = (
  home: string,
  platform: NodeJS.Platform = process.platform,
  env: Parameters<typeof supportedClients>[2] = {},
) => supportedClients(home, platform, env).find(({ name }) => name === "kiro");

const kiroStatus = async (home: string) =>
  (
    await readClientRegistrationStatuses(home, undefined, {
      platform: process.platform,
      environment: {},
    })
  ).find(({ client }) => client === "kiro");

const exists = async (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

/** A temporary home where Kiro is installed but has no settings file yet. */
const kiroClient = async () => {
  const home = await createTestTempDirectory("rea-kiro-");
  const client = kiroPath(home, process.platform);
  if (client?.markerPath === undefined) throw new Error("missing Kiro client");
  await mkdir(dirname(client.configPath), { recursive: true });
  return { home, client };
};

describe("Kiro configuration paths and skills", () => {
  it("resolves the user-level settings/mcp.json shared by Kiro IDE and CLI", () => {
    expect(kiroPath("/home/a")).toEqual({
      name: "kiro",
      displayName: "Kiro",
      configPath: join("/home/a", ".kiro", "settings", "mcp.json"),
      markerPath: join("/home/a", ".kiro"),
      format: "kiro",
    });
    expect(kiroPath("C:\\Users\\a", "win32")?.configPath).toBe(
      join("C:\\Users\\a", ".kiro", "settings", "mcp.json"),
    );
  });

  it("installs the skill into ~/.kiro/skills, which Kiro discovers instead of the shared root", () => {
    expect(
      skillDestinations("/home/a", ["kiro"]).map(({ path }) => path),
    ).toEqual([
      join("/home/a", ".kiro", "skills", "reverse-engineer-anything"),
    ]);
  });
});

describe("Kiro strict JSON registration", () => {
  it("creates settings/mcp.json with an enabled entry and reports it aligned", async () => {
    const { home, client } = await kiroClient();
    await rm(dirname(client.configPath), { recursive: true });
    expect(await inspectClientConfiguration(client, {}, command)).toEqual({
      status: "create",
    });

    expect(await configureClientConfiguration(client, {}, command)).toEqual({
      status: "configured",
    });
    expect(JSON.parse(await readFile(client.configPath, "utf8"))).toEqual({
      mcpServers: { rea: registration },
    });
    expect(await configureClientConfiguration(client, {}, command)).toEqual({
      status: "unchanged",
    });
    expect(await kiroStatus(home)).toMatchObject({ state: "aligned", command });
  });

  it("upserts rea while preserving other servers and top-level keys, with one backup", async () => {
    const { client } = await kiroClient();
    const original = `{
  "mcpServers": {
    "other": {
      "command": "other-server",
      "args": [],
      "disabled": true,
      "autoApprove": []
    }
  },
  "powers": {
    "mcpServers": {}
  }
}
`;
    await writeFile(client.configPath, original);

    expect(await configureClientConfiguration(client, {}, command)).toEqual({
      status: "configured",
      backupPath: `${client.configPath}.rea.backup`,
    });
    const parsed = JSON.parse(await readFile(client.configPath, "utf8"));
    expect(parsed).toEqual({
      mcpServers: {
        other: {
          command: "other-server",
          args: [],
          disabled: true,
          autoApprove: [],
        },
        rea: registration,
      },
      powers: { mcpServers: {} },
    });
    expect(await readFile(`${client.configPath}.rea.backup`, "utf8")).toBe(
      original,
    );
    expect(await configureClientConfiguration(client, {}, command)).toEqual({
      status: "unchanged",
    });
  });

  it("keeps autoApprove, disabledTools, timeout and env when refreshing REA's own prior-release entry", async () => {
    const { home, client } = await kiroClient();
    const callerOwned = {
      autoApprove: ["list_documents"],
      disabledTools: ["capture_browser_scenario"],
      timeout: 180_000,
    };
    await writeFile(
      client.configPath,
      JSON.stringify({
        mcpServers: {
          rea: {
            command: "npx",
            args: ["-y", "rea-agents@6.1.0", "mcp"],
            env: { REA_ANALYSIS_PROVIDER: "ghidra" },
            ...callerOwned,
          },
        },
      }),
    );
    expect(await kiroStatus(home)).toMatchObject({ state: "stale" });

    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    expect(
      JSON.parse(await readFile(client.configPath, "utf8")).mcpServers.rea,
    ).toEqual({
      ...registration,
      env: { REA_ANALYSIS_PROVIDER: "ghidra" },
      ...callerOwned,
    });
    expect(await configureClientConfiguration(client, {}, command)).toEqual({
      status: "unchanged",
    });
    expect(await kiroStatus(home)).toMatchObject({ state: "aligned" });
  });

  it("leaves a foreign rea server unchanged, so its autoApprove grant never reaches REA", async () => {
    const { client } = await kiroClient();
    const original = JSON.stringify({
      mcpServers: {
        rea: {
          command: "/opt/other/bin/other-server",
          args: ["serve"],
          autoApprove: ["*"],
          disabledTools: ["delete_everything"],
        },
      },
    });
    await writeFile(client.configPath, original);

    expect(await inspectClientConfiguration(client, {}, command)).toEqual({
      status: "invalid",
      remediation: expect.stringContaining("foreign ownership"),
    });
    expect(await configureClientConfiguration(client, {}, command)).toEqual({
      status: "failed",
      reason: "registration_ownership",
      detail: expect.stringContaining("foreign ownership"),
    });
    expect(await readFile(client.configPath, "utf8")).toBe(original);
    expect(await exists(`${client.configPath}.rea.backup`)).toBe(false);
  });

  it("reports a disabled registration as stale and re-enables it on setup", async () => {
    const { home, client } = await kiroClient();
    await writeFile(
      client.configPath,
      JSON.stringify({
        mcpServers: { rea: { ...registration, disabled: true } },
      }),
    );
    expect(await kiroStatus(home)).toMatchObject({ state: "stale", command });

    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    expect(
      JSON.parse(await readFile(client.configPath, "utf8")).mcpServers.rea,
    ).toEqual(registration);
    expect(await kiroStatus(home)).toMatchObject({ state: "aligned" });
  });
});

describe("Kiro unloadable, empty and uninstalled mcp.json", () => {
  const rea = JSON.stringify(registration);
  it.each([
    ["a comment", `{\n  // note\n  "mcpServers": { "rea": ${rea} }\n}\n`],
    ["a trailing comma", `{ "mcpServers": { "rea": ${rea}, } }`],
    ["a byte order mark", `\uFEFF{ "mcpServers": { "rea": ${rea} } }`],
  ])(
    "refuses an mcp.json Kiro cannot load because of %s in setup, doctor and uninstall, without changing bytes",
    async (_reason, original) => {
      const { home, client } = await kiroClient();
      await writeFile(client.configPath, original);

      expect(
        (await inspectClientConfiguration(client, {}, command)).status,
      ).toBe("invalid");
      expect(
        (await configureClientConfiguration(client, {}, command)).status,
      ).toBe("failed");
      expect(await kiroStatus(home)).toMatchObject({ state: "invalid" });
      expect(
        await systemUninstallHost(home).removeClient(client),
      ).toMatchObject({
        status: "failed",
        detail: expect.stringContaining("not valid JSON"),
      });
      expect(await readFile(client.configPath, "utf8")).toBe(original);
      expect(await exists(`${client.configPath}.rea.backup`)).toBe(false);
    },
  );

  it.each([
    ["timeout", "90000"],
    ["timeout", 1.5],
    ["timeout", null],
    ["disabledTools", "capture_browser_scenario"],
  ])(
    "refuses REA's entry with a %s Kiro cannot load (%j), names it, and still uninstalls",
    async (member, value) => {
      const { home, client } = await kiroClient();
      const original = JSON.stringify({
        mcpServers: {
          other: { command: "other-server" },
          rea: { ...registration, [member]: value },
        },
      });
      await writeFile(client.configPath, original);

      expect(await inspectClientConfiguration(client, {}, command)).toEqual({
        status: "invalid",
        remediation: expect.stringContaining(`${member}: Kiro requires`),
      });
      expect(
        (await configureClientConfiguration(client, {}, command)).status,
      ).toBe("failed");
      expect(await readFile(client.configPath, "utf8")).toBe(original);
      expect(await exists(`${client.configPath}.rea.backup`)).toBe(false);
      expect(await kiroStatus(home)).toMatchObject({
        state: "invalid",
        remediation: expect.stringContaining(member),
      });

      expect(
        (await systemUninstallHost(home).removeClient(client)).status,
      ).toBe("removed");
      expect(JSON.parse(await readFile(client.configPath, "utf8"))).toEqual({
        mcpServers: { other: { command: "other-server" } },
      });
    },
  );

  it("registers into an empty mcp.json, which holds no settings to preserve", async () => {
    const { client } = await kiroClient();
    await writeFile(client.configPath, "");
    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    expect(JSON.parse(await readFile(client.configPath, "utf8"))).toEqual({
      mcpServers: { rea: registration },
    });
  });

  it("removes only the rea entry on uninstall", async () => {
    const { home, client } = await kiroClient();
    await writeFile(
      client.configPath,
      JSON.stringify(
        {
          mcpServers: { other: { command: "other-server" } },
          powers: { mcpServers: {} },
        },
        null,
        2,
      ),
    );
    await configureClientConfiguration(client, {}, command);

    expect((await systemUninstallHost(home).removeClient(client)).status).toBe(
      "removed",
    );
    expect(JSON.parse(await readFile(client.configPath, "utf8"))).toEqual({
      mcpServers: { other: { command: "other-server" } },
      powers: { mcpServers: {} },
    });
  });

  it("keeps an empty mcpServers table after removing the only server, since Kiro rejects a file without one", async () => {
    const { home, client } = await kiroClient();
    await configureClientConfiguration(client, {}, command);

    expect((await systemUninstallHost(home).removeClient(client)).status).toBe(
      "removed",
    );
    expect(JSON.parse(await readFile(client.configPath, "utf8"))).toEqual({
      mcpServers: {},
    });
  });
});
