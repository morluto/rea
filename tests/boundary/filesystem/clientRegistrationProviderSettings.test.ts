import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { recordedProviderSettings } from "../../../src/application/ClientRegistrationEnvironment.js";
import { readClientRegistrationStatuses } from "../../../src/application/ClientRegistrationStatus.js";
import { PRODUCT_IDENTITY } from "../../../src/identity.js";
import { CURRENT_ENTRYPOINT_PATH } from "../../../src/process/CurrentEntrypointPath.js";
import { clearClientLocationEnvironment } from "../../fixtures/clientEnvironment.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

beforeEach(clearClientLocationEnvironment);
afterEach(() => {
  vi.unstubAllEnvs();
});

const selected = {
  GHIDRA_INSTALL_DIR: "/opt/ghidra",
  JAVA_HOME: "/opt/jdk",
};
const entry = (env: unknown) =>
  JSON.stringify({
    mcpServers: {
      rea: {
        command: process.execPath,
        args: [CURRENT_ENTRYPOINT_PATH, "mcp"],
        ...(env === undefined ? {} : { env }),
      },
    },
  });
const readClaudeCode = async (env: unknown) => {
  const home = await createTestTempDirectory("rea-recorded-settings-");
  await writeFile(join(home, ".claude.json"), entry(env));
  const [status] = await readClientRegistrationStatuses(
    home,
    CURRENT_ENTRYPOINT_PATH,
    { environment: {}, providerSettings: selected },
  );
  return status;
};

it.each([
  [
    "a registration with no environment map",
    undefined,
    {
      unrecorded: ["GHIDRA_INSTALL_DIR", "JAVA_HOME"],
      differing: [],
      unresolved: [],
    },
  ],
  [
    "a registration recording only part of the selection",
    { GHIDRA_INSTALL_DIR: "/opt/ghidra" },
    { unrecorded: ["JAVA_HOME"], differing: [], unresolved: [] },
  ],
  [
    "a registration recording another value",
    { GHIDRA_INSTALL_DIR: "/opt/other", JAVA_HOME: "/opt/jdk" },
    { unrecorded: [], differing: ["GHIDRA_INSTALL_DIR"], unresolved: [] },
  ],
])("reports names only for %s", async (_label, env, provider_settings) => {
  expect(await readClaudeCode(env)).toMatchObject({
    client: "claude_code",
    provider_settings,
  });
});

it.each([
  ["a non-string value", { GHIDRA_INSTALL_DIR: 1 }],
  ["a peer setting the runtime parser rejects", { REA_LOG_LEVEL: "shout" }],
])(
  "leaves a malformed map with %s to the invalid registration result",
  async (_label, env) => {
    const status = await readClaudeCode(env);
    expect(status?.state).toBe("invalid");
    expect(status).not.toHaveProperty("provider_settings");
  },
);

it("omits the comparison when the registration records the selection", async () => {
  expect(await readClaudeCode(selected)).not.toHaveProperty(
    "provider_settings",
  );
});

it("keeps recorded values out of the status", async () => {
  const status = await readClaudeCode({
    GHIDRA_INSTALL_DIR: "/recorded/secret-path",
  });
  expect(status?.provider_settings?.differing).toEqual(["GHIDRA_INSTALL_DIR"]);
  expect(JSON.stringify(status)).not.toContain("/recorded/secret-path");
});

it("does not read the comparison for callers that did not ask", async () => {
  const home = await createTestTempDirectory("rea-recorded-settings-off-");
  await writeFile(join(home, ".claude.json"), entry(undefined));
  const [status] = await readClientRegistrationStatuses(
    home,
    CURRENT_ENTRYPOINT_PATH,
    { environment: {} },
  );
  expect(status).not.toHaveProperty("provider_settings");
});

it("retains the comparison on a stale launcher, which setup can still repair", async () => {
  const home = await createTestTempDirectory("rea-recorded-settings-stale-");
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
  const [status] = await readClientRegistrationStatuses(home, "/current/rea", {
    environment: {},
    providerSettings: selected,
  });
  expect(status).toMatchObject({
    state: "stale",
    provider_settings: { unrecorded: ["GHIDRA_INSTALL_DIR", "JAVA_HOME"] },
  });
});

it("reads Codex's environment table", async () => {
  const home = await createTestTempDirectory("rea-recorded-settings-codex-");
  await mkdir(join(home, ".codex"));
  await writeFile(
    join(home, ".codex/config.toml"),
    `[mcp_servers.rea]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(CURRENT_ENTRYPOINT_PATH)}, "mcp"]\nstartup_timeout_sec = 30\ntool_timeout_sec = 3600\n[mcp_servers.rea.env]\nGHIDRA_INSTALL_DIR = "/opt/ghidra"\n`,
  );
  const [status] = await readClientRegistrationStatuses(
    home,
    CURRENT_ENTRYPOINT_PATH,
    { environment: {}, providerSettings: selected },
  );
  expect(status).toMatchObject({
    client: "codex",
    provider_settings: {
      unrecorded: ["JAVA_HOME"],
      differing: [],
      unresolved: [],
    },
  });
});

it("reads OpenCode's differently named environment member", async () => {
  const home = await createTestTempDirectory("rea-recorded-settings-open-");
  await mkdir(join(home, ".config/opencode"), { recursive: true });
  await writeFile(
    join(home, ".config/opencode/opencode.json"),
    JSON.stringify({
      mcp: {
        rea: {
          type: "local",
          command: [process.execPath, CURRENT_ENTRYPOINT_PATH, "mcp"],
          environment: { JAVA_HOME: "/opt/jdk" },
        },
      },
    }),
  );
  const [status] = await readClientRegistrationStatuses(
    home,
    CURRENT_ENTRYPOINT_PATH,
    { environment: {}, providerSettings: selected },
  );
  expect(status).toMatchObject({
    client: "opencode",
    provider_settings: {
      unrecorded: ["GHIDRA_INSTALL_DIR"],
      differing: [],
      unresolved: [],
    },
  });
});

it("reads the effective view of layered OpenCode files", async () => {
  const home = await createTestTempDirectory("rea-recorded-settings-layer-");
  await mkdir(join(home, ".config/opencode"), { recursive: true });
  const layer = (environment: Readonly<Record<string, string>>) =>
    JSON.stringify({
      mcp: {
        rea: {
          type: "local",
          command: [process.execPath, CURRENT_ENTRYPOINT_PATH, "mcp"],
          environment,
        },
      },
    });
  const override = join(home, "override.json");
  await writeFile(
    join(home, ".config/opencode/opencode.json"),
    layer({ JAVA_HOME: "/opt/jdk" }),
  );
  await writeFile(override, layer({ GHIDRA_INSTALL_DIR: "/opt/ghidra" }));
  const statuses = await readClientRegistrationStatuses(
    home,
    CURRENT_ENTRYPOINT_PATH,
    {
      environment: { OPENCODE_CONFIG: override },
      providerSettings: selected,
    },
  );
  expect(
    statuses.find(({ client }) => client === "opencode"),
  ).not.toHaveProperty("provider_settings");
});

it("keeps a Cordis expression unresolved instead of absent or different", async () => {
  const home = await createTestTempDirectory("rea-recorded-settings-dsh-");
  await mkdir(join(home, ".dsh"));
  await writeFile(
    join(home, ".dsh/cordis.patch.yml"),
    `- insert:
    - id: rea-mcp
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: rea
        transport: stdio
        command: ${JSON.stringify(process.execPath)}
        args: [${JSON.stringify(CURRENT_ENTRYPOINT_PATH)}, mcp]
        env:
          GHIDRA_INSTALL_DIR: !!js process.env.GHIDRA_INSTALL_DIR
          JAVA_HOME: /opt/other
`,
  );
  const statuses = await readClientRegistrationStatuses(
    home,
    CURRENT_ENTRYPOINT_PATH,
    { environment: {}, platform: "linux", providerSettings: selected },
  );
  expect(statuses.find((status) => status.client === "dsh")).toMatchObject({
    provider_settings: {
      unrecorded: [],
      differing: ["JAVA_HOME"],
      unresolved: ["GHIDRA_INSTALL_DIR"],
    },
  });
});

it("folds recorded environment names on Windows", () => {
  const servers = {
    rea: { env: { java_home: "/opt/jdk" } },
  };
  const parsed = {
    document: { mcpServers: servers },
    servers,
    serversPath: ["mcpServers"],
    dialect: "json",
    environmentKey: "env",
    legacyServers: {},
  } as const;
  expect(recordedProviderSettings(parsed, undefined, selected, "win32")).toEqual({
    unrecorded: ["GHIDRA_INSTALL_DIR"],
    differing: [],
    unresolved: [],
  });
  expect(recordedProviderSettings(parsed, undefined, selected, "linux")).toEqual({
    unrecorded: ["GHIDRA_INSTALL_DIR", "JAVA_HOME"],
    differing: [],
    unresolved: [],
  });
  expect(recordedProviderSettings(parsed, undefined, {}, "linux")).toBeUndefined();
});

it("does not treat a map it could not read as absent", () => {
  const servers = { rea: { env: { GHIDRA_INSTALL_DIR: 1 } } };
  expect(
    recordedProviderSettings(
      {
        document: { mcpServers: servers },
        servers,
        serversPath: ["mcpServers"],
        dialect: "json",
        environmentKey: "env",
        legacyServers: {},
      },
      undefined,
      selected,
      "linux",
    ),
  ).toEqual({
    unrecorded: [],
    differing: [],
    unresolved: ["GHIDRA_INSTALL_DIR", "JAVA_HOME"],
  });
});
