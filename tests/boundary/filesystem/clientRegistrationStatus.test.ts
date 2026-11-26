import { HOST_PLATFORM } from "../../../src/platform/HostPlatform.js";
import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { clearClientLocationEnvironment } from "../../fixtures/clientEnvironment.js";

import {
  readClientRegistrationInspections,
  readClientRegistrationStatuses,
} from "../../../src/application/ClientRegistrationStatus.js";
import { configureClientConfiguration } from "../../../src/application/SetupClientConfiguration.js";
import {
  currentClientRegistrationCommand,
  classifyClientRegistrationCommand,
} from "../../../src/application/ClientRegistrationIdentity.js";
import { existingMaintenanceScope } from "../../../src/application/UpdateMaintenance.js";
import { ConfigurationError } from "../../../src/domain/configurationErrors.js";
import { err } from "../../../src/domain/result.js";
import { PRODUCT_IDENTITY } from "../../../src/identity.js";
import { CURRENT_ENTRYPOINT_PATH } from "../../../src/process/CurrentEntrypointPath.js";
import { supportedClientRegistrationProfile } from "../../fixtures/clientRegistrationProfile.js";

beforeEach(clearClientLocationEnvironment);
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("client registration status", () => {
  it("discovers a stale legacy Claude Code registration without a marker directory", async () => {
    const home = await createTestTempDirectory("rea-claude-config-only-");
    await writeFile(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          rea: {
            command: "npx",
            args: ["-y", PRODUCT_IDENTITY.registrationPackageSpecifier, "mcp"],
          },
        },
      }),
    );

    const statuses = await readClientRegistrationStatuses(
      home,
      "/current/rea",
      { platform: HOST_PLATFORM.platform },
    );

    expect(statuses).toEqual([
      expect.objectContaining({
        client: "claude_code",
        config_path: join(home, ".claude.json"),
        state: "stale",
        remediation: expect.stringMatching(/\S/u),
      }),
    ]);
  });

  it("distinguishes aligned, stale, missing, and invalid registrations", async () => {
    const home = await createTestTempDirectory("rea-registrations-");
    const currentEntry = join(home, "current-rea.mjs");
    const foreignEntry = join(home, "foreign-rea.mjs");
    await writeFile(currentEntry, "// current dispatcher\n");
    await writeFile(foreignEntry, "// different dispatcher\n");
    const currentCommand = currentClientRegistrationCommand({
      entrypointPath: currentEntry,
      environment: {},
    });
    await Promise.all([
      mkdir(join(home, ".codex")),
      mkdir(join(home, ".cursor")),
      mkdir(join(home, ".gemini")),
      mkdir(join(home, ".claude")),
    ]);
    await writeFile(
      join(home, ".codex/config.toml"),
      `[mcp_servers.rea]\ncommand = ${JSON.stringify(currentCommand[0])}\nargs = ${JSON.stringify(currentCommand.slice(1))}\nstartup_timeout_sec = 30\ntool_timeout_sec = 450\n`,
    );
    await writeFile(
      join(home, ".cursor/mcp.json"),
      JSON.stringify({
        mcpServers: {
          rea: { command: foreignEntry, args: ["mcp"], env: { SECRET: "x" } },
        },
      }),
    );
    await writeFile(join(home, ".gemini/settings.json"), "not-json");

    const statuses = await readClientRegistrationStatuses(home, currentEntry, {
      platform: HOST_PLATFORM.platform,
    });
    expect(statuses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          client: "codex",
          state: "aligned",
          remediation: null,
        }),
        expect.objectContaining({
          client: "cursor",
          state: "stale",
          command: [foreignEntry, "mcp"],
          remediation: expect.stringMatching(/\S/u),
        }),
        expect.objectContaining({
          client: "gemini_cli",
          state: "invalid",
          command: [],
          remediation: expect.stringMatching(/\S/u),
        }),
        expect.objectContaining({
          client: "claude_code",
          state: "missing",
          command: [],
          remediation: expect.stringMatching(/\S/u),
        }),
      ]),
    );
    expect(JSON.stringify(statuses)).not.toContain("SECRET");
  });

  it("reports a non-object server table as invalid", async () => {
    const home = await createTestTempDirectory("rea-registration-shape-");
    await mkdir(join(home, ".cursor"));
    const config = join(home, ".cursor", "mcp.json");
    await writeFile(config, '{"mcpServers":null}\n');
    expect(
      await readClientRegistrationStatuses(home, undefined, {
        platform: HOST_PLATFORM.platform,
      }),
    ).toEqual([
      expect.objectContaining({
        client: "cursor",
        config_path: config,
        state: "invalid",
        command: [],
        remediation: expect.stringContaining("mcpServers"),
      }),
    ]);
  });
});

describe("client registration environment validation", () => {
  it("reports invalid LM Studio runtime settings without requiring an explicit profile", async () => {
    const home = await createTestTempDirectory("rea-lm-studio-env-");
    await mkdir(join(home, ".lmstudio"));
    await writeFile(
      join(home, ".lmstudio/mcp.json"),
      JSON.stringify({
        mcpServers: {
          rea: {
            command: "npx",
            args: ["-y", PRODUCT_IDENTITY.registrationPackageSpecifier, "mcp"],
            env: { REA_MCP_INPUT_SCHEMA_PROFILE: "invalid" },
          },
        },
      }),
    );
    const statuses = await readClientRegistrationStatuses(
      home,
      "/current/rea",
      { platform: HOST_PLATFORM.platform },
    );
    expect(statuses).toContainEqual(
      expect.objectContaining({
        client: "lm_studio",
        state: "invalid",
        remediation: expect.stringContaining("REA_MCP_INPUT_SCHEMA_PROFILE"),
      }),
    );
  });
  it("reports an otherwise aligned registration invalid for a bad tool-family scope", async () => {
    const home = await createTestTempDirectory("rea-registration-env-");
    await mkdir(join(home, ".cursor"));
    await writeFile(
      join(home, ".cursor/mcp.json"),
      JSON.stringify({
        mcpServers: {
          rea: {
            command: "npx",
            args: ["-y", PRODUCT_IDENTITY.registrationPackageSpecifier, "mcp"],
            env: { REA_MCP_TOOL_FAMILIES: "session,typo" },
          },
        },
      }),
    );

    const statuses = await readClientRegistrationStatuses(
      home,
      "/current/rea",
      { platform: HOST_PLATFORM.platform },
    );

    expect(statuses).toEqual([
      expect.objectContaining({
        client: "cursor",
        state: "invalid",
        command: [],
        remediation: expect.stringContaining("REA_MCP_TOOL_FAMILIES"),
      }),
    ]);
  });

  it("resolves provider budgets only for Kimi/Codex registrations", async () => {
    const home = await createTestTempDirectory("rea-registration-budget-");
    await mkdir(join(home, ".cursor"));
    await mkdir(join(home, ".codex"));
    await mkdir(join(home, ".lmstudio"));
    await mkdir(join(home, ".kimi-code"));
    const entry = {
      command: "npx",
      args: ["-y", PRODUCT_IDENTITY.registrationPackageSpecifier, "mcp"],
    };
    await writeFile(
      join(home, ".cursor/mcp.json"),
      JSON.stringify({ mcpServers: { rea: entry } }),
    );
    for (const path of [".lmstudio/mcp.json", ".kimi-code/mcp.json"])
      await writeFile(
        join(home, path),
        JSON.stringify({ mcpServers: { rea: entry } }),
      );
    await writeFile(
      join(home, ".codex/config.toml"),
      `[mcp_servers.rea]\ncommand = "npx"\nargs = ["-y", "${PRODUCT_IDENTITY.registrationPackageSpecifier}", "mcp"]\n`,
    );
    const resolveProviderRequestBudget = async () =>
      err(new ConfigurationError("budget unavailable"));

    const statuses = await readClientRegistrationStatuses(
      home,
      "/current/rea",
      { platform: HOST_PLATFORM.platform, resolveProviderRequestBudget },
    );

    const byClient = new Map(statuses.map((status) => [status.client, status]));
    // The failing resolver must not invalidate non-Kimi/Codex registrations.
    expect(byClient.has("cursor")).toBe(true);
    expect(byClient.get("cursor")?.state).not.toBe("invalid");
    expect(byClient.has("lm_studio")).toBe(true);
    expect(byClient.get("lm_studio")?.state).not.toBe("invalid");
    for (const client of ["codex", "kimi"])
      expect(byClient.get(client)).toMatchObject({
        state: "invalid",
        remediation: expect.stringContaining("budget unavailable"),
      });
  });
});

describe("client registration launcher identity", () => {
  it("reports unpinned npx and bunx launchers as owned but stale", async () => {
    const home = await createTestTempDirectory("rea-package-runner-status-");
    await mkdir(join(home, ".codex"));
    await writeFile(
      join(home, ".codex", "config.toml"),
      '[mcp_servers.rea]\ncommand = "npx"\nargs = ["-y", "rea-agents", "mcp"]\nstartup_timeout_sec = 30\ntool_timeout_sec = 450\n',
    );
    await writeFile(
      join(home, ".claude.json"),
      '{"mcpServers":{"rea":{"command":"bunx","args":["rea-agents","mcp"]}}}',
    );

    const statuses = await readClientRegistrationStatuses(home, undefined, {
      platform: HOST_PLATFORM.platform,
    });
    expect(statuses).toEqual([
      expect.objectContaining({
        client: "claude_code",
        command: ["bunx", "rea-agents", "mcp"],
        command_identity: "owned",
        package_reference: "rea-agents",
        state: "stale",
      }),
      expect.objectContaining({
        client: "codex",
        command: ["npx", "-y", "rea-agents", "mcp"],
        command_identity: "owned",
        package_reference: "rea-agents",
        state: "stale",
      }),
    ]);
  });

  it("preserves direct command identity as unknown when the current entrypoint is absent", async () => {
    const home = await createTestTempDirectory("rea-registration-unknown-");
    await mkdir(join(home, ".cursor"));
    const command = ["/opt/rea/bin/rea", "mcp"];
    const config = join(home, ".cursor/mcp.json");
    const original = JSON.stringify({
      mcpServers: { rea: { command: command[0], args: [command[1]] } },
    });
    await writeFile(config, original);

    const [status] = await readClientRegistrationStatuses(home, "", {
      platform: HOST_PLATFORM.platform,
    });

    expect(status).toMatchObject({
      client: "cursor",
      command,
      state: "unknown",
      config_path: config,
      remediation: expect.stringMatching(/\S/u),
    });
    expect(
      await readClientRegistrationInspections(home, "", {
        platform: HOST_PLATFORM.platform,
      }),
    ).toEqual([
      expect.objectContaining({
        status,
        activation: "enabled",
      }),
    ]);
    expect(await readFile(config, "utf8")).toBe(original);
  });

  it("does not use the REA process cwd to resolve a client's relative launcher path", async () => {
    const home = await createTestTempDirectory("rea-registration-relative-");
    await mkdir(join(home, ".cursor"));
    const currentEntry = resolve("./rea.mjs");
    const configPath = join(home, ".cursor/mcp.json");
    const registration = (
      scriptPath: string,
      executable = process.execPath,
    ) => ({
      mcpServers: {
        rea: { command: executable, args: [scriptPath, "mcp"] },
      },
    });
    await writeFile(configPath, JSON.stringify(registration("./rea.mjs")));

    const [relativeStatus] = await readClientRegistrationStatuses(
      home,
      currentEntry,
      { platform: HOST_PLATFORM.platform },
    );
    expect(relativeStatus).toMatchObject({
      command: [process.execPath, "./rea.mjs", "mcp"],
      state: "unknown",
    });

    await writeFile(configPath, JSON.stringify(registration(currentEntry)));
    const [absoluteStatus] = await readClientRegistrationStatuses(
      home,
      currentEntry,
      { platform: HOST_PLATFORM.platform },
    );
    expect(absoluteStatus).toMatchObject({
      command: [process.execPath, currentEntry, "mcp"],
      state: "aligned",
    });

    const relativeInterpreter = relative(process.cwd(), process.execPath);
    await writeFile(
      configPath,
      JSON.stringify(registration(currentEntry, relativeInterpreter)),
    );
    const [relativeInterpreterStatus] = await readClientRegistrationStatuses(
      home,
      currentEntry,
      { platform: HOST_PLATFORM.platform },
    );
    expect(relativeInterpreterStatus).toMatchObject({
      command: [relativeInterpreter, currentEntry, "mcp"],
      state: "unknown",
    });
  });
});

describe("client registration package version identity", () => {
  it.each([
    ["4.1.0", true],
    ["v4.1.0", false],
  ] as const)(
    "preserves package version %s ownership with canonical-only drift reporting",
    async (version, reportsDrift) => {
      const home = await createTestTempDirectory(
        "rea-registration-version-drift-",
      );
      await mkdir(join(home, ".codex"));
      const reference = `rea-agents@${version}`;
      const command = ["npx", "-y", reference, "mcp"];
      await writeFile(
        join(home, ".codex/config.toml"),
        `[mcp_servers.rea]\ncommand = "${command[0]}"\nargs = ["${command[1]}", "${command[2]}", "${command[3]}"]\n`,
      );

      const [status] = await readClientRegistrationStatuses(home, undefined, {
        platform: HOST_PLATFORM.platform,
      });

      expect(classifyClientRegistrationCommand(command, undefined)).toBe(
        "owned",
      );
      expect(status).toMatchObject({
        client: "codex",
        command,
        package_reference: reference,
        state: "stale",
      });
      if (reportsDrift) {
        expect(status?.remediation).toContain(
          `current REA CLI package is ${PRODUCT_IDENTITY.packageVersion}`,
        );
        expect(status?.remediation).toContain(
          "does not resolve package-runner",
        );
        expect(status?.remediation).toContain("rea setup --client codex");
      } else {
        expect(status?.remediation).not.toContain("current REA CLI package");
        expect(status?.remediation).not.toContain(
          "does not resolve package-runner",
        );
      }
      expect(status?.remediation).toContain("rea setup");
    },
  );
});

describe("commandcode registration status", () => {
  const writeCommandcodeRegistration = async (
    home: string,
    registration: Record<string, unknown>,
  ): Promise<void> => {
    await mkdir(join(home, ".commandcode"));
    await writeFile(
      join(home, ".commandcode/mcp.json"),
      JSON.stringify({ mcpServers: { rea: registration } }),
    );
  };

  const entry = resolve("scripts/rea.mjs");
  const ownedArgs = (): readonly string[] => [entry, "mcp"];

  // Published command-code1.88.5 file loading accepts defaults and type aliases;
  // its management/add-json parser has a different, stricter grammar.
  it.each([
    { fields: {}, state: "aligned" },
    { fields: { type: "stdio" }, state: "aligned" },
    {
      fields: {
        transport: "STDIO",
        type: "sse",
        url: "https://fixture.invalid",
      },
      state: "aligned",
    },
    {
      fields: { transport: "sse", url: "https://fixture.invalid" },
      state: "unknown",
    },
    { fields: { transport: { operator: true } }, state: "invalid" },
  ] as const)(
    "reports native transport fields $fields as $state",
    async ({ fields, state }) => {
      const home = await createTestTempDirectory("rea-commandcode-transport-");
      const registration = {
        ...fields,
        command: process.execPath,
        args: [...ownedArgs()],
      };
      await writeCommandcodeRegistration(home, registration);
      const original = await readFile(
        join(home, ".commandcode/mcp.json"),
        "utf8",
      );
      expect(
        await readClientRegistrationStatuses(home, entry, {
          platform: HOST_PLATFORM.platform,
        }),
      ).toEqual([
        expect.objectContaining({
          client: "commandcode",
          state,
          command_identity: "owned",
          command:
            state === "invalid" ? [] : [process.execPath, ...ownedArgs()],
        }),
      ]);
      expect(await readFile(join(home, ".commandcode/mcp.json"), "utf8")).toBe(
        original,
      );
    },
  );

  it("reports a disabled registration as stale", async () => {
    const home = await createTestTempDirectory("rea-commandcode-disabled-");
    await writeCommandcodeRegistration(home, {
      transport: "stdio",
      enabled: false,
      command: process.execPath,
      args: [...ownedArgs()],
    });

    expect(
      await readClientRegistrationStatuses(home, entry, {
        platform: HOST_PLATFORM.platform,
      }),
    ).toEqual([
      expect.objectContaining({
        client: "commandcode",
        state: "stale",
      }),
    ]);
  });
});

it("reports activation using only the key each client honors", async () => {
  const home = await createTestTempDirectory("rea-registration-activation-");
  const platform = HOST_PLATFORM.platform;
  const entry = resolve("scripts/rea.mjs");
  const launcher = { command: process.execPath, args: [entry, "mcp"] };
  const codex = join(home, ".codex", "config.toml");
  const kimi = join(home, ".kimi-code", "mcp.json");
  const devin = join(
    platform === "win32"
      ? join(home, "AppData", "Roaming", "devin")
      : join(home, ".config", "devin"),
    "mcp_config.json",
  );
  for (const path of [codex, kimi, devin]) {
    await mkdir(dirname(path), { recursive: true });
  }

  for (const expected of ["enabled", "disabled"] as const) {
    const disabled = expected === "disabled";
    await writeFile(
      codex,
      `[mcp_servers.rea]\ncommand = ${JSON.stringify(launcher.command)}\nargs = ${JSON.stringify(launcher.args)}\nstartup_timeout_sec = 30\ntool_timeout_sec = 450\n${disabled ? "enabled = false" : "disabled = true"}\n`,
    );
    await writeFile(
      kimi,
      JSON.stringify({
        mcpServers: {
          rea: {
            ...launcher,
            env: { REA_MCP_INPUT_SCHEMA_PROFILE: "compact" },
            startupTimeoutMs: 30_000,
            toolTimeoutMs: 450_000,
            ...(disabled ? { enabled: false } : { disabled: true }),
          },
        },
      }),
    );
    await writeFile(
      devin,
      JSON.stringify({
        mcpServers: {
          rea: {
            ...launcher,
            ...(disabled ? { disabled: true } : { enabled: false }),
          },
        },
      }),
    );
    const inspections = await readClientRegistrationInspections(home, entry, {
      platform,
      environment: { XDG_CONFIG_HOME: join(home, ".config") },
    });
    expect(
      inspections.map(({ status, activation }) => ({
        name: status.client,
        path: status.config_path,
        state: status.state,
        activation,
      })),
    ).toEqual([
      {
        name: "codex",
        path: codex,
        state: disabled ? "stale" : "aligned",
        activation: expected,
      },
      {
        name: "devin",
        path: devin,
        state: disabled ? "stale" : "aligned",
        activation: expected,
      },
      {
        name: "kimi",
        path: kimi,
        state: disabled ? "stale" : "aligned",
        activation: expected,
      },
    ]);
  }
});

describe("Ghidra multi-function deadline registration advice", () => {
  it.each([
    { provider: "ghidra", timeout: 10, hasBatchScope: true },
    { provider: "ghidra", timeout: 1800, hasBatchScope: true },
    { provider: "hopper", timeout: 1800, hasBatchScope: false },
  ])(
    "preserves a selected $timeout-second $provider deadline and describes its scope",
    async ({ provider, timeout, hasBatchScope }) => {
      const home = await createTestTempDirectory("rea-codex-decompile-scope-");
      await mkdir(join(home, ".codex"));
      const entry = CURRENT_ENTRYPOINT_PATH;
      if (entry === undefined) throw new Error("missing current entrypoint");
      const configPath = join(home, ".codex/config.toml");
      // Two 600-second Ghidra decompiles plus startup/headroom would need an
      // estimated 1650 seconds. A caller's shorter or longer choice stays theirs.
      const original = `[mcp_servers.rea]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(entry)}, "mcp"]\nstartup_timeout_sec = 30\ntool_timeout_sec = ${timeout}\n[mcp_servers.rea.env]\nREA_ANALYSIS_PROVIDER = "${provider}"\nREA_GHIDRA_DECOMPILE_TIMEOUT_SECONDS = "600"\n`;
      await writeFile(configPath, original);
      const [status] = await readClientRegistrationStatuses(home, entry, {
        platform: HOST_PLATFORM.platform,
        environment: {},
      });
      expect(status).toMatchObject({ client: "codex", state: "aligned" });
      if (hasBatchScope) {
        expect(status?.advisory).toContain("single-decompile estimate");
        expect(status?.advisory).toContain("every attempted function");
        expect(status?.advisory).toContain("trace_native_values");
        expect(status?.advisory).toContain("max_functions");
      } else expect(status?.advisory).toBeUndefined();
      const configured = await configureClientConfiguration(
        {
          name: "codex",
          registrationProfile: supportedClientRegistrationProfile("codex"),
          format: "toml",
          configPath,
        },
        {},
        [process.execPath, entry, "mcp"],
      );
      expect(configured).toMatchObject({ status: "unchanged" });
      expect(await readFile(configPath, "utf8")).toBe(original);
      await expect(readFile(`${configPath}.rea.backup`)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );
});

describe("launcher and timeout policy", () => {
  it("keeps caller deadlines aligned and distinguishes direct launch and Grok disablement", async () => {
    const home = await createTestTempDirectory("rea-registration-timeouts-");
    const entry = resolve("scripts/rea.mjs");
    const codex = join(home, ".codex", "config.toml");
    const grok = join(home, ".grok", "config.toml");
    await mkdir(dirname(codex));
    await mkdir(dirname(grok));
    const command = `command = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(entry)}, "mcp"]\n`;
    const prefix = "[mcp_servers.rea]\n";
    const timeouts = "startup_timeout_sec = 1\ntool_timeout_sec = 10\n";
    const grokRegistration = `${prefix}${command}startup_timeout_sec = 90\n`;
    const read = () =>
      readClientRegistrationInspections(home, entry, {
        platform: HOST_PLATFORM.platform,
        environment: {},
      });

    await writeFile(codex, `${prefix}${command}${timeouts}`);
    await writeFile(grok, grokRegistration);
    expect(await read()).toMatchObject([
      {
        activation: "enabled",
        status: {
          client: "codex",
          state: "aligned",
          advisory: expect.stringContaining("tool_timeout_sec = 450 seconds"),
        },
      },
      {
        activation: "enabled",
        status: { client: "grok_build", state: "aligned" },
      },
    ]);

    await writeFile(
      codex,
      `${prefix}command = ${JSON.stringify(entry)}\nargs = ["mcp"]\n${timeouts}`,
    );
    await writeFile(
      grok,
      `disabled_mcp_servers = ["rea"]\n${grokRegistration}`,
    );
    expect(await read()).toMatchObject([
      {
        activation: "enabled",
        status: {
          client: "codex",
          command: [entry, "mcp"],
          command_identity: "owned",
          state: "stale",
          remediation: expect.stringContaining("rea setup"),
        },
      },
      {
        activation: "disabled",
        status: { client: "grok_build", state: "stale" },
      },
    ]);
  });

  it.each([{ tools: ["binary_session"] }, { tools: ["*"] }, { tools: [] }])(
    "checks Copilot tool selection $tools independently of launcher",
    async ({ tools }) => {
      const home = await createTestTempDirectory("rea-node-copilot-");
      await mkdir(join(home, ".copilot"));
      const entry = resolve("scripts/rea.mjs");
      await writeFile(
        join(home, ".copilot/mcp-config.json"),
        JSON.stringify({
          mcpServers: {
            rea: {
              type: "stdio",
              command: process.execPath,
              args: [entry, "mcp"],
              tools,
            },
          },
        }),
      );
      const statuses = await readClientRegistrationStatuses(home, entry, {
        platform: HOST_PLATFORM.platform,
        environment: {},
      });
      expect(statuses).toEqual([
        expect.objectContaining({
          client: "copilot_cli",
          state: "aligned",
        }),
      ]);
    },
  );
});

it("inspects the explicitly selected client even when discovery cannot probe it", async () => {
  const home = await createTestTempDirectory("rea-selected-unreachable-");
  await writeFile(join(home, ".agents"), "not a directory");
  const options = { platform: HOST_PLATFORM.platform, environment: {} };

  const discovered = await readClientRegistrationStatuses(
    home,
    "/current/rea",
    options,
  );
  expect(discovered.map(({ client }) => client)).not.toContain("freebuff");
  const selected = await readClientRegistrationStatuses(home, "/current/rea", {
    ...options,
    selectedClientIds: ["freebuff"],
  });
  expect(selected).toEqual([
    expect.objectContaining({
      client: "freebuff",
      config_path: join(home, ".agents", "mcp.json"),
      command: [],
      ...(process.platform === "win32"
        ? {}
        : {
            state: "invalid",
            remediation: expect.stringContaining("could not be read"),
          }),
    }),
  ]);
});

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "reports an inaccessible configuration target instead of omitting its registration",
  async () => {
    const home = await createTestTempDirectory(
      "rea-registration-denied-target-",
    );
    const locked = join(home, "owned-denied");
    await mkdir(locked);
    const target = join(locked, "client.json");
    await writeFile(
      target,
      JSON.stringify({
        mcpServers: { rea: { command: "rea", args: ["mcp"] } },
      }),
    );
    const path = join(home, ".claude.json");
    await symlink(target, path);
    await chmod(locked, 0);
    try {
      const statuses = await readClientRegistrationStatuses(
        home,
        "/current/rea",
        { platform: HOST_PLATFORM.platform },
      );
      expect(
        statuses.find((status) => status.client === "claude_code"),
      ).toMatchObject({
        config_path: path,
        state: "invalid",
        command: [],
        remediation: expect.stringMatching(/\S/u),
      });
      expect(
        (
          await existingMaintenanceScope(home, "/current/rea", process.env, {
            platform: HOST_PLATFORM.platform,
          })
        ).clients,
      ).not.toContain("claude_code");
    } finally {
      await chmod(locked, 0o700);
    }
  },
);

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "reports an unresolved configuration location when metadata lookup is denied",
  async () => {
    const home = await createTestTempDirectory(
      "rea-registration-denied-metadata-",
    );
    const locked = join(home, "owned-denied");
    const directory = join(locked, "claude");
    await mkdir(directory, { recursive: true });
    vi.stubEnv("CLAUDE_CONFIG_DIR", directory);
    await chmod(locked, 0);
    try {
      const statuses = await readClientRegistrationStatuses(
        home,
        "/current/rea",
        { platform: HOST_PLATFORM.platform },
      );
      expect(
        statuses.find((status) => status.client === "claude_code"),
      ).toMatchObject({
        state: "invalid",
        command: [],
        remediation: expect.stringContaining("EACCES"),
      });
    } finally {
      await chmod(locked, 0o700);
    }
  },
);

it("ignores project candidates below regular files during automatic discovery", async () => {
  const root = await createTestTempDirectory("rea-project-evidence-");
  const home = join(root, "home");
  const project = join(root, "project");
  await mkdir(home);
  await mkdir(project);
  await writeFile(join(project, ".pi"), "not a configuration directory");
  await writeFile(join(root, ".opencode"), "not a configuration directory");
  const cwd = vi.spyOn(process, "cwd").mockReturnValue(project);
  try {
    const read = () =>
      readClientRegistrationStatuses(home, undefined, {
        platform: HOST_PLATFORM.platform,
        environment: {},
      });
    const absence = await read();
    expect(absence.map(({ client }) => client)).not.toContain("pi");
    expect(absence.map(({ client }) => client)).not.toContain("opencode");

    const present = join(project, "opencode.json");
    await writeFile(present, "invalid JSON");
    const statuses = await read();
    expect(statuses.find(({ client }) => client === "opencode")).toMatchObject({
      state: "invalid",
      config_path: present,
      scope: "project",
    });
  } finally {
    cwd.mockRestore();
  }
});

it("reports an unresolved client location as unknown and still inspects other clients", async () => {
  const home = await createTestTempDirectory("rea-registration-unknown-path-");
  await writeFile(
    join(home, ".claude.json"),
    JSON.stringify({ mcpServers: { rea: { command: "/old/rea", args: [] } } }),
  );
  const statuses = await readClientRegistrationStatuses(home, "/current/rea", {
    platform: HOST_PLATFORM.platform,
    environment: { MCPORTER_CONFIG: "config/mcporter.json" },
  });
  expect(statuses.find(({ client }) => client === "mcporter")).toEqual({
    client: "mcporter",
    config_path: "config/mcporter.json",
    command: [],
    command_identity: "unknown",
    state: "unknown",
    remediation: expect.stringContaining("MCPORTER_CONFIG is relative"),
  });
  expect(statuses.find(({ client }) => client === "claude_code")).toMatchObject(
    { state: "stale" },
  );
});

it("reports a dangling configuration entry as missing without losing the detected client", async () => {
  const home = await createTestTempDirectory(
    "rea-registration-dangling-config-",
  );
  const path = join(home, ".claude.json");
  await symlink(join(home, "absent.json"), path);
  expect(
    (
      await readClientRegistrationStatuses(home, undefined, {
        platform: HOST_PLATFORM.platform,
      })
    ).find((status) => status.client === "claude_code"),
  ).toMatchObject({ config_path: path, state: "missing", command: [] });
});
