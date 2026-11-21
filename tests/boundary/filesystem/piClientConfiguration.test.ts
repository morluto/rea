import { HOST_PLATFORM } from "../../../src/platform/HostPlatform.js";
import { currentClientRegistrationCommand } from "../../../src/application/ClientRegistrationIdentity.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readEffectiveClientRegistrationConfiguration } from "../../../src/application/ClientConfigurationFiles.js";
import { readClientRegistrationStatuses } from "../../../src/application/ClientRegistrationStatus.js";
import { parseClientConfiguration } from "../../../src/application/ClientConfigurationDocument.js";
import {
  configureClientConfiguration,
  inspectClientConfiguration,
} from "../../../src/application/SetupClientConfiguration.js";
import { detectClients } from "../../../src/application/SetupHost.js";
import { supportedClients } from "../../../src/application/SupportedClients.js";
import { systemUninstallHost } from "../../../src/application/Uninstall.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { clearClientLocationEnvironment } from "../../fixtures/clientEnvironment.js";

beforeEach(clearClientLocationEnvironment);
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const piPath = (
  home: string,
  platform: NodeJS.Platform,
  env: Parameters<typeof supportedClients>[2],
) => supportedClients(home, platform, env).find(({ name }) => name === "pi");

// Catch fallback to OMP paths, loss of relative overrides, and normalization
// that differs from Pi's public getAgentDir()/normalizePath boundary.
const command = currentClientRegistrationCommand();

describe("Pi user configuration paths", () => {
  it.each([
    [undefined, "/home/a/.pi/agent"],
    ["", "/home/a/.pi/agent"],
    ["/custom/agent", "/custom/agent"],
    ["~", "/home/a"],
    ["~/custom/agent", "/home/a/custom/agent"],
    ["agent", "agent"],
    ["./agent", "./agent"],
    [" agent ", " agent "],
    ["~other/agent", "~other/agent"],
    ["file:///custom/agent%20dir", "/custom/agent dir"],
    ["/mnt/c/agent", "/mnt/c/agent"],
  ])(
    "uses Pi's agent directory for %s, independently of OMP",
    (override, expected) => {
      const client = piPath("/home/a", "linux", {
        PI_CODING_AGENT_DIR: override,
        OMP_PROFILE: "work",
        PI_PROFILE: "legacy",
        PI_CONFIG_DIR: ".omp-other",
      });
      expect(client?.markerPath).toBe(expected);
      expect(client?.configPath).toBe(posix.join(expected, "mcp.json"));
    },
  );

  it.each([
    [undefined, "C:\\Users\\a\\.pi\\agent"],
    ["", "C:\\Users\\a\\.pi\\agent"],
    ["~", "C:\\Users\\a"],
    ["~/agent", "C:\\Users\\a\\agent"],
    ["~\\agent", "C:\\Users\\a\\agent"],
    ["C:\\custom\\agent", "C:\\custom\\agent"],
    ["/c/custom/agent", "C:\\custom\\agent"],
    ["/mnt/c/custom/agent", "C:\\custom\\agent"],
    ["/cygdrive/c/custom/agent", "C:\\custom\\agent"],
    ["/c", "C:\\"],
    ["//server/share/agent", "//server/share/agent"],
    ["\\\\server\\share\\agent", "\\\\server\\share\\agent"],
    ["agent", "agent"],
    ["file:///C:/custom/agent%20dir", "C:\\custom\\agent dir"],
    ["file://server/share/agent", "\\\\server\\share\\agent"],
  ])("normalizes Windows Pi override %s", (override, expected) => {
    const client = piPath("C:\\Users\\a", "win32", {
      PI_CODING_AGENT_DIR: override,
    });
    expect(client?.markerPath).toBe(expected);
    expect(client?.configPath).toBe(
      `${expected.replace(/[\\/]+$/u, "").replaceAll("/", "\\")}\\mcp.json`,
    );
  });

  it("reports malformed file URLs instead of silently choosing the default", async () => {
    const home = await createTestTempDirectory("rea-pi-invalid-path-");
    const client = piPath(home, "linux", {
      PI_CODING_AGENT_DIR: "file:///agent%2fdir",
    });
    expect(client).toMatchObject({
      configPath: "file:///agent%2fdir",
      configPathError: expect.stringContaining("PI_CODING_AGENT_DIR"),
    });
    if (client === undefined) throw new Error("missing Pi client");
    expect(await configureClientConfiguration(client)).toEqual({
      status: "failed",
      reason: "path",
    });
    expect(await systemUninstallHost(home).removeClient(client)).toMatchObject({
      status: "failed",
      detail: expect.stringContaining("PI_CODING_AGENT_DIR"),
    });
    expect(
      await detectClients(home, "linux", {
        PI_CODING_AGENT_DIR: "file:///agent%2fdir",
      }),
    ).toEqual([]);
  });

  it("detects the normalized override marker without needing mcp.json", async () => {
    const home = await createTestTempDirectory("rea-pi-detection-");
    await mkdir(join(home, "custom-agent"));
    const detected = await detectClients(home, process.platform, {
      PI_CODING_AGENT_DIR: "~/custom-agent",
    });
    expect(detected.find(({ name }) => name === "pi")?.configPath).toBe(
      join(home, "custom-agent", "mcp.json"),
    );
  });
});

const piClient = async () => {
  const home = await createTestTempDirectory("rea-pi-config-");
  const client = piPath(home, process.platform, {});
  if (client?.markerPath === undefined) throw new Error("missing Pi client");
  await mkdir(client.markerPath, { recursive: true });
  return { home, client };
};

const trustPiProject = async (home: string, projectDir: string) => {
  const agentDir = join(home, ".pi", "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(agentDir, "trust.json"),
    JSON.stringify({ [resolve(projectDir)]: true }),
  );
};

describe("Pi registration semantics", () => {
  it("preserves unrelated content and OMP-only lists during setup, repeat, and uninstall", async () => {
    const { home, client } = await piClient();
    // Pi loads mcp.json with strict JSON, so the retained unrelated settings
    // are valid strict JSON rather than the commented JSONC fixture.
    const original = `{"autoEnableCodemode": false,
  "mcpServers": { "other": { "command": "other-server" } },
  "enabledServers": ["other"],
  "disabledServers": ["rea", "other"]
}\n`;
    await writeFile(client.configPath, original);
    expect(
      await configureClientConfiguration(client, {}, command),
    ).toMatchObject({ status: "configured" });
    expect(await readFile(`${client.configPath}.rea.backup`, "utf8")).toBe(
      original,
    );
    const configured = await readFile(client.configPath, "utf8");
    expect(JSON.parse(configured)).toEqual({
      autoEnableCodemode: false,
      mcpServers: {
        other: { command: "other-server" },
        rea: {
          type: "stdio",
          command: command[0],
          args: command.slice(1),
        },
      },
      enabledServers: ["other"],
      disabledServers: ["rea", "other"],
    });
    expect(await configureClientConfiguration(client, {}, command)).toEqual({
      status: "unchanged",
    });
    expect(await readFile(client.configPath, "utf8")).toBe(configured);
    expect(
      (
        await readClientRegistrationStatuses(home, undefined, {
          platform: HOST_PLATFORM.platform,
          environment: {},
        })
      ).find(({ client: name }) => name === "pi"),
    ).toMatchObject({ state: "aligned" });
    expect((await systemUninstallHost(home).removeClient(client)).status).toBe(
      "removed",
    );
    expect(JSON.parse(await readFile(client.configPath, "utf8"))).toEqual(
      JSON.parse(original),
    );
    expect(await readFile(`${client.configPath}.rea.backup`, "utf8")).toBe(
      original,
    );
  });

  it.each([
    [undefined, true, "aligned"],
    ["stdio", true, "aligned"],
    ["http", true, "invalid"],
    ["streamable-http", true, "invalid"],
    ["sse", true, "invalid"],
    [undefined, false, "stale"],
    ["stdio", false, "stale"],
  ])(
    "doctor handles type %s and enabled %s despite foreign activation settings",
    async (type, enabled, state) => {
      const { home, client } = await piClient();
      await writeFile(
        client.configPath,
        JSON.stringify({
          mcpServers: {
            rea: {
              command: command[0],
              args: command.slice(1),
              type,
              enabled,
              disabled: true,
            },
          },
          enabledServers: ["rea"],
        }),
      );
      const statuses = await readClientRegistrationStatuses(home, undefined, {
        platform: HOST_PLATFORM.platform,
        environment: {},
      });
      expect(statuses.find(({ client: name }) => name === "pi")).toMatchObject({
        state,
      });
    },
  );
});

describe("Pi strict JSON parsing", () => {
  it.each([
    [
      "a comment",
      `{ // Pi loads strict JSON only\n"mcpServers": { "other": { "command": "other" } }\n}\n`,
    ],
    [
      "a trailing comma",
      `{"mcpServers": { "other": { "command": "other" }, },}\n`,
    ],
    [
      "a BOM before valid JSON",
      `\uFEFF{"mcpServers": { "other": { "command": "other" } }}\n`,
    ],
    ["empty text", ""],
    ["whitespace only", "\n \t\r\n"],
    ["a BOM only", "\uFEFF"],
  ])(
    "rejects an existing Pi configuration with %s before any mutation",
    async (_description, original) => {
      const { home, client } = await piClient();
      await writeFile(client.configPath, original);
      expect(() => parseClientConfiguration(original, "pi")).toThrow();
      expect(
        await inspectClientConfiguration(client, {}, command),
      ).toMatchObject({ status: "invalid" });
      expect(await configureClientConfiguration(client, {})).toEqual({
        status: "failed",
        reason: "readback",
      });
      expect(await readFile(client.configPath, "utf8")).toBe(original);
      await expect(
        readFile(`${client.configPath}.rea.backup`),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        (
          await readClientRegistrationStatuses(home, undefined, {
            platform: HOST_PLATFORM.platform,
            environment: {},
          })
        ).find(({ client: name }) => name === "pi"),
      ).toMatchObject({ state: "invalid" });
      expect(
        await systemUninstallHost(home).removeClient(client),
      ).toMatchObject({
        name: "pi",
        status: "failed",
        detail: expect.stringContaining("not valid JSON"),
      });
      expect(await readFile(client.configPath, "utf8")).toBe(original);
      await expect(
        readFile(`${client.configPath}.rea.backup`),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("initializes a missing Pi configuration as valid strict JSON without a backup", async () => {
    const { home, client } = await piClient();
    await expect(readFile(client.configPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await inspectClientConfiguration(client, {}, command)).toEqual({
      status: "create",
    });
    expect(
      await configureClientConfiguration(client, {}, command),
    ).toMatchObject({ status: "configured" });
    const created = await readFile(client.configPath, "utf8");
    expect(() => JSON.parse(created)).not.toThrow();
    expect(JSON.parse(created)).toEqual({
      mcpServers: {
        rea: {
          type: "stdio",
          command: command[0],
          args: command.slice(1),
        },
      },
    });
    await expect(
      readFile(`${client.configPath}.rea.backup`),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await configureClientConfiguration(client, {}, command)).toEqual({
      status: "unchanged",
    });
    expect(await readFile(client.configPath, "utf8")).toBe(created);
    expect(
      (
        await readClientRegistrationStatuses(home, undefined, {
          platform: HOST_PLATFORM.platform,
          environment: {},
        })
      ).find(({ client: name }) => name === "pi"),
    ).toMatchObject({ state: "aligned" });
    expect(await systemUninstallHost(home).removeClient(client)).toMatchObject({
      name: "pi",
      status: "removed",
    });
    expect(JSON.parse(await readFile(client.configPath, "utf8"))).toEqual({
      mcpServers: {},
    });
  });

  it("keeps JSONC tolerance for other dialects while Pi rejects the same text", () => {
    const jsonc = `\uFEFF{\n  // A comment Pi rejects but OpenCode keeps.\n  "mcp": { "other": { "type": "local" }, },\n}\n`;
    expect(parseClientConfiguration(jsonc, "opencode").servers).toEqual({
      other: { type: "local" },
    });
    expect(parseClientConfiguration("", "opencode").document).toEqual({});
    expect(parseClientConfiguration("\uFEFF", "opencode").document).toEqual({});
    expect(() => parseClientConfiguration(jsonc, "pi")).toThrow();
    expect(() => parseClientConfiguration("", "pi")).toThrow();
    expect(() => parseClientConfiguration("\uFEFF", "pi")).toThrow();
  });
});

describe("Pi project-scoped discovery and overrides", () => {
  it("discovers project-scoped registration and reports scope: project", async () => {
    const home = await createTestTempDirectory("rea-pi-project-home-");
    const projectDir = await createTestTempDirectory("rea-pi-project-cwd-");
    vi.spyOn(process, "cwd").mockReturnValue(projectDir);
    await trustPiProject(home, projectDir);

    const projectConfigDir = join(projectDir, ".pi");
    await mkdir(projectConfigDir, { recursive: true });
    const projectConfigPath = resolve(projectConfigDir, "mcp.json");
    await writeFile(
      projectConfigPath,
      JSON.stringify({
        mcpServers: {
          rea: {
            command: command[0],
            args: command.slice(1),
          },
        },
      }),
    );

    const statuses = await readClientRegistrationStatuses(home, undefined, {
      platform: HOST_PLATFORM.platform,
      environment: {},
    });
    const piStatus = statuses.find(({ client }) => client === "pi");
    expect(piStatus).toMatchObject({
      client: "pi",
      state: "aligned",
      scope: "project",
      config_path: projectConfigPath,
      remediation: null,
    });
  });

  it("evaluates a project full replacement over a user registration", async () => {
    const { home, client } = await piClient();
    const projectDir = await createTestTempDirectory("rea-pi-project-cwd-");
    vi.spyOn(process, "cwd").mockReturnValue(projectDir);
    await trustPiProject(home, projectDir);

    await writeFile(
      client.configPath,
      JSON.stringify({
        mcpServers: {
          rea: {
            command: "npx",
            args: ["-y", "rea-agents@1.0.0", "mcp"],
          },
        },
      }),
    );

    const projectConfigDir = join(projectDir, ".pi");
    await mkdir(projectConfigDir, { recursive: true });
    const projectConfigPath = resolve(projectConfigDir, "mcp.json");
    await writeFile(
      projectConfigPath,
      JSON.stringify({
        mcpServers: {
          rea: {
            command: command[0],
            args: command.slice(1),
          },
        },
      }),
    );

    const statuses = await readClientRegistrationStatuses(home, undefined, {
      platform: HOST_PLATFORM.platform,
      environment: {},
    });
    const piStatus = statuses.find(({ client }) => client === "pi");
    expect(piStatus).toMatchObject({
      client: "pi",
      state: "aligned",
      scope: "project",
      config_path: projectConfigPath,
    });
  });

  it("evaluates a project full replacement even when the shadowed user row has invalid REA environment", async () => {
    const { home, client } = await piClient();
    const projectDir = await createTestTempDirectory(
      "rea-pi-invalid-user-env-",
    );
    vi.spyOn(process, "cwd").mockReturnValue(projectDir);
    await trustPiProject(home, projectDir);

    await writeFile(
      client.configPath,
      JSON.stringify({
        mcpServers: {
          rea: {
            command: "npx",
            args: ["-y", "rea-agents@1.0.0", "mcp"],
            env: {
              REA_GHIDRA_STARTUP_TIMEOUT_MS: "bad",
            },
          },
        },
      }),
    );

    const projectConfigDir = join(projectDir, ".pi");
    await mkdir(projectConfigDir, { recursive: true });
    const projectConfigPath = resolve(projectConfigDir, "mcp.json");
    await writeFile(
      projectConfigPath,
      JSON.stringify({
        mcpServers: {
          rea: {
            command: command[0],
            args: command.slice(1),
          },
        },
      }),
    );

    const statuses = await readClientRegistrationStatuses(home, undefined, {
      platform: HOST_PLATFORM.platform,
      environment: {},
    });
    const piStatus = statuses.find(({ client: c }) => c === "pi");
    expect(piStatus).toMatchObject({
      client: "pi",
      state: "aligned",
      scope: "project",
      config_path: projectConfigPath,
    });
  });
});

it.runIf(process.platform === "win32")(
  "keeps one user source when a project config aliases PI_CODING_AGENT_DIR",
  async () => {
    const home = await createTestTempDirectory("rea-pi-case-home-");
    const projectDirectory = await createTestTempDirectory("rea-pi-case-cwd-");
    const projectConfigDir = join(projectDirectory, ".pi");
    await mkdir(projectConfigDir, { recursive: true });
    const configPath = join(projectConfigDir, "mcp.json");
    await writeFile(
      configPath,
      JSON.stringify({
        mcpServers: { rea: { command: command[0], args: command.slice(1) } },
      }),
    );
    const matchingPi = piPath(home, "win32", {
      PI_CODING_AGENT_DIR: join(projectDirectory.toLowerCase(), ".pi"),
    });
    if (matchingPi === undefined) throw new Error("missing Pi client");
    expect(
      await readEffectiveClientRegistrationConfiguration(
        matchingPi,
        undefined,
        "win32",
        { projectDirectory },
      ),
    ).toMatchObject({
      ok: true,
      value: { scope: "user", launcherScope: "user" },
    });
  },
);

describe("Pi project-scoped partial overrides", () => {
  it("applies a partial project override onto a user registration and directs remediation to the project file", async () => {
    const { home, client } = await piClient();
    const projectDir = await createTestTempDirectory("rea-pi-project-cwd-");
    vi.spyOn(process, "cwd").mockReturnValue(projectDir);
    await trustPiProject(home, projectDir);

    await writeFile(
      client.configPath,
      JSON.stringify({
        mcpServers: {
          rea: {
            command: command[0],
            args: command.slice(1),
          },
        },
      }),
    );

    const projectConfigDir = join(projectDir, ".pi");
    await mkdir(projectConfigDir, { recursive: true });
    const projectConfigPath = resolve(projectConfigDir, "mcp.json");
    await writeFile(
      projectConfigPath,
      JSON.stringify({
        mcpServers: {
          rea: {
            enabled: false,
          },
        },
      }),
    );

    const statuses = await readClientRegistrationStatuses(home, undefined, {
      platform: HOST_PLATFORM.platform,
      environment: {},
    });
    const piStatus = statuses.find(({ client }) => client === "pi");
    expect(piStatus).toMatchObject({
      client: "pi",
      state: "stale",
      scope: "project",
      config_path: projectConfigPath,
    });
    expect(piStatus?.remediation).toContain(
      "REA setup writes only user-level client configuration and does not modify project-scoped configuration",
    );
    expect(piStatus?.remediation).not.toContain("Run rea setup");
  });

  it("names the invalid project file when a flags-only override carries environment fields", async () => {
    const { home, client } = await piClient();
    const projectDir = await createTestTempDirectory("rea-pi-project-cwd-");
    vi.spyOn(process, "cwd").mockReturnValue(projectDir);
    await trustPiProject(home, projectDir);

    await writeFile(
      client.configPath,
      JSON.stringify({
        mcpServers: {
          rea: {
            command: command[0],
            args: command.slice(1),
            enabled: true,
          },
        },
      }),
    );

    const projectConfigDir = join(projectDir, ".pi");
    await mkdir(projectConfigDir, { recursive: true });
    const projectConfigPath = resolve(projectConfigDir, "mcp.json");
    await writeFile(
      projectConfigPath,
      JSON.stringify({
        mcpServers: {
          rea: {
            enabled: true,
            env: { REA_GHIDRA_STARTUP_TIMEOUT_MS: "invalid-number" },
          },
        },
      }),
    );

    const statuses = await readClientRegistrationStatuses(home, undefined, {
      platform: HOST_PLATFORM.platform,
      environment: {},
    });
    const piStatus = statuses.find(({ client }) => client === "pi");
    expect(piStatus).toMatchObject({
      client: "pi",
      state: "invalid",
      scope: "project",
      config_path: projectConfigPath,
    });
  });
});

describe("Pi project-scoped inherited environment validation", () => {
  it("reports user-scoped invalid status when trusted project partial override inherits invalid user environment", async () => {
    const home = await createTestTempDirectory("rea-pi-project-home-");
    const projectDir = await createTestTempDirectory("rea-pi-project-cwd-");
    vi.spyOn(process, "cwd").mockReturnValue(projectDir);
    await trustPiProject(home, projectDir);

    const client = supportedClients(home, HOST_PLATFORM.platform).find(
      ({ name }) => name === "pi",
    );
    if (client === undefined) throw new Error("missing pi client");

    await mkdir(dirname(client.configPath), { recursive: true });
    await writeFile(
      client.configPath,
      JSON.stringify({
        mcpServers: {
          rea: {
            command: "npx",
            args: ["-y", "rea-agents@1.0.0", "mcp"],
            env: {
              REA_GHIDRA_PROGRAM_NAME: "sample",
            },
          },
        },
      }),
    );

    const projectConfigDir = join(projectDir, ".pi");
    await mkdir(projectConfigDir, { recursive: true });
    const projectConfigPath = resolve(projectConfigDir, "mcp.json");
    await writeFile(
      projectConfigPath,
      JSON.stringify({
        mcpServers: {
          rea: {
            enabled: true,
          },
        },
      }),
    );

    const statuses = await readClientRegistrationStatuses(home, undefined, {
      platform: HOST_PLATFORM.platform,
      environment: {},
    });
    const piStatus = statuses.find(({ client: c }) => c === "pi");
    expect(piStatus).toMatchObject({
      client: "pi",
      state: "invalid",
      config_path: client.configPath,
    });
    expect(piStatus?.scope).toBeUndefined();
    expect(piStatus?.remediation).toContain(client.configPath);
    expect(piStatus?.remediation).not.toContain(projectConfigPath);
  });

  it("reports user-scoped invalid status when trusted project partial override inherits invalid user registration schema", async () => {
    const home = await createTestTempDirectory("rea-pi-project-schema-home-");
    const projectDir = await createTestTempDirectory(
      "rea-pi-project-schema-cwd-",
    );
    vi.spyOn(process, "cwd").mockReturnValue(projectDir);
    await trustPiProject(home, projectDir);

    const client = supportedClients(home, HOST_PLATFORM.platform).find(
      ({ name }) => name === "pi",
    );
    if (client === undefined) throw new Error("missing pi client");

    await mkdir(dirname(client.configPath), { recursive: true });
    await writeFile(
      client.configPath,
      JSON.stringify({
        mcpServers: {
          rea: {
            command: 123,
          },
        },
      }),
    );

    const projectConfigDir = join(projectDir, ".pi");
    await mkdir(projectConfigDir, { recursive: true });
    const projectConfigPath = resolve(projectConfigDir, "mcp.json");
    await writeFile(
      projectConfigPath,
      JSON.stringify({
        mcpServers: {
          rea: {
            enabled: false,
          },
        },
      }),
    );

    const statuses = await readClientRegistrationStatuses(home, undefined, {
      platform: HOST_PLATFORM.platform,
      environment: {},
    });
    const piStatus = statuses.find(({ client: c }) => c === "pi");
    expect(piStatus).toMatchObject({
      client: "pi",
      state: "invalid",
      config_path: client.configPath,
    });
    expect(piStatus?.scope).toBeUndefined();
    expect(piStatus?.remediation).not.toContain(projectConfigPath);
    expect(piStatus?.remediation).not.toContain(
      "REA setup writes only user-level configuration",
    );
  });
});

it.each(["user", "project"] as const)(
  "attributes a native Pi transport rejection to its %s selector",
  async (scope) => {
    const { home, client } = await piClient();
    const project = await createTestTempDirectory("rea-pi-transport-source-");
    vi.spyOn(process, "cwd").mockReturnValue(project);
    await trustPiProject(home, project);
    const projectPath = join(project, ".pi", "mcp.json");
    await mkdir(dirname(projectPath), { recursive: true });
    const launcher = { command: command[0], args: command.slice(1) };
    await writeFile(
      client.configPath,
      JSON.stringify({
        mcpServers: {
          rea: { ...launcher, type: scope === "user" ? "http" : "stdio" },
        },
      }),
    );
    await writeFile(
      projectPath,
      JSON.stringify({
        mcpServers: {
          rea:
            scope === "user"
              ? { enabled: true }
              : { ...launcher, type: "http" },
        },
      }),
    );

    const statuses = await readClientRegistrationStatuses(home, undefined, {
      platform: HOST_PLATFORM.platform,
      environment: {},
    });
    const expectedPath = scope === "user" ? client.configPath : projectPath;
    const status = statuses.find(({ client: name }) => name === "pi");
    expect(status).toMatchObject({
      state: "invalid",
      config_path: expectedPath,
      command_identity: "owned",
      remediation: expect.stringContaining("native transport"),
    });
    expect(status?.scope).toBe(scope === "project" ? "project" : undefined);
    if (scope === "project") expect(status?.remediation).toContain(projectPath);
  },
);

it("attributes a Pi replacement with a missing launcher to the project file", async () => {
  const { home, client } = await piClient();
  const project = await createTestTempDirectory("rea-pi-replacement-source-");
  vi.spyOn(process, "cwd").mockReturnValue(project);
  await trustPiProject(home, project);
  await writeFile(
    client.configPath,
    JSON.stringify({
      mcpServers: { rea: { command: command[0], args: command.slice(1) } },
    }),
  );
  const configPath = join(project, ".pi", "mcp.json");
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(
    configPath,
    JSON.stringify({
      mcpServers: { rea: { type: "stdio", env: { CALLER: "retained" } } },
    }),
  );
  const registrations = await readClientRegistrationStatuses(home, undefined, {
    platform: HOST_PLATFORM.platform,
    environment: {},
    selectedClientIds: ["pi"],
  });
  expect(registrations.find(({ client }) => client === "pi")).toMatchObject({
    state: "invalid",
    scope: "project",
    config_path: configPath,
    remediation: expect.stringContaining("command"),
  });
});

describe("Pi standalone partial override validation", () => {
  it("reports invalid with project-scoped remediation for a standalone partial override without a user registration", async () => {
    const home = await createTestTempDirectory("rea-pi-project-home-");
    const projectDir = await createTestTempDirectory("rea-pi-project-cwd-");
    vi.spyOn(process, "cwd").mockReturnValue(projectDir);
    await trustPiProject(home, projectDir);

    const projectConfigDir = join(projectDir, ".pi");
    await mkdir(projectConfigDir, { recursive: true });
    const projectConfigPath = resolve(projectConfigDir, "mcp.json");
    await writeFile(
      projectConfigPath,
      JSON.stringify({
        mcpServers: {
          rea: {
            enabled: true,
          },
        },
      }),
    );

    const statuses = await readClientRegistrationStatuses(home, undefined, {
      platform: HOST_PLATFORM.platform,
      environment: {},
    });
    const piStatus = statuses.find(({ client }) => client === "pi");
    expect(piStatus).toMatchObject({
      client: "pi",
      state: "invalid",
      scope: "project",
      config_path: projectConfigPath,
    });
    expect(piStatus?.remediation).toContain(
      "REA setup writes only user-level configuration and does not modify project-scoped configuration",
    );
  });
});

describe("Pi project-scoped launcher provenance and fallback", () => {
  it("keeps user launcher provenance when project only sets flags and advises user setup for version drift", async () => {
    const { home, client } = await piClient();
    const projectDir = await createTestTempDirectory("rea-pi-stale-user-");
    vi.spyOn(process, "cwd").mockReturnValue(projectDir);
    await trustPiProject(home, projectDir);

    const staleCommand = ["npx", "-y", "rea-agents@1.0.0", "mcp"];

    await writeFile(
      client.configPath,
      JSON.stringify({
        mcpServers: {
          rea: {
            command: staleCommand[0],
            args: staleCommand.slice(1),
          },
        },
      }),
    );

    const projectConfigDir = join(projectDir, ".pi");
    await mkdir(projectConfigDir, { recursive: true });
    const projectConfigPath = resolve(projectConfigDir, "mcp.json");
    await writeFile(
      projectConfigPath,
      JSON.stringify({
        mcpServers: {
          rea: {
            enabled: true,
          },
        },
      }),
    );

    const statuses = await readClientRegistrationStatuses(home, undefined, {
      platform: HOST_PLATFORM.platform,
      environment: {},
    });
    const piStatus = statuses.find(({ client }) => client === "pi");
    expect(piStatus).toMatchObject({
      client: "pi",
      state: "stale",
      scope: "project",
      launcher_scope: "user",
      config_path: projectConfigPath,
    });
    expect(piStatus?.remediation).toContain("rea setup --client pi");
    expect(piStatus?.remediation).not.toContain(projectConfigPath);
  });

  it.each([
    { reference: "rea-agents@1.0.0", expected: "rea setup --client pi" },
    { reference: "rea-agents", expected: "Run rea setup" },
    { reference: "other-package", expected: "user-registration-file" },
  ])(
    "keeps both repairs when Pi disables a project override of $reference",
    async ({ reference, expected }) => {
      const { home, client } = await piClient();
      const projectDir = await createTestTempDirectory(
        "rea-pi-disabled-user-launcher-cwd-",
      );
      vi.spyOn(process, "cwd").mockReturnValue(projectDir);
      await trustPiProject(home, projectDir);

      const staleCommand = ["npx", "-y", reference, "mcp"];

      await writeFile(
        client.configPath,
        JSON.stringify({
          mcpServers: {
            rea: {
              command: staleCommand[0],
              args: staleCommand.slice(1),
            },
          },
        }),
      );

      const projectConfigDir = join(projectDir, ".pi");
      await mkdir(projectConfigDir, { recursive: true });
      const projectConfigPath = resolve(projectConfigDir, "mcp.json");
      await writeFile(
        projectConfigPath,
        JSON.stringify({
          mcpServers: {
            rea: {
              enabled: false,
            },
          },
        }),
      );

      const statuses = await readClientRegistrationStatuses(home, undefined, {
        platform: HOST_PLATFORM.platform,
        environment: {},
      });
      const piStatus = statuses.find(({ client }) => client === "pi");
      expect(piStatus).toMatchObject({
        client: "pi",
        state: "stale",
        scope: "project",
        launcher_scope: "user",
        config_path: projectConfigPath,
      });
      expect(piStatus?.remediation).toContain(
        expected === "user-registration-file" ? client.configPath : expected,
      );
      expect(piStatus?.remediation).toContain(projectConfigPath);
    },
  );
});

describe("Pi project-scoped disabled launcher package update", () => {
  it("includes activation repair alongside package update when project-scoped registration has outdated package and is disabled", async () => {
    const { home } = await piClient();
    const projectDir = await createTestTempDirectory(
      "rea-pi-disabled-project-launcher-cwd-",
    );
    vi.spyOn(process, "cwd").mockReturnValue(projectDir);
    await trustPiProject(home, projectDir);

    const staleCommand = ["npx", "-y", "rea-agents@1.0.0", "mcp"];

    const projectConfigDir = join(projectDir, ".pi");
    await mkdir(projectConfigDir, { recursive: true });
    const projectConfigPath = resolve(projectConfigDir, "mcp.json");
    await writeFile(
      projectConfigPath,
      JSON.stringify({
        mcpServers: {
          rea: {
            command: staleCommand[0],
            args: staleCommand.slice(1),
            enabled: false,
          },
        },
      }),
    );

    const statuses = await readClientRegistrationStatuses(home, undefined, {
      platform: HOST_PLATFORM.platform,
      environment: {},
    });
    const piStatus = statuses.find(({ client }) => client === "pi");
    expect(piStatus).toMatchObject({
      client: "pi",
      state: "stale",
      scope: "project",
      config_path: projectConfigPath,
    });
    expect(piStatus?.remediation).toContain(
      `update the package version in ${projectConfigPath}`,
    );
    expect(piStatus?.remediation).toContain(
      `Update or remove the rea registration in ${projectConfigPath}`,
    );
  });
});

describe("Pi project-scoped fallback on sibling servers", () => {
  it("falls back to user missing when project file only has sibling servers", async () => {
    const home = await createTestTempDirectory("rea-pi-sibling-only-home-");
    const projectDir = await createTestTempDirectory(
      "rea-pi-sibling-only-cwd-",
    );
    vi.spyOn(process, "cwd").mockReturnValue(projectDir);
    await trustPiProject(home, projectDir);

    const projectConfigDir = join(projectDir, ".pi");
    await mkdir(projectConfigDir, { recursive: true });
    const projectConfigPath = resolve(projectConfigDir, "mcp.json");
    await writeFile(
      projectConfigPath,
      JSON.stringify({
        mcpServers: {
          other: { command: "other-cmd" },
        },
      }),
    );

    const statuses = await readClientRegistrationStatuses(home, undefined, {
      platform: HOST_PLATFORM.platform,
      environment: {},
    });
    const piStatus = statuses.find(({ client }) => client === "pi");
    const client = supportedClients(home, HOST_PLATFORM.platform).find(
      ({ name }) => name === "pi",
    );
    expect(piStatus).toMatchObject({
      client: "pi",
      state: "missing",
      scope: "user",
      config_path: client?.configPath,
    });
    expect(piStatus?.remediation).toContain(
      "Run rea setup to refresh this registration",
    );
  });
});

describe("Pi project trust enforcement", () => {
  it("does not select project configuration when Pi project trust is untrusted or unknown", async () => {
    const { home, client } = await piClient();
    const projectDir = await createTestTempDirectory("rea-pi-untrusted-");
    vi.spyOn(process, "cwd").mockReturnValue(projectDir);

    const alignedCommand = command;
    await writeFile(
      client.configPath,
      JSON.stringify({
        mcpServers: {
          rea: {
            command: alignedCommand[0],
            args: alignedCommand.slice(1),
          },
        },
      }),
    );

    const projectConfigDir = join(projectDir, ".pi");
    await mkdir(projectConfigDir, { recursive: true });
    await writeFile(
      resolve(projectConfigDir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          rea: {
            enabled: false,
          },
        },
      }),
    );

    // Without trust decision in trust.json or settings.json, project is untrusted
    const statuses = await readClientRegistrationStatuses(home, undefined, {
      platform: HOST_PLATFORM.platform,
      environment: {},
    });
    const piStatus = statuses.find(({ client: c }) => c === "pi");
    expect(piStatus).toMatchObject({
      client: "pi",
      state: "aligned",
      scope: "user",
      config_path: client.configPath,
    });

    // Now trust the project and verify project configuration is selected
    await trustPiProject(home, projectDir);
    const trustedStatuses = await readClientRegistrationStatuses(
      home,
      undefined,
      { platform: HOST_PLATFORM.platform, environment: {} },
    );
    const trustedPiStatus = trustedStatuses.find(({ client: c }) => c === "pi");
    expect(trustedPiStatus).toMatchObject({
      client: "pi",
      state: "stale",
      scope: "project",
      config_path: resolve(projectConfigDir, "mcp.json"),
    });
  });
});

describe("Pi project trust error handling", () => {
  it("preserves named trust failures in doctor when trust.json is malformed", async () => {
    const { home, client } = await piClient();
    const alignedCommand = command;
    await mkdir(join(home, ".pi", "agent"), { recursive: true });
    await writeFile(
      client.configPath,
      JSON.stringify({
        mcpServers: {
          rea: {
            command: alignedCommand[0],
            args: alignedCommand.slice(1),
          },
        },
      }),
    );

    const projectDir = await createTestTempDirectory("rea-pi-malformed-trust-");
    const projectConfigDir = join(projectDir, ".pi");
    await mkdir(projectConfigDir, { recursive: true });
    const projectConfigPath = resolve(projectConfigDir, "mcp.json");
    await writeFile(
      projectConfigPath,
      JSON.stringify({
        mcpServers: {
          rea: {
            command: alignedCommand[0],
            args: alignedCommand.slice(1),
          },
        },
      }),
    );

    const trustPath = join(home, ".pi", "agent", "trust.json");
    await writeFile(trustPath, "{ malformed_json");

    vi.spyOn(process, "cwd").mockReturnValue(projectDir);

    const statuses = await readClientRegistrationStatuses(home, undefined, {
      platform: HOST_PLATFORM.platform,
      environment: {},
    });
    const piStatus = statuses.find(({ client: c }) => c === "pi");
    expect(piStatus).toMatchObject({
      client: "pi",
      state: "invalid",
      scope: "project",
      config_path: trustPath,
    });
    expect(piStatus?.remediation).toContain("malformed");
  });

  it("reports invalid project settings in doctor when settings.json is malformed", async () => {
    const { home, client } = await piClient();
    const alignedCommand = command;
    await mkdir(join(home, ".pi", "agent"), { recursive: true });
    await writeFile(
      client.configPath,
      JSON.stringify({
        mcpServers: {
          rea: {
            command: alignedCommand[0],
            args: alignedCommand.slice(1),
          },
        },
      }),
    );

    const projectDir = await createTestTempDirectory(
      "rea-pi-malformed-settings-",
    );
    const projectConfigDir = join(projectDir, ".pi");
    await mkdir(projectConfigDir, { recursive: true });
    await writeFile(
      resolve(projectConfigDir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          rea: {
            enabled: false,
          },
        },
      }),
    );

    const settingsPath = join(home, ".pi", "agent", "settings.json");
    await writeFile(settingsPath, "{ malformed_json");

    vi.spyOn(process, "cwd").mockReturnValue(projectDir);

    const statuses = await readClientRegistrationStatuses(home, undefined, {
      platform: HOST_PLATFORM.platform,
      environment: {},
    });
    const piStatus = statuses.find(({ client: c }) => c === "pi");
    expect(piStatus).toMatchObject({
      client: "pi",
      state: "invalid",
      scope: "project",
      config_path: settingsPath,
    });
    expect(piStatus?.remediation).toContain("malformed");
  });
});
