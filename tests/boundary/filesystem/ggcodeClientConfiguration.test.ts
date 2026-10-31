import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";

import { readClientRegistrationStatuses } from "../../../src/application/ClientRegistrationStatus.js";
import { npxRegistrationCommand } from "../../../src/application/ClientRegistrationIdentity.js";
import { configureClientConfiguration } from "../../../src/application/SetupClientConfiguration.js";
import { skillDestinations } from "../../../src/application/SetupSkill.js";
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

const ggcodePath = (
  home: string,
  platform: NodeJS.Platform = "linux",
  env: Parameters<typeof supportedClients>[2] = {},
) =>
  supportedClients(home, platform, env).find(({ name }) => name === "ggcode");

const registrationStatuses = (home: string) =>
  readClientRegistrationStatuses(home, undefined, {
    platform: process.platform,
    environment: {},
  });

describe("ggcode configuration paths", () => {
  it("resolves the standalone MCP config file and marker directory", () => {
    expect(ggcodePath("/home/a")).toEqual({
      name: "ggcode",
      displayName: "ggcode",
      configPath: join("/home/a", ".ggcode", "mcp_servers.yaml"),
      fallbackConfigPath: join("/home/a", ".ggcode", "ggcode.yaml"),
      supersededConfigPath: join("/home/a", ".ggcode", "ggcode.yaml"),
      markerPath: join("/home/a", ".ggcode"),
      format: "ggcode",
    });
    expect(ggcodePath("/Users/a", "darwin")?.configPath).toBe(
      join("/Users/a", ".ggcode", "mcp_servers.yaml"),
    );
    expect(ggcodePath("C:\\Users\\a", "win32")?.configPath).toBe(
      join("C:\\Users\\a", ".ggcode", "mcp_servers.yaml"),
    );
  });

  it("resolves the personal skills directory beside the config root", () => {
    expect(
      skillDestinations("/home/a", ["ggcode"]).map(({ path }) => path),
    ).toEqual([
      join("/home/a", ".ggcode", "skills", "reverse-engineer-anything"),
    ]);
  });
});

describe("ggcode YAML registration", () => {
  const ggcodeClient = async () => {
    const home = await createTestTempDirectory("rea-ggcode-");
    const client = ggcodePath(home, process.platform);
    if (client?.markerPath === undefined)
      throw new Error("missing ggcode client");
    await mkdir(client.markerPath, { recursive: true });
    return { home, client };
  };

  const readServers = async (path: string) =>
    parse(await readFile(path, "utf8"));

  it("creates mcp_servers.yaml as a named sequence when it is missing", async () => {
    const { home, client } = await ggcodeClient();

    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const servers = await readServers(client.configPath);
    expect(servers).toEqual([
      {
        name: "rea",
        type: "stdio",
        command: command[0],
        args: command.slice(1),
      },
    ]);

    expect(await configureClientConfiguration(client, {}, command)).toEqual({
      status: "unchanged",
    });
    expect(
      (await registrationStatuses(home)).find(
        ({ client: name }) => name === "ggcode",
      ),
    ).toMatchObject({ state: "aligned", command });
  });

  it("upserts rea while preserving unrelated entries, order and comments", async () => {
    const { client } = await ggcodeClient();
    await writeFile(
      client.configPath,
      `# my servers
- name: alpha
  command: alpha-cmd
  args: ["serve"]
- name: rea
  command: rea
  args: ["mcp"]
# trailing note
`,
    );

    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const text = await readFile(client.configPath, "utf8");
    expect(text).toContain("# my servers");
    expect(text).toContain("# trailing note");
    const servers = parse(text);
    expect(servers).toEqual([
      { name: "alpha", command: "alpha-cmd", args: ["serve"] },
      {
        name: "rea",
        type: "stdio",
        command: command[0],
        args: command.slice(1),
      },
    ]);
  });

  it("replaces an aliased rea name entry in place", async () => {
    const { client } = await ggcodeClient();
    await writeFile(
      client.configPath,
      `- model: &reaName rea
  name: *reaName
  command: rea
  args: ["mcp"]
`,
    );

    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const servers = await readServers(client.configPath);
    expect(servers).toEqual([
      {
        model: "rea",
        name: "rea",
        type: "stdio",
        command: command[0],
        args: command.slice(1),
      },
    ]);
  });

  it("refuses to replace an unowned rea entry", async () => {
    const { client } = await ggcodeClient();
    await writeFile(
      client.configPath,
      `- name: rea
  command: other-tool
  args: ["serve"]
`,
    );

    const result = await configureClientConfiguration(client, {}, command);
    expect(result).toMatchObject({
      status: "failed",
      reason: "registration_ownership",
    });
    const servers = await readServers(client.configPath);
    expect(servers).toEqual([
      { name: "rea", command: "other-tool", args: ["serve"] },
    ]);
  });

});

describe("ggcode YAML alias and empty-file handling", () => {
  const ggcodeClient = async () => {
    const home = await createTestTempDirectory("rea-ggcode-");
    const client = ggcodePath(home, process.platform);
    if (client?.markerPath === undefined)
      throw new Error("missing ggcode client");
    await mkdir(client.markerPath, { recursive: true });
    return { home, client };
  };

  const readServers = async (path: string) =>
    parse(await readFile(path, "utf8"));

  it("inlines aliases that pointed into the replaced rea entry", async () => {
    const { client } = await ggcodeClient();
    await writeFile(
      client.configPath,
      `- name: rea
  command: rea
  args: ["mcp"]
  env: &shared
    MODE: debug
- name: peer
  command: peer-cmd
  env: *shared
`,
    );

    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const text = await readFile(client.configPath, "utf8");
    expect(text).not.toContain("*shared");
    expect(parse(text)).toEqual([
      {
        name: "rea",
        type: "stdio",
        command: command[0],
        args: command.slice(1),
        env: { MODE: "debug" },
      },
      { name: "peer", command: "peer-cmd", env: { MODE: "debug" } },
    ]);
  });

  it("registers into an empty config file", async () => {
    const { client } = await ggcodeClient();
    await writeFile(client.configPath, "");
    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const servers = await readServers(client.configPath);
    expect(servers).toEqual([
      {
        name: "rea",
        type: "stdio",
        command: command[0],
        args: command.slice(1),
      },
    ]);
  });
});

describe("ggcode legacy in-main layering", () => {
  const ggcodeClient = async () => {
    const home = await createTestTempDirectory("rea-ggcode-");
    const client = ggcodePath(home, process.platform);
    if (client?.markerPath === undefined)
      throw new Error("missing ggcode client");
    await mkdir(client.markerPath, { recursive: true });
    return { home, client };
  };

  const readServers = async (path: string) =>
    parse(await readFile(path, "utf8"));

  it("seeds a fresh standalone file with the in-main ggcode.yaml servers it supersedes", async () => {
    const { home, client } = await ggcodeClient();
    const mainConfig = join(home, ".ggcode", "ggcode.yaml");
    const mainText = `model: demo
mcp_servers:
  - name: legacy
    command: legacy-cmd
    args: ["serve"]
`;
    await writeFile(mainConfig, mainText);

    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const servers = await readServers(client.configPath);
    expect(servers).toEqual([
      { name: "legacy", command: "legacy-cmd", args: ["serve"] },
      {
        name: "rea",
        type: "stdio",
        command: command[0],
        args: command.slice(1),
      },
    ]);
    // The legacy file stays as written; ggcode ignores its section now.
    expect(await readFile(mainConfig, "utf8")).toBe(mainText);
  });

  it("does not resurrect superseded in-main servers beside an existing file", async () => {
    const { home, client } = await ggcodeClient();
    await writeFile(
      join(home, ".ggcode", "ggcode.yaml"),
      `mcp_servers:
  - name: legacy
    command: legacy-cmd
`,
    );
    await writeFile(
      client.configPath,
      `- name: alpha
  command: alpha-cmd
`,
    );

    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const servers = await readServers(client.configPath);
    expect(servers.map(({ name }: { name: string }) => name)).toEqual([
      "alpha",
      "rea",
    ]);
  });

  it("seeds an aliased in-main rea name instead of refusing it", async () => {
    const { home, client } = await ggcodeClient();
    await writeFile(
      join(home, ".ggcode", "ggcode.yaml"),
      `model: &reaName rea
mcp_servers:
  - name: *reaName
    command: rea
    args: ["mcp"]
  - name: peer
    command: peer-cmd
`,
    );

    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    expect(
      (await readServers(client.configPath)).map(
        ({ name }: { name: string }) => name,
      ),
    ).toEqual(["rea", "peer"]);
  });

  it("refuses to seed an unowned in-main rea registration", async () => {
    const { home, client } = await ggcodeClient();
    await writeFile(
      join(home, ".ggcode", "ggcode.yaml"),
      `mcp_servers:
  - name: rea
    command: other-tool
    args: ["serve"]
`,
    );

    const result = await configureClientConfiguration(client, {}, command);
    expect(result).toMatchObject({
      status: "failed",
      reason: "registration_ownership",
    });
    await expect(readFile(client.configPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reports an aligned legacy in-main registration while no standalone file exists", async () => {
    const { home } = await ggcodeClient();
    await writeFile(
      join(home, ".ggcode", "ggcode.yaml"),
      `model: demo
mcp_servers:
  - name: rea
    type: stdio
    command: ${JSON.stringify(command[0])}
    args: ${JSON.stringify(command.slice(1))}
`,
    );

    expect(
      (await registrationStatuses(home)).find(
        ({ client: name }) => name === "ggcode",
      ),
    ).toMatchObject({ state: "aligned", command });
  });

  it("rejects malformed YAML without changing the file", async () => {
    const { client } = await ggcodeClient();
    const malformed = "- name: alpha\n  command: [unterminated\n";
    await writeFile(client.configPath, malformed);

    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("failed");
    expect(await readFile(client.configPath, "utf8")).toBe(malformed);
  });

  it("removes only the rea entry on uninstall", async () => {
    const { home, client } = await ggcodeClient();
    await writeFile(
      client.configPath,
      `- name: other
  command: other-server
`,
    );
    await configureClientConfiguration(client, {}, command);

    expect((await systemUninstallHost(home).removeClient(client)).status).toBe(
      "removed",
    );
    const servers = await readServers(client.configPath);
    expect(servers).toEqual([{ name: "other", command: "other-server" }]);
  });
});

describe("ggcode legacy fallback semantics", () => {
  const ggcodeClient = async () => {
    const home = await createTestTempDirectory("rea-ggcode-");
    const client = ggcodePath(home, process.platform);
    if (client?.markerPath === undefined)
      throw new Error("missing ggcode client");
    await mkdir(client.markerPath, { recursive: true });
    return { home, client };
  };

  const readServers = async (path: string) =>
    parse(await readFile(path, "utf8"));

  it("preserves the legacy rea entry environment when seeding the standalone file", async () => {
    const { home, client } = await ggcodeClient();
    await writeFile(
      join(home, ".ggcode", "ggcode.yaml"),
      `mcp_servers:
  - name: rea
    type: stdio
    command: rea
    args: ["mcp"]
    env:
      REA_LOG_LEVEL: debug
  - name: legacy
    command: legacy-cmd
`,
    );

    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const servers = await readServers(client.configPath);
    expect(servers.map(({ name }: { name: string }) => name).sort()).toEqual([
      "legacy",
      "rea",
    ]);
    expect(
      servers.find(({ name }: { name: string }) => name === "rea"),
    ).toMatchObject({
      command: command[0],
      args: command.slice(1),
      env: { REA_LOG_LEVEL: "debug" },
    });
  });

  it("refuses to migrate unnamed in-main servers instead of dropping them", async () => {
    const { home, client } = await ggcodeClient();
    await writeFile(
      join(home, ".ggcode", "ggcode.yaml"),
      `mcp_servers:
  - command: unnamed-cmd
`,
    );

    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("failed");
    await expect(readFile(client.configPath, "utf8")).rejects.toThrow();
  });

  it("rejects a mapping-shaped standalone file that ggcode cannot load", async () => {
    const { home, client } = await ggcodeClient();
    await writeFile(
      client.configPath,
      `mcp_servers:
  - name: rea
    type: stdio
    command: ${JSON.stringify(command[0])}
    args: ${JSON.stringify(command.slice(1))}
`,
    );

    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("failed");
    expect(
      (await registrationStatuses(home)).find(
        ({ client: name }) => name === "ggcode",
      )?.state,
    ).not.toBe("aligned");
  });

  it("rejects duplicate server names instead of repairing the wrong entry", async () => {
    const { client } = await ggcodeClient();
    const duplicated = `- name: rea
  command: first
- name: rea
  command: second
`;
    await writeFile(client.configPath, duplicated);

    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("failed");
    expect(await readFile(client.configPath, "utf8")).toBe(duplicated);
  });

  it("removes the rea entry from the legacy in-main file on uninstall", async () => {
    const { home } = await ggcodeClient();
    const legacyPath = join(home, ".ggcode", "ggcode.yaml");
    await writeFile(
      legacyPath,
      `model: demo
mcp_servers:
  - name: other
    command: other-cmd
  - name: rea
    type: stdio
    command: ${JSON.stringify(command[0])}
    args: ${JSON.stringify(command.slice(1))}
`,
    );
    const host = systemUninstallHost(home);
    const legacyClient = (await host.clients()).find(
      (entry) => entry.name === "ggcode" && entry.configPath === legacyPath,
    );
    if (legacyClient === undefined)
      throw new Error("missing legacy ggcode uninstall client");

    expect((await host.removeClient(legacyClient)).status).toBe("removed");
    const content = parse(await readFile(legacyPath, "utf8"));
    expect(content.model).toBe("demo");
    expect(content.mcp_servers).toEqual([
      { name: "other", command: "other-cmd" },
    ]);
  });

});

describe("ggcode standalone parsing guards", () => {
  const ggcodeClient = async () => {
    const home = await createTestTempDirectory("rea-ggcode-");
    const client = ggcodePath(home, process.platform);
    if (client?.markerPath === undefined)
      throw new Error("missing ggcode client");
    await mkdir(client.markerPath, { recursive: true });
    return { home, client };
  };

  const readServers = async (path: string) =>
    parse(await readFile(path, "utf8"));

  it("treats an explicit empty type as stdio", async () => {
    const { home, client } = await ggcodeClient();
    await writeFile(
      client.configPath,
      `- name: rea
  type: ""
  command: ${JSON.stringify(command[0])}
  args: ${JSON.stringify(command.slice(1))}
`,
    );

    expect(
      (await registrationStatuses(home)).find(
        ({ client: name }) => name === "ggcode",
      ),
    ).toMatchObject({ state: "aligned", command });
  });

  it("keeps a __proto__ server name as data without prototype pollution", async () => {
    const { client } = await ggcodeClient();
    await writeFile(
      client.configPath,
      `- name: __proto__
  command: proto-cmd
`,
    );

    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    expect(({} as Record<string, unknown>).command).toBeUndefined();
    const servers = await readServers(client.configPath);
    expect(servers.map(({ name }: { name: string }) => name)).toEqual([
      "__proto__",
      "rea",
    ]);
  });
});

describe("ggcode aliased entries and reported paths", () => {
  const ggcodeClient = async () => {
    const home = await createTestTempDirectory("rea-ggcode-");
    const client = ggcodePath(home, process.platform);
    if (client?.markerPath === undefined)
      throw new Error("missing ggcode client");
    await mkdir(client.markerPath, { recursive: true });
    return { home, client };
  };

  it("removes an aliased rea entry from the legacy file on uninstall", async () => {
    const { home } = await ggcodeClient();
    const legacyPath = join(home, ".ggcode", "ggcode.yaml");
    await writeFile(
      legacyPath,
      `model: demo
mcp_servers:
  - name: other
    command: other-cmd
  - model: &reaName rea
    name: *reaName
    type: stdio
    command: ${JSON.stringify(command[0])}
    args: ${JSON.stringify(command.slice(1))}
`,
    );
    const host = systemUninstallHost(home);
    const legacyClient = (await host.clients()).find(
      (entry) => entry.name === "ggcode" && entry.configPath === legacyPath,
    );
    if (legacyClient === undefined)
      throw new Error("missing legacy ggcode uninstall client");

    expect((await host.removeClient(legacyClient)).status).toBe("removed");
    expect(parse(await readFile(legacyPath, "utf8")).mcp_servers).toEqual([
      { name: "other", command: "other-cmd" },
    ]);
  });

  it("reports the legacy file the doctor registration was read from", async () => {
    const { home } = await ggcodeClient();
    const legacyPath = join(home, ".ggcode", "ggcode.yaml");
    await writeFile(
      legacyPath,
      `model: demo
mcp_servers:
  - name: rea
    type: stdio
    command: ${JSON.stringify(command[0])}
    args: ${JSON.stringify(command.slice(1))}
`,
    );

    expect(
      (await registrationStatuses(home)).find(
        ({ client: name }) => name === "ggcode",
      ),
    ).toMatchObject({ config_path: legacyPath });
  });
});
