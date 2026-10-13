import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readClientRegistrationStatuses } from "../../../src/application/ClientRegistrationStatus.js";
import { setupRegistrationCommand } from "../../../src/application/SetupHost.js";
import { configureClientConfiguration } from "../../../src/application/SetupClientConfiguration.js";
import {
  clientSkillDirectories,
  supportedClients,
} from "../../../src/application/SupportedClients.js";
import { systemUninstallHost } from "../../../src/application/Uninstall.js";
import { MCP_STARTUP_POLICY } from "../../../src/mcpStartupPolicy.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  clearClientLocationEnvironment,
  NPX_REGISTRATION_COMMAND,
} from "../../fixtures/clientEnvironment.js";

const command = NPX_REGISTRATION_COMMAND;

beforeEach(clearClientLocationEnvironment);
afterEach(() => vi.unstubAllEnvs());

const kimiPath = (
  home: string,
  platform: NodeJS.Platform,
  env: Parameters<typeof supportedClients>[2] = {},
) => supportedClients(home, platform, env).find(({ name }) => name === "kimi");

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const expectedRegistration = (launcher: readonly string[]) => ({
  command: launcher[0],
  args: launcher.slice(1),
  startupTimeoutMs: MCP_STARTUP_POLICY.kimiStartupTimeoutMs,
  toolTimeoutMs: MCP_STARTUP_POLICY.kimiToolTimeoutMs,
});

describe("Kimi Code configuration paths and skills", () => {
  it.each([
    [undefined, join("/home/a/.kimi-code")],
    ["", join("/home/a/.kimi-code")],
    [join("/tmp", "isolated-kimi"), join("/tmp", "isolated-kimi")],
  ])("resolves KIMI_CODE_HOME for %j", (override, directory) => {
    const client = kimiPath(
      "/home/a",
      "linux",
      override === undefined ? {} : { KIMI_CODE_HOME: override },
    );
    expect(client).toEqual({
      name: "kimi",
      displayName: "Kimi Code",
      configPath: join(directory, "mcp.json"),
      markerPath: directory,
      format: "kimi",
    });
  });

  it("uses the existing shared skill destination without a separate skill root", () => {
    expect(clientSkillDirectories("/home/a", ["kimi"])).toEqual([
      { client: "shared", directory: "/home/a/.agents/skills" },
    ]);
  });
});

describe("Kimi Code registration lifecycle", () => {
  const kimiClient = async () => {
    const home = await createTestTempDirectory("rea-kimi-");
    const client = kimiPath(home, process.platform, {});
    if (client?.markerPath === undefined)
      throw new Error("missing Kimi Code client");
    await mkdir(client.markerPath, { recursive: true });
    return { home, client };
  };

  it("preserves the caller's enabledTools selection during refresh", async () => {
    const { client } = await kimiClient();
    const enabledTools = ["binary_session", "analyze_javascript_application"];
    await writeFile(
      client.configPath,
      JSON.stringify({
        mcpServers: {
          rea: { command: "old-rea", args: ["mcp"], enabledTools },
        },
      }),
    );
    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    expect(
      JSON.parse(await readFile(client.configPath, "utf8")).mcpServers.rea,
    ).toEqual({
      ...expectedRegistration(command),
      enabledTools,
    });
    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("unchanged");
  });

  it("registers without type, preserves unrelated settings, backs up, and is idempotent", async () => {
    const { home, client } = await kimiClient();
    const original = `{
  "customSetting": { "enabled": true },
  "mcpServers": {
    "other": { "command": "other-server", "startupTimeoutMs": 5000 }
  }
}
`;
    await writeFile(client.configPath, original);

    expect(await configureClientConfiguration(client, {}, command)).toEqual({
      status: "configured",
      backupPath: `${client.configPath}.rea.backup`,
    });
    const text = await readFile(client.configPath, "utf8");
    expect(JSON.parse(text)).toEqual({
      customSetting: { enabled: true },
      mcpServers: {
        other: { command: "other-server", startupTimeoutMs: 5000 },
        rea: expectedRegistration(command),
      },
    });
    expect(text).not.toContain('"type"');
    expect(text).not.toContain('"transport"');
    expect(await readFile(`${client.configPath}.rea.backup`, "utf8")).toBe(
      original,
    );
    expect(await configureClientConfiguration(client, {}, command)).toEqual({
      status: "unchanged",
    });
    expect(await readFile(client.configPath, "utf8")).toBe(text);
    expect(
      (
        await readClientRegistrationStatuses(home, undefined, {
          environment: {},
        })
      ).find(({ client: name }) => name === "kimi"),
    ).toMatchObject({ state: "aligned", command });

    expect((await systemUninstallHost(home).removeClient(client)).status).toBe(
      "removed",
    );
    expect(JSON.parse(await readFile(client.configPath, "utf8"))).toEqual({
      customSetting: { enabled: true },
      mcpServers: {
        other: { command: "other-server", startupTimeoutMs: 5000 },
      },
    });
  });
});

describe("Kimi Code package launchers", () => {
  const kimiClient = async () => {
    const home = await createTestTempDirectory("rea-kimi-launcher-");
    const client = kimiPath(home, process.platform, {});
    if (client?.markerPath === undefined)
      throw new Error("missing Kimi Code client");
    await mkdir(client.markerPath, { recursive: true });
    return { home, client } as const;
  };

  it.each([
    ["npx", "linux"],
    ["bunx", "linux"],
    ["npx", "win32"],
    ["bunx", "win32"],
  ] as const)(
    "keeps the %s launcher aligned on %s",
    async (runner, platform) => {
      const { home, client } = await kimiClient();
      const launcher = setupRegistrationCommand(platform, runner);
      expect(
        (await configureClientConfiguration(client, {}, launcher)).status,
      ).toBe("configured");
      expect(
        JSON.parse(await readFile(client.configPath, "utf8")).mcpServers.rea,
      ).toEqual(expectedRegistration(launcher));
      expect(
        (
          await readClientRegistrationStatuses(home, undefined, {
            platform,
            environment: {},
          })
        ).find(({ client: name }) => name === "kimi"),
      ).toMatchObject({ state: "aligned", command: launcher });
      expect(await configureClientConfiguration(client, {}, launcher)).toEqual({
        status: "unchanged",
      });
    },
  );
});

describe("Kimi Code transport validation", () => {
  const kimiClient = async () => {
    const home = await createTestTempDirectory("rea-kimi-validation-");
    const client = kimiPath(home, process.platform, {});
    if (client?.markerPath === undefined)
      throw new Error("missing Kimi Code client");
    await mkdir(client.markerPath, { recursive: true });
    return { home, client };
  };

  it("creates a registration in a zero-byte file and accepts whitespace-only files", async () => {
    const { home, client } = await kimiClient();
    for (const original of ["", " \n\t"]) {
      await writeFile(client.configPath, original);
      expect(
        (await configureClientConfiguration(client, {}, command)).status,
      ).toBe("configured");
      expect(
        JSON.parse(await readFile(client.configPath, "utf8")).mcpServers.rea,
      ).toEqual(expectedRegistration(command));
      expect(await configureClientConfiguration(client, {}, command)).toEqual({
        status: "unchanged",
      });
      expect(
        (await systemUninstallHost(home).removeClient(client)).status,
      ).toBe("removed");
    }
  });

  it.each([
    '{"mcpServers": {',
    '{/* comment */ "mcpServers": {}}',
    '{"mcpServers": {},}',
    '\uFEFF{"mcpServers": {}}',
  ])("rejects invalid strict JSON %j without writes", async (original) => {
    const { client } = await kimiClient();
    await writeFile(client.configPath, original);
    expect(await configureClientConfiguration(client, {}, command)).toEqual({
      status: "failed",
      reason: "readback",
    });
    expect(await readFile(client.configPath, "utf8")).toBe(original);
    expect(await exists(`${client.configPath}.rea.backup`)).toBe(false);
  });

  it("accepts explicit stdio transport without causing repeated rewrites", async () => {
    const { home, client } = await kimiClient();
    await writeFile(
      client.configPath,
      JSON.stringify({
        mcpServers: {
          rea: {
            transport: "stdio",
            ...expectedRegistration(command),
          },
        },
      }),
    );
    expect(
      (
        await readClientRegistrationStatuses(home, undefined, {
          environment: {},
        })
      ).find(({ client: name }) => name === "kimi"),
    ).toMatchObject({ state: "aligned", command });
    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    expect(await configureClientConfiguration(client, {}, command)).toEqual({
      status: "unchanged",
    });
    expect(await configureClientConfiguration(client, {}, command)).toEqual({
      status: "unchanged",
    });
    expect(
      (
        await readClientRegistrationStatuses(home, undefined, {
          environment: {},
        })
      ).find(({ client: name }) => name === "kimi"),
    ).toMatchObject({ state: "aligned", command });
  });

  it.each(["sse"])(
    "rejects explicit transport %j instead of silently accepting another protocol",
    async (transport) => {
      const { home, client } = await kimiClient();
      await writeFile(
        client.configPath,
        JSON.stringify({
          mcpServers: {
            rea: {
              transport,
              ...expectedRegistration(command),
            },
          },
        }),
      );
      expect(
        (
          await readClientRegistrationStatuses(home, undefined, {
            environment: {},
          })
        ).find(({ client: name }) => name === "kimi"),
      ).toMatchObject({ state: "invalid", command: [] });
    },
  );
});

describe("Kimi Code timeout validation", () => {
  const kimiClient = async () => {
    const home = await createTestTempDirectory("rea-kimi-timeout-");
    const client = kimiPath(home, process.platform, {});
    if (client?.markerPath === undefined)
      throw new Error("missing Kimi Code client");
    await mkdir(client.markerPath, { recursive: true });
    return { home, client } as const;
  };

  it.each([
    ["startupTimeoutMs", 1],
    ["toolTimeoutMs", 1],
    ["startupTimeoutMs", undefined],
    ["toolTimeoutMs", undefined],
  ] as const)("reports stale when %s is %j", async (field, value) => {
    const { home, client } = await kimiClient();
    const registration = {
      ...expectedRegistration(command),
      [field]: value,
    };
    await writeFile(
      client.configPath,
      JSON.stringify({ mcpServers: { rea: registration } }),
    );
    expect(
      (
        await readClientRegistrationStatuses(home, undefined, {
          environment: {},
        })
      ).find(({ client: name }) => name === "kimi"),
    ).toMatchObject({ state: "stale" });
  });

  it("uses a direct installed REA command without requiring a package runner", async () => {
    const { home, client } = await kimiClient();
    const entry = join(home, "scripts", "rea.mjs");
    const launcher = [process.execPath, entry, "mcp"];
    expect(
      (await configureClientConfiguration(client, {}, launcher)).status,
    ).toBe("configured");
    expect(
      (
        await readClientRegistrationStatuses(home, entry, {
          environment: {},
        })
      ).find(({ client: name }) => name === "kimi"),
    ).toMatchObject({ state: "aligned", command: launcher });
  });

  it("leaves a foreign rea-key registration out of aligned state", async () => {
    const { home, client } = await kimiClient();
    await writeFile(
      client.configPath,
      JSON.stringify({
        mcpServers: {
          rea: {
            ...expectedRegistration(command),
            command: "another-package",
            args: ["mcp"],
          },
        },
      }),
    );
    expect(
      (
        await readClientRegistrationStatuses(home, undefined, {
          environment: {},
        })
      ).find(({ client: name }) => name === "kimi"),
    ).toMatchObject({ state: "stale" });
  });
});
