import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseJsonc } from "jsonc-parser";

import { readClientRegistrationStatuses } from "../../../src/application/ClientRegistrationStatus.js";
import { configureClientConfiguration } from "../../../src/application/SetupClientConfiguration.js";
import { detectClients } from "../../../src/application/SetupHost.js";
import { supportedClients } from "../../../src/application/SupportedClients.js";
import { systemUninstallHost } from "../../../src/application/Uninstall.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  clearClientLocationEnvironment,
  NPX_REGISTRATION_COMMAND,
} from "../../fixtures/clientEnvironment.js";

beforeEach(clearClientLocationEnvironment);
afterEach(() => vi.unstubAllEnvs());

const piPath = (
  home: string,
  platform: NodeJS.Platform,
  env: Parameters<typeof supportedClients>[2],
) => supportedClients(home, platform, env).find(({ name }) => name === "pi");

// Catch fallback to OMP paths, loss of relative overrides, and normalization
// that differs from Pi's public getAgentDir()/normalizePath boundary.
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
      expect(client?.configPath).toBe(join(expected, "mcp.json"));
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

describe("Pi registration semantics", () => {
  it("preserves unrelated content and OMP-only lists during setup, repeat, and uninstall", async () => {
    const { home, client } = await piClient();
    const original = `{
  // Keep personal configuration.
  "autoEnableCodemode": false,
  "mcpServers": { "other": { "command": "other-server" } },
  "enabledServers": ["other"],
  "disabledServers": ["rea", "other"]
}\n`;
    await writeFile(client.configPath, original);
    expect(
      await configureClientConfiguration(client, {}, NPX_REGISTRATION_COMMAND),
    ).toMatchObject({ status: "configured" });
    expect(await readFile(`${client.configPath}.rea.backup`, "utf8")).toBe(
      original,
    );
    const configured = await readFile(client.configPath, "utf8");
    expect(configured).toContain("// Keep personal configuration.");
    expect(parseJsonc(configured)).toEqual({
      autoEnableCodemode: false,
      mcpServers: {
        other: { command: "other-server" },
        rea: {
          type: "stdio",
          command: "npx",
          args: NPX_REGISTRATION_COMMAND.slice(1),
        },
      },
      enabledServers: ["other"],
      disabledServers: ["rea", "other"],
    });
    expect(
      await configureClientConfiguration(client, {}, NPX_REGISTRATION_COMMAND),
    ).toEqual({ status: "unchanged" });
    expect(await readFile(client.configPath, "utf8")).toBe(configured);
    expect(
      (
        await readClientRegistrationStatuses(home, undefined, {
          environment: {},
        })
      ).find(({ client: name }) => name === "pi"),
    ).toMatchObject({ state: "aligned" });
    expect((await systemUninstallHost(home).removeClient(client)).status).toBe(
      "removed",
    );
    const removed = await readFile(client.configPath, "utf8");
    expect(removed).toContain("// Keep personal configuration.");
    expect(parseJsonc(removed)).toEqual(parseJsonc(original));
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
    "doctor handles type %s and enabled %s without OMP allowlist overrides",
    async (type, enabled, state) => {
      const { home, client } = await piClient();
      await writeFile(
        client.configPath,
        JSON.stringify({
          mcpServers: {
            rea: {
              command: "npx",
              args: NPX_REGISTRATION_COMMAND.slice(1),
              type,
              enabled,
            },
          },
          enabledServers: ["rea"],
        }),
      );
      const statuses = await readClientRegistrationStatuses(home, undefined, {
        environment: {},
      });
      expect(statuses.find(({ client: name }) => name === "pi")).toMatchObject({
        state,
      });
    },
  );
});
