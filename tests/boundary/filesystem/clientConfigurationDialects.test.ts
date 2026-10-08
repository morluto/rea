import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";

import { readClientRegistrationStatuses } from "../../../src/application/ClientRegistrationStatus.js";
import { configureClientConfiguration } from "../../../src/application/SetupClientConfiguration.js";
import { systemUninstallHost } from "../../../src/application/Uninstall.js";
import { supportedClients } from "../../../src/application/SupportedClients.js";
import { PRODUCT_IDENTITY } from "../../../src/identity.js";
import { isOwnedClientRegistrationCommand } from "../../../src/application/ClientRegistrationIdentity.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const command = [
  "npx",
  "-y",
  PRODUCT_IDENTITY.registrationPackageSpecifier,
  "mcp",
] as const;

beforeEach(() => {
  for (const name of [
    "APPDATA",
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    "COPILOT_HOME",
    "GROK_HOME",
    "OPENCODE_CONFIG",
    "SAND_DATA_ROOT",
    "XDG_CONFIG_HOME",
  ])
    vi.stubEnv(name, undefined);
});

afterEach(() => vi.unstubAllEnvs());

const getClients = (home: string) =>
  supportedClients(home).filter(({ name }) =>
    [
      "opencode",
      "antigravity",
      "copilot_cli",
      "commandcode",
      "vscode",
      "devin",
    ].includes(name),
  );

describe("additional client configuration dialects", () => {
  it.each([
    "opencode",
    "antigravity",
    "copilot_cli",
    "commandcode",
    "vscode",
    "devin",
  ] as const)("registers, reads back, and uninstalls %s", async (name) => {
    const home = await createTestTempDirectory("rea-client-dialect-");
    const client = getClients(home).find(
      (candidate) => candidate.name === name,
    );
    if (client === undefined) throw new Error(`missing ${name} client`);

    await mkdir(client.markerPath ?? home, { recursive: true });
    const configured = await configureClientConfiguration(client, {}, command);
    expect(configured.status).toBe("configured");
    expect(await configureClientConfiguration(client, {}, command)).toEqual({
      status: "unchanged",
    });

    const text = await readFile(client.configPath, "utf8");
    const document = parseJsonc(text) as Record<string, unknown>;
    const serversKey =
      name === "opencode"
        ? "mcp"
        : name === "vscode"
          ? "servers"
          : "mcpServers";
    const servers = document[serversKey] as Record<
      string,
      Record<string, unknown>
    >;
    const registration = servers[PRODUCT_IDENTITY.mcpServerKey];
    expect(registration).toBeDefined();
    if (name === "opencode")
      expect(registration).toMatchObject({
        type: "local",
        command,
        enabled: true,
      });
    if (name === "vscode")
      expect(registration).toMatchObject({
        type: "stdio",
        command: "npx",
        args: command.slice(1),
      });
    if (name === "copilot_cli")
      expect(registration).toMatchObject({ type: "stdio", tools: ["*"] });
    if (name === "commandcode")
      expect(registration).toMatchObject({
        transport: "stdio",
        enabled: true,
        command: "npx",
        args: command.slice(1),
      });

    const statuses = await readClientRegistrationStatuses(home);
    expect(statuses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ client: name, state: "aligned", command }),
      ]),
    );

    const removed = await systemUninstallHost(home).removeClient(client);
    expect(removed.status).toBe("removed");
    const afterRemoval = parseJsonc(
      await readFile(client.configPath, "utf8"),
    ) as Record<string, unknown>;
    expect(
      (afterRemoval[serversKey] as Record<string, unknown>)[
        PRODUCT_IDENTITY.mcpServerKey
      ],
    ).toBeUndefined();
  });

  it("preserves OpenCode JSONC comments and sibling registrations during update and removal", async () => {
    const home = await createTestTempDirectory("rea-opencode-jsonc-");
    const client = getClients(home).find(({ name }) => name === "opencode");
    if (client === undefined) throw new Error("missing OpenCode client");
    await mkdir(client.markerPath ?? home, { recursive: true });
    const original = `{
  // Client-wide preferences stay intact.
  "model": "provider/model",
  "mcp": {
    // An independently managed server.
    "other": { "type": "local", "command": ["node", "other.js"] },
  },
}\n`;
    await writeFile(client.configPath, original);

    expect(
      await configureClientConfiguration(client, {}, command),
    ).toMatchObject({
      status: "configured",
      backupPath: `${client.configPath}.rea.backup`,
    });
    const updated = await readFile(client.configPath, "utf8");
    const errors: ParseError[] = [];
    const parsed = parseJsonc(updated, errors, {
      allowTrailingComma: true,
    }) as Record<string, unknown>;
    expect(errors).toEqual([]);
    expect(updated).toContain("// Client-wide preferences stay intact.");
    expect(updated).toContain("// An independently managed server.");
    expect(parsed.model).toBe("provider/model");
    expect((parsed.mcp as Record<string, unknown>).other).toBeDefined();
    expect(await readFile(`${client.configPath}.rea.backup`, "utf8")).toBe(
      original,
    );

    expect((await systemUninstallHost(home).removeClient(client)).status).toBe(
      "removed",
    );
    const removedText = await readFile(client.configPath, "utf8");
    const removedErrors: ParseError[] = [];
    const removed = parseJsonc(removedText, removedErrors, {
      allowTrailingComma: true,
    }) as Record<string, unknown>;
    expect(removedErrors).toEqual([]);
    expect(removedText).toContain("// Client-wide preferences stay intact.");
    expect(removedText).toContain("// An independently managed server.");
    expect((removed.mcp as Record<string, unknown>).rea).toBeUndefined();
    expect((removed.mcp as Record<string, unknown>).other).toBeDefined();
  });

  it("rejects malformed OpenCode JSONC without creating a backup or changing bytes", async () => {
    const home = await createTestTempDirectory("rea-opencode-invalid-");
    const client = getClients(home).find(({ name }) => name === "opencode");
    if (client === undefined) throw new Error("missing OpenCode client");
    await mkdir(client.markerPath ?? home, { recursive: true });
    const invalid = '{ "mcp": { /* broken */ "rea": [ }';
    await writeFile(client.configPath, invalid);

    expect(await configureClientConfiguration(client, {}, command)).toEqual({
      status: "failed",
      reason: "readback",
    });
    expect(await readFile(client.configPath, "utf8")).toBe(invalid);
  });
});

const parseOpenCode = (text: string): Record<string, unknown> => {
  const errors: ParseError[] = [];
  const document = parseJsonc(text, errors, {
    allowTrailingComma: true,
  }) as Record<string, unknown>;
  expect(errors).toEqual([]);
  return document;
};

const openCodeClient = async (prefix: string) => {
  const home = await createTestTempDirectory(prefix);
  const client = getClients(home).find(({ name }) => name === "opencode");
  if (client === undefined) throw new Error("missing OpenCode client");
  await mkdir(client.markerPath ?? home, { recursive: true });
  return { home, client };
};

const legacyEntry = JSON.stringify({ type: "local", command, enabled: true });

describe("OpenCode V2 native server table", () => {
  it("registers in mcp.servers, replaces REA's V1 entry, and uninstalls", async () => {
    const { home, client } = await openCodeClient("rea-opencode-v2-");
    await writeFile(
      client.configPath,
      `{
  "mcp": {
    // Default timeouts are not a server.
    "timeout": { "catalog": 30000 },
    "servers": {
      // An independently managed server.
      "other": { "type": "local", "command": ["node", "other.js"] },
    },
    "rea": ${legacyEntry},
  },
}\n`,
    );

    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    expect(await configureClientConfiguration(client, {}, command)).toEqual({
      status: "unchanged",
    });
    const text = await readFile(client.configPath, "utf8");
    expect(text).toContain("// Default timeouts are not a server.");
    expect(text).toContain("// An independently managed server.");
    expect(parseOpenCode(text).mcp).toEqual({
      timeout: { catalog: 30000 },
      servers: {
        other: { type: "local", command: ["node", "other.js"] },
        rea: { type: "local", command: [...command] },
      },
    });
    expect(await readClientRegistrationStatuses(home)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          client: "opencode",
          state: "aligned",
          command,
        }),
      ]),
    );

    expect((await systemUninstallHost(home).removeClient(client)).status).toBe(
      "removed",
    );
    expect(
      parseOpenCode(await readFile(client.configPath, "utf8")).mcp,
    ).toEqual({
      timeout: { catalog: 30000 },
      servers: { other: { type: "local", command: ["node", "other.js"] } },
    });
  });

  it("updates and removes REA's entry after OpenCode migrates it to mcp.servers", async () => {
    const { home, client } = await openCodeClient("rea-opencode-migrated-");
    const stale = ["npx", "-y", `${PRODUCT_IDENTITY.packageName}@3.2.0`, "mcp"];
    await writeFile(
      client.configPath,
      `${JSON.stringify({ mcp: { servers: { rea: { type: "local", command: stale } } } })}\n`,
    );

    expect(await readClientRegistrationStatuses(home)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ client: "opencode", command: stale }),
      ]),
    );
    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    expect(
      parseOpenCode(await readFile(client.configPath, "utf8")).mcp,
    ).toEqual({
      servers: { rea: { type: "local", command: [...command] } },
    });
    expect((await systemUninstallHost(home).removeClient(client)).status).toBe(
      "removed",
    );
    expect(
      parseOpenCode(await readFile(client.configPath, "utf8")).mcp,
    ).toEqual({
      servers: {},
    });
  });

  it("reports and removes a V1 entry that OpenCode still loads beside mcp.servers", async () => {
    const { home, client } = await openCodeClient("rea-opencode-mixed-");
    await writeFile(
      client.configPath,
      `{ "mcp": { "servers": {}, "rea": ${legacyEntry} } }\n`,
    );

    expect(await readClientRegistrationStatuses(home)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          client: "opencode",
          state: "aligned",
          command,
        }),
      ]),
    );
    expect((await systemUninstallHost(home).removeClient(client)).status).toBe(
      "removed",
    );
    expect(
      parseOpenCode(await readFile(client.configPath, "utf8")).mcp,
    ).toEqual({
      servers: {},
    });
  });

  it("treats a V2 table holding a server named type as native", async () => {
    const { home, client } = await openCodeClient("rea-opencode-type-server-");
    const typeServer = { type: "local", command: ["node", "type.js"] };
    await writeFile(
      client.configPath,
      `${JSON.stringify({ mcp: { servers: { type: typeServer, rea: { type: "local", command } } } })}\n`,
    );

    expect(await readClientRegistrationStatuses(home)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          client: "opencode",
          state: "aligned",
          command,
        }),
      ]),
    );
    expect((await systemUninstallHost(home).removeClient(client)).status).toBe(
      "removed",
    );
    expect(
      parseOpenCode(await readFile(client.configPath, "utf8")).mcp,
    ).toEqual({
      servers: { type: typeServer },
    });
  });

  it("keeps a V1 server named servers in the V1 table", async () => {
    const { client } = await openCodeClient("rea-opencode-v1-servers-");
    const servers = { type: "local", command: ["node", "servers.js"] };
    await writeFile(
      client.configPath,
      `${JSON.stringify({ mcp: { servers } })}\n`,
    );

    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    expect(
      parseOpenCode(await readFile(client.configPath, "utf8")).mcp,
    ).toEqual({
      servers,
      rea: { type: "local", command: [...command], enabled: true },
    });
  });
});

describe("platform-aware client config paths", () => {
  it.each([
    [
      "darwin",
      "/home/a",
      {},
      "/home/a/Library/Application Support/Code/User/mcp.json",
    ],
    ["linux", "/home/a", {}, "/home/a/.config/Code/User/mcp.json"],
    [
      "win32",
      "C:/Users/a",
      {},
      "C:/Users/a/AppData/Roaming/Code/User/mcp.json",
    ],
    [
      "linux",
      "/home/a",
      { XDG_CONFIG_HOME: "/config" },
      "/config/Code/User/mcp.json",
    ],
  ] as const)(
    "resolves VS Code user MCP path for %s",
    (platform, home, env, expected) => {
      expect(
        supportedClients(home, platform, env).find(
          ({ name }) => name === "vscode",
        )?.configPath,
      ).toBe(expected);
    },
  );

  it("honors Grok Build and Grok Bot configuration roots", () => {
    expect(
      supportedClients("/home/a", "linux", {
        GROK_HOME: "/custom/grok",
        SAND_DATA_ROOT: "/custom/grokbot",
      }).filter(({ name }) => name === "grok_build" || name === "grok_bot"),
    ).toEqual([
      expect.objectContaining({
        name: "grok_build",
        displayName: "Grok Build",
        configPath: "/custom/grok/config.toml",
        markerPath: "/custom/grok",
        format: "grok",
      }),
      expect.objectContaining({
        name: "grok_bot",
        displayName: "Grok Bot",
        configPath: "/custom/grokbot/mcp.json",
        markerPath: "/custom/grokbot",
        format: "json",
      }),
    ]);
    expect(
      supportedClients("/home/a", "linux", {
        SAND_DATA_ROOT: "relative/sand",
      }).find(({ name }) => name === "grok_bot")?.configPath,
    ).toBe("/home/a/.grokbot/mcp.json");
    expect(
      supportedClients("/home/a", "darwin", {}).find(
        ({ name }) => name === "grok_build",
      )?.configPath,
    ).toBe("/home/a/.grok/config.toml");
  });

  it("honors Copilot CLI and Devin platform configuration roots", () => {
    expect(
      supportedClients("/home/a", "linux", {
        COPILOT_HOME: "/custom/copilot",
        XDG_CONFIG_HOME: "/custom/config",
      }).find(({ name }) => name === "copilot_cli")?.configPath,
    ).toBe("/custom/copilot/mcp-config.json");
    expect(
      supportedClients("C:/Users/a", "win32", {
        APPDATA: "D:/Profile/Roaming",
      }).find(({ name }) => name === "devin")?.configPath,
    ).toBe("D:/Profile/Roaming/devin/mcp_config.json");
  });

  it("prefers an existing OpenCode JSONC file and honors explicit harness roots", async () => {
    const home = await createTestTempDirectory("rea-config-overrides-");
    const opencodeDirectory = join(home, ".config/opencode");
    await mkdir(opencodeDirectory, { recursive: true });
    await writeFile(join(opencodeDirectory, "opencode.jsonc"), "{}\n");
    const clients = supportedClients(home, "linux", {});
    expect(clients.find(({ name }) => name === "opencode")?.configPath).toBe(
      join(opencodeDirectory, "opencode.jsonc"),
    );
    expect(
      supportedClients(home, "linux", {
        OPENCODE_CONFIG: "/custom/open-code.jsonc",
        CLAUDE_CONFIG_DIR: "/custom/claude",
        CODEX_HOME: "/custom/codex",
      }).filter(({ name }) =>
        ["opencode", "claude_code", "codex"].includes(name),
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "opencode",
          configPath: "/custom/open-code.jsonc",
        }),
        expect.objectContaining({
          name: "claude_code",
          configPath: "/custom/claude/.claude.json",
        }),
        expect.objectContaining({
          name: "codex",
          configPath: "/custom/codex/config.toml",
        }),
      ]),
    );
  });

  it("recognizes prior exact REA releases while rejecting foreign package commands", () => {
    expect(
      isOwnedClientRegistrationCommand([
        "npx",
        "-y",
        `${PRODUCT_IDENTITY.packageName}@3.2.0`,
        "mcp",
      ]),
    ).toBe(true);
    expect(
      isOwnedClientRegistrationCommand(["npx", "-y", "another-package", "mcp"]),
    ).toBe(false);
    expect(
      isOwnedClientRegistrationCommand(
        [process.execPath, "/packaged/rea.mjs", "mcp"],
        "/packaged/rea.mjs",
      ),
    ).toBe(true);
    expect(
      isOwnedClientRegistrationCommand(
        ["node", "/packaged/other-agent.mjs", "mcp"],
        "/packaged/rea.mjs",
      ),
    ).toBe(false);
  });
});
