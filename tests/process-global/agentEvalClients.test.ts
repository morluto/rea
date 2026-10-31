import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import {
  agentEvalEnvironment,
  preflightClientEnvironment,
  prepareAgentEvalClient,
  selectAgentEvalClient,
} from "../../scripts/lib/agent-eval-clients.mjs";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { TOOL_CONTRACTS } from "../../src/contracts/toolContracts.js";

afterEach(() => vi.unstubAllEnvs());

it("resolves path-like client overrides from the repository root", () => {
  const root = "/repo/rea";
  vi.stubEnv(
    "REA_VERIFY_GEMINI_COMMAND",
    "./node_modules/@google/gemini-cli/bundle/gemini.js",
  );
  expect(selectAgentEvalClient("gemini-cli", root).command).toBe(
    resolve(root, "./node_modules/@google/gemini-cli/bundle/gemini.js"),
  );
  vi.stubEnv("REA_VERIFY_GEMINI_COMMAND", "gemini");
  expect(selectAgentEvalClient("gemini-cli", root).command).toBe("gemini");
});

it.each([
  {
    id: "gemini-cli",
    variable: "REA_VERIFY_GEMINI_COMMAND",
    entry: "bundle/gemini.js",
  },
  {
    id: "claude-code",
    variable: "REA_VERIFY_CLAUDE_COMMAND",
    entry: "./cli.mjs",
  },
])(
  "$id runs a selected JavaScript entry point under this Node",
  ({ id, variable, entry }) => {
    const root = "/repo/rea";
    vi.stubEnv(variable, entry);
    const client = selectAgentEvalClient(id, root);
    const selected = resolve(root, entry);
    expect(client.command).toBe(selected);
    // Preflight and scenarios take the same launch; the selected entry is kept.
    expect(client.launch(["--version"])).toEqual({
      command: process.execPath,
      arguments: [selected, "--version"],
    });
    vi.stubEnv(variable, "gemini");
    expect(selectAgentEvalClient(id, root).launch(["--version"])).toEqual({
      command: "gemini",
      arguments: ["--version"],
    });
    // A bare entry name is resolved once against the repository root too, so
    // the preflight (run from there) and the scenarios (run from the
    // evaluation root) launch the same file.
    vi.stubEnv(variable, "gemini.js");
    const bare = selectAgentEvalClient(id, root);
    expect(bare.command).toBe(resolve(root, "gemini.js"));
    expect(bare.launch(["--version"])).toEqual({
      command: process.execPath,
      arguments: [resolve(root, "gemini.js"), "--version"],
    });
  },
);

it("permits REA tools from their audited effects, not from advertised hints", async () => {
  const root = await createTestTempDirectory("rea-agent-client-effects-");
  vi.stubEnv("CLAUDE_CONFIG_DIR", join(root, "caller"));
  const client = await prepareAgentEvalClient(
    selectAgentEvalClient("claude-code"),
    {
      evaluationRoot: root,
      account: join(root, "account"),
      authPaths: [],
    },
  );
  const args = await client.arguments("prompt", []);
  const settingsValue = args[args.indexOf("--settings") + 1];
  if (settingsValue === undefined)
    throw new Error("Claude settings argument is missing");
  const allowed = new Set<string>(JSON.parse(settingsValue).permissions.allow);
  const refused = TOOL_CONTRACTS.filter(
    ({ effects }) =>
      effects.executesForeignCode ||
      effects.mutatesDevice ||
      effects.mayDiscardData ||
      effects.launchesProcess ||
      effects.accessesNetwork,
  );
  const permitted = TOOL_CONTRACTS.filter(
    (contract) => !refused.includes(contract),
  );
  expect(refused.length).toBeGreaterThan(0);
  expect(permitted.length).toBeGreaterThan(0);
  for (const { name } of refused)
    expect(allowed).not.toContain(`mcp__rea__${name}`);
  for (const { name } of permitted)
    expect(allowed).toContain(`mcp__rea__${name}`);
  // Session-mutating Evidence tools stay permitted; only the audited effects above refuse.
  expect(allowed).toContain("mcp__rea__inspect_analysis_settings");
  expect(allowed).not.toContain("mcp__rea__capture_process_scenario");
});

it("forwards Claude's gateway auth token only to the Claude client", async () => {
  const root = await createTestTempDirectory("rea-agent-client-token-");
  vi.stubEnv("CODEX_HOME", join(root, "caller"));
  vi.stubEnv("CLAUDE_CONFIG_DIR", join(root, "caller"));
  vi.stubEnv("GEMINI_CLI_HOME", join(root, "caller"));
  vi.stubEnv("ANTHROPIC_API_KEY", undefined);
  vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "gateway-token");
  vi.stubEnv("ANTHROPIC_BASE_URL", "https://claude-gateway.invalid/custom");
  for (const id of ["claude-code", "gemini-cli", "codex"] as const) {
    await mkdir(join(root, id, "run"), { recursive: true });
    const client = await prepareAgentEvalClient(selectAgentEvalClient(id), {
      evaluationRoot: join(root, id, "run"),
      account: join(root, id, "account"),
      authPaths: [],
    });
    const environment = agentEvalEnvironment({
      account: join(root, id, "account"),
      runId: "test",
      client,
    });
    if (id === "claude-code") {
      expect(environment).toHaveProperty(
        "ANTHROPIC_AUTH_TOKEN",
        "gateway-token",
      );
      expect(environment).not.toHaveProperty("ANTHROPIC_API_KEY");
    } else expect(environment).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
  }
});

it.each(["claude-code", "gemini-cli"])(
  "%s receives selected authentication and scenario-specific permissions",
  async (id) => {
    const root = await createTestTempDirectory("rea-agent-client-policy-");
    const caller = join(root, "caller");
    await mkdir(join(caller, ".gemini"), { recursive: true });
    await writeFile(
      join(caller, ".gemini", "settings.json"),
      `\uFEFF${JSON.stringify({
        security: { auth: { selectedType: "gemini-api-key" } },
      })}`,
    );
    vi.stubEnv("CLAUDE_CONFIG_DIR", caller);
    vi.stubEnv("GEMINI_CLI_HOME", caller);
    vi.stubEnv("ANTHROPIC_API_KEY", "selected-claude-key");
    vi.stubEnv("GEMINI_API_KEY", "selected-gemini-key");
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://claude-gateway.invalid/custom");
    vi.stubEnv(
      "GOOGLE_GEMINI_BASE_URL",
      "https://gemini-gateway.invalid/custom",
    );
    vi.stubEnv("OPENAI_API_KEY", "foreign-openai-key");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "foreign-aws-key");
    const client = await prepareAgentEvalClient(selectAgentEvalClient(id), {
      evaluationRoot: root,
      account: join(root, "account"),
      authPaths: [],
    });
    const environment = agentEvalEnvironment({
      account: join(root, "account"),
      runId: "test",
      client,
    });
    expect(environment).not.toHaveProperty("OPENAI_API_KEY");
    expect(environment).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(environment).toHaveProperty(
      id === "claude-code" ? "ANTHROPIC_API_KEY" : "GEMINI_API_KEY",
    );
    expect(environment).not.toHaveProperty(
      id === "claude-code" ? "GEMINI_API_KEY" : "ANTHROPIC_API_KEY",
    );
    expect(environment).toHaveProperty(
      id === "claude-code" ? "ANTHROPIC_BASE_URL" : "GOOGLE_GEMINI_BASE_URL",
      id === "claude-code"
        ? "https://claude-gateway.invalid/custom"
        : "https://gemini-gateway.invalid/custom",
    );
    expect(environment).not.toHaveProperty(
      id === "claude-code" ? "GOOGLE_GEMINI_BASE_URL" : "ANTHROPIC_BASE_URL",
    );
    const permissions = async (approved: string[]) => {
      const args = await client.arguments("prompt", approved);
      if (id === "claude-code") {
        expect(args[args.indexOf("--tools") + 1]).toContain(
          "WaitForMcpServers",
        );
        const settingsValue = args[args.indexOf("--settings") + 1];
        if (settingsValue === undefined)
          throw new Error("Claude settings argument is missing");
        const settings = JSON.parse(settingsValue);
        expect(settings.permissions.allow).toContain("WaitForMcpServers");
        return settings.permissions.allow.join("\n");
      }
      const policyPath = args[args.indexOf("--policy") + 1];
      if (policyPath === undefined)
        throw new Error("Gemini policy argument is missing");
      return readFile(policyPath, "utf8");
    };
    const browser = await permissions(["list_browser_targets"]);
    expect(browser).toContain("list_browser_targets");
    expect(browser).not.toContain("capture_process_scenario");
    const ordinary = await permissions([]);
    expect(ordinary).not.toContain("list_browser_targets");
    expect(ordinary).not.toContain("capture_process_scenario");
    const preflight = agentEvalEnvironment({
      account: join(root, "account"),
      runId: "test",
      client: { environment: {} },
    });
    for (const key of [
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "GEMINI_API_KEY",
      "AWS_SECRET_ACCESS_KEY",
    ])
      expect(preflight).not.toHaveProperty(key);
  },
);

it.each(["explicit", "empty"])(
  "keeps Gemini's selected keychain authentication with %s home instead of copying stale OAuth",
  async (override) => {
    const root = await createTestTempDirectory("rea-agent-gemini-auth-");
    const caller = join(root, "caller");
    await mkdir(join(caller, ".gemini"), { recursive: true });
    await writeFile(
      join(caller, ".gemini", "settings.json"),
      JSON.stringify({
        security: { auth: { selectedType: "gemini-api-key" } },
      }),
    );
    await writeFile(
      join(caller, ".gemini", "oauth_creds.json"),
      "stale-oauth-fixture",
    );
    vi.stubEnv("HOME", caller);
    vi.stubEnv("USERPROFILE", caller);
    vi.stubEnv("GEMINI_CLI_HOME", override === "empty" ? "" : caller);
    vi.stubEnv("GEMINI_API_KEY", undefined);
    const authPaths: string[] = [];
    await prepareAgentEvalClient(selectAgentEvalClient("gemini-cli"), {
      evaluationRoot: root,
      account: join(root, "account"),
      authPaths,
    });
    expect(authPaths).toEqual([]);
    expect(
      JSON.parse(
        await readFile(
          join(root, "gemini-cli", ".gemini", "settings.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({ security: { auth: { selectedType: "gemini-api-key" } } });
  },
);

it("publishes credential cleanup ownership before a failed copy rejects preparation", async () => {
  const root = await createTestTempDirectory("rea-agent-auth-ownership-");
  const caller = join(root, "caller");
  await mkdir(join(caller, "auth.json"), { recursive: true });
  vi.stubEnv("CODEX_HOME", caller);
  const authPaths: string[] = [];
  await expect(
    prepareAgentEvalClient(selectAgentEvalClient("codex"), {
      evaluationRoot: root,
      account: join(root, "account"),
      authPaths,
    }),
  ).rejects.toThrow();
  expect(authPaths).toEqual([join(root, "codex", "auth.json")]);
});

it.each([undefined, ""])(
  "reuses selected Gemini OAuth when its API key is %j",
  async (key) => {
    const root = await createTestTempDirectory("rea-agent-gemini-empty-key-");
    const caller = join(root, "caller");
    await mkdir(join(caller, ".gemini"), { recursive: true });
    await writeFile(
      join(caller, ".gemini", "settings.json"),
      JSON.stringify({
        security: { auth: { selectedType: "oauth-personal" } },
      }),
    );
    await writeFile(
      join(caller, ".gemini", "oauth_creds.json"),
      "fixture-oauth",
    );
    vi.stubEnv("GEMINI_CLI_HOME", caller);
    vi.stubEnv("GEMINI_API_KEY", key);
    const authPaths: string[] = [];
    const prepared = await prepareAgentEvalClient(
      selectAgentEvalClient("gemini-cli"),
      { evaluationRoot: root, account: join(root, "account"), authPaths },
    );
    const copy = join(root, "gemini-cli", ".gemini", "oauth_creds.json");
    expect(authPaths).toEqual([copy]);
    expect(await readFile(copy, "utf8")).toBe("fixture-oauth");
    expect(prepared.environment).not.toHaveProperty("GEMINI_API_KEY");
    expect(
      JSON.parse(
        await readFile(
          join(root, "gemini-cli", ".gemini", "settings.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({ security: { auth: { selectedType: "oauth-personal" } } });
  },
);

it.each([
  { id: "codex", file: "codex/auth.json" },
  { id: "claude-code", file: "claude-code/.credentials.json" },
  { id: "gemini-cli", file: "gemini-cli/.gemini/oauth_creds.json" },
])(
  "$id names its credential destination before preparation",
  ({ id, file }) => {
    expect(selectAgentEvalClient(id).credentialPaths("/run")).toEqual([
      join("/run", file),
    ]);
  },
);

it.each([undefined, ""])(
  "copies Claude's account credentials from the home directory when the override is %j",
  async (override) => {
    const root = await createTestTempDirectory("rea-agent-claude-home-");
    const caller = join(root, "caller");
    await mkdir(join(caller, ".claude"), { recursive: true });
    await writeFile(
      join(caller, ".claude", ".credentials.json"),
      "fixture-claude",
    );
    vi.stubEnv("HOME", caller);
    vi.stubEnv("USERPROFILE", caller);
    vi.stubEnv("CLAUDE_CONFIG_DIR", override);
    const authPaths: string[] = [];
    await prepareAgentEvalClient(selectAgentEvalClient("claude-code"), {
      evaluationRoot: root,
      account: join(root, "account"),
      authPaths,
    });
    const copy = join(root, "claude-code", ".credentials.json");
    expect(authPaths).toEqual([copy]);
    expect(await readFile(copy, "utf8")).toBe("fixture-claude");
  },
);

it("gives the version preflight the client's containment controls without authentication", () => {
  vi.stubEnv("ANTHROPIC_API_KEY", "selected-claude-key");
  vi.stubEnv("GEMINI_API_KEY", "selected-gemini-key");
  const preflight = (id: string) =>
    agentEvalEnvironment({
      account: "/run/account",
      runId: "test",
      client: {
        environment: preflightClientEnvironment(selectAgentEvalClient(id)),
      },
    });
  expect(preflight("claude-code")).toMatchObject({
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  });
  expect(preflight("gemini-cli")).toMatchObject({
    GEMINI_CLI_NO_RELAUNCH: "1",
  });
  for (const id of ["codex", "claude-code", "gemini-cli"])
    for (const key of [
      "ANTHROPIC_API_KEY",
      "GEMINI_API_KEY",
      "CLAUDE_CONFIG_DIR",
      "GEMINI_CLI_HOME",
      "CODEX_HOME",
    ])
      expect(preflight(id)).not.toHaveProperty(key);
});

it("accepts an empty Gemini settings placeholder like REA's own setup does", async () => {
  const root = await createTestTempDirectory(
    "rea-agent-gemini-empty-settings-",
  );
  const caller = join(root, "caller");
  await mkdir(join(caller, ".gemini"), { recursive: true });
  await writeFile(join(caller, ".gemini", "settings.json"), "");
  await writeFile(join(caller, ".gemini", "oauth_creds.json"), "fixture-oauth");
  vi.stubEnv("GEMINI_CLI_HOME", caller);
  vi.stubEnv("GEMINI_API_KEY", undefined);
  const authPaths: string[] = [];
  await prepareAgentEvalClient(selectAgentEvalClient("gemini-cli"), {
    evaluationRoot: root,
    account: join(root, "account"),
    authPaths,
  });
  const copy = join(root, "gemini-cli", ".gemini", "oauth_creds.json");
  expect(authPaths).toEqual([copy]);
  expect(await readFile(copy, "utf8")).toBe("fixture-oauth");
  expect(
    JSON.parse(
      await readFile(
        join(root, "gemini-cli", ".gemini", "settings.json"),
        "utf8",
      ),
    ),
  ).toMatchObject({ security: { auth: { selectedType: "oauth-personal" } } });
});

it("forwards the Codex gateway endpoint with its credentials only", async () => {
  const root = await createTestTempDirectory("rea-agent-codex-endpoint-");
  vi.stubEnv("CODEX_HOME", join(root, "caller"));
  vi.stubEnv("OPENAI_API_KEY", "selected-openai-key");
  vi.stubEnv("OPENAI_BASE_URL", "https://openai-gateway.invalid/v1");
  vi.stubEnv("ANTHROPIC_BASE_URL", "https://claude-gateway.invalid/custom");
  const client = await prepareAgentEvalClient(selectAgentEvalClient("codex"), {
    evaluationRoot: root,
    account: join(root, "account"),
    authPaths: [],
  });
  const environment = agentEvalEnvironment({
    account: join(root, "account"),
    runId: "test",
    client,
  });
  expect(environment).toMatchObject({
    OPENAI_API_KEY: "selected-openai-key",
    OPENAI_BASE_URL: "https://openai-gateway.invalid/v1",
  });
  expect(environment).not.toHaveProperty("ANTHROPIC_BASE_URL");
});
