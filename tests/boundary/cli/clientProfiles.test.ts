import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect } from "vitest";
import { parse } from "jsonc-parser";
import { PRODUCT_IDENTITY } from "../../../src/identity.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const cases = [
  {
    client: "gemini_cli",
    env: { GEMINI_CLI_HOME: "profile" },
    config: "profile/.gemini/settings.json",
    skill: "profile/.agents/skills",
  },
  {
    client: "opencode",
    env: { OPENCODE_CONFIG_DIR: "profile" },
    config: "profile/opencode.json",
    skill: ".agents/skills",
  },
  {
    client: "opencode",
    env: { OPENCODE_CONFIG_DIR: "" },
    config: "opencode.json",
    skill: ".agents/skills",
  },
  {
    client: "codex",
    env: { CODEX_HOME: "" },
    config: ".codex/config.toml",
    skill: ".agents/skills",
  },
  {
    client: "grok_build",
    env: { GROK_HOME: "" },
    config: ".grok/config.toml",
    skill: ".agents/skills",
  },
  {
    client: "omp",
    env: { PI_CODING_AGENT_DIR: "profile" },
    config: "profile/mcp.json",
    skill: ".agents/skills",
  },
  {
    client: "devin",
    env: { XDG_CONFIG_HOME: "profile" },
    config: "profile/devin/mcp_config.json",
    skill: ".agents/skills",
  },
  {
    client: "antigravity",
    env: {},
    config: ".gemini/config/mcp_config.json",
    skill: ".gemini/config/skills",
  },
];
for (const testCase of cases.filter(
  ({ client }) => process.platform !== "win32" || client !== "devin",
)) {
  cliTest(
    `${testCase.client} lifecycle follows the selected roots (${testCase.config})`,
    async ({ cli }) => {
      const home = await createTestTempDirectory("rea-client-profile-");
      const environment: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home };
      for (const [key, value] of Object.entries(testCase.env))
        environment[key] = value === "profile" ? join(home, value) : value;
      // OMP's relative override is relative to the caller, not silently ignored.
      if (testCase.client === "omp")
        environment.PI_CODING_AGENT_DIR = "profile";
      const config = join(home, testCase.config);
      const skillDirectory = join(
        home,
        testCase.skill,
        "reverse-engineer-anything",
      );
      const run = (arguments_: readonly string[]) =>
        cli.run({
          arguments: arguments_,
          cwd: home,
          environment,
          timeoutMs: 20_000,
        });
      const planned = await run([
        "setup",
        "--client",
        testCase.client,
        "--dry-run",
        "--json",
      ]);
      expect(planned.exitCode).toBe(0);
      expect(planned.json).toMatchObject({
        status: "planned",
        plannedActions: expect.arrayContaining([
          expect.objectContaining({ target: config }),
          expect.objectContaining({ target: skillDirectory }),
        ]),
      });
      await expect(access(config)).rejects.toMatchObject({ code: "ENOENT" });
      const setup = await run([
        "setup",
        "--client",
        testCase.client,
        "--yes",
        "--json",
      ]);
      expect(setup.exitCode).toBe(0);
      expect(setup.json).toMatchObject({ status: "ready" });
      await expect(access(config)).resolves.toBeUndefined();
      expect(
        await readFile(join(skillDirectory, "SKILL.md"), "utf8"),
      ).toContain("reverse-engineer-anything");
      await expect(access(join(home, "config.toml"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      const doctor = await run([
        "doctor",
        "--client",
        testCase.client,
        "--skill",
        "--json",
      ]);
      expect(doctor.exitCode).toBe(0);
      expect(doctor.json).toMatchObject({
        healthy: true,
        identity: { skill: { state: "aligned" } },
      });
      const repeat = await run([
        "setup",
        "--client",
        testCase.client,
        "--yes",
        "--json",
      ]);
      expect(repeat.json).toMatchObject({
        status: "ready",
        appliedActions: [],
      });
      const uninstall = await run(["uninstall", "--json"]);
      expect(uninstall.exitCode).toBe(0);
      expect(uninstall.json).toMatchObject({ status: "complete" });
      await expect(
        access(join(skillDirectory, "SKILL.md")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
}

for (const policy of [{ excluded: ["rea"] }, { allowed: ["other"] }]) {
  cliTest(
    `Gemini refuses a registration blocked by ${Object.keys(policy)[0]}`,
    async ({ cli }) => {
      const home = await createTestTempDirectory("rea-gemini-policy-");
      const config = join(home, ".gemini/settings.json");
      const original = JSON.stringify({
        mcp: policy,
        mcpServers: {
          rea: {
            command: "npx",
            args: ["-y", PRODUCT_IDENTITY.registrationPackageSpecifier, "mcp"],
          },
        },
      });
      await mkdir(dirname(config), { recursive: true });
      await writeFile(config, original);
      const run = (arguments_: readonly string[]) =>
        cli.run({
          arguments: arguments_,
          cwd: home,
          environment: { HOME: home, USERPROFILE: home },
          timeoutMs: 20_000,
        });
      const setup = await run([
        "setup",
        "--client",
        "gemini_cli",
        "--yes",
        "--json",
      ]);
      expect(setup.exitCode).toBe(1);
      expect(setup.json).toMatchObject({
        status: "needs_human",
        plannedActions: [],
        appliedActions: [],
        remediation: expect.stringContaining("mcp." + Object.keys(policy)[0]),
      });
      expect(await readFile(config, "utf8")).toBe(original);
      await expect(access(config + ".rea.backup")).rejects.toMatchObject({
        code: "ENOENT",
      });
      const doctor = await run(["doctor", "--client", "gemini_cli", "--json"]);
      expect(doctor.exitCode).toBe(1);
      expect(doctor.json).toMatchObject({
        healthy: false,
        identity: {
          registrations: expect.arrayContaining([
            expect.objectContaining({
              client: "gemini_cli",
              state: "stale",
              remediation: expect.stringContaining("mcp."),
            }),
          ]),
        },
      });
    },
  );
}

cliTest(
  "OpenCode diagnoses merged JSON/JSONC and removes owned entries from both files",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-opencode-layers-");
    const directory = join(home, ".config/opencode");
    await mkdir(directory, { recursive: true });
    const lower = join(directory, "opencode.json");
    const higher = join(directory, "opencode.jsonc");
    const originalLower = JSON.stringify({
      mcp: {
        rea: {
          type: "local",
          command: [
            "npx",
            "-y",
            PRODUCT_IDENTITY.registrationPackageSpecifier,
            "mcp",
          ],
          enabled: true,
        },
        other: { type: "local", command: ["other"] },
      },
    });
    const originalHigher =
      '// keep this comment\n{"mcp":{"rea":{"enabled":false}},"theme":"system"}\n';
    await writeFile(lower, originalLower);
    await writeFile(higher, originalHigher);
    const run = (arguments_: readonly string[]) =>
      cli.run({
        arguments: arguments_,
        cwd: home,
        environment: { HOME: home, USERPROFILE: home },
        timeoutMs: 20_000,
      });
    const before = await run(["doctor", "--client", "opencode", "--json"]);
    expect(before.exitCode).toBe(1);
    expect(before.json).toMatchObject({
      identity: {
        registrations: expect.arrayContaining([
          expect.objectContaining({ client: "opencode", state: "stale" }),
        ]),
      },
    });
    const setup = await run([
      "setup",
      "--client",
      "opencode",
      "--yes",
      "--json",
    ]);
    expect(setup.exitCode).toBe(0);
    expect(setup.json).toMatchObject({ status: "ready" });
    expect(await readFile(lower, "utf8")).toBe(originalLower);
    expect(await readFile(higher + ".rea.backup", "utf8")).toBe(originalHigher);
    expect(await readFile(higher, "utf8")).toContain("// keep this comment");
    expect(
      (await run(["doctor", "--client", "opencode", "--json"])).exitCode,
    ).toBe(0);
    const uninstall = await run(["uninstall", "--json"]);
    expect(uninstall.exitCode).toBe(0);
    expect(parse(await readFile(lower, "utf8"))).toEqual({
      mcp: { other: { type: "local", command: ["other"] } },
    });
    expect(parse(await readFile(higher, "utf8"))).toEqual({
      mcp: {},
      theme: "system",
    });
  },
);

cliTest(
  "malformed lower-priority OpenCode config blocks setup before any writes",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-opencode-invalid-layer-");
    const directory = join(home, ".config/opencode");
    await mkdir(directory, { recursive: true });
    const lower = join(directory, "opencode.json");
    const higher = join(directory, "opencode.jsonc");
    await writeFile(lower, "malformed");
    await writeFile(higher, "{}");
    const result = await cli.run({
      arguments: ["setup", "--client", "opencode", "--yes", "--json"],
      cwd: home,
      environment: { HOME: home, USERPROFILE: home },
    });
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      status: "needs_human",
      plannedActions: [],
      appliedActions: [],
    });
    expect(await readFile(lower, "utf8")).toBe("malformed");
    expect(await readFile(higher, "utf8")).toBe("{}");
    await expect(access(higher + ".rea.backup")).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

cliTest(
  "Gemini system policy blocks a new registration without modifying managed files",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-gemini-managed-");
    const policy = join(home, "managed.json");
    const original = JSON.stringify({
      mcp: { excluded: ["rea"] },
      unrelated: true,
    });
    await writeFile(policy, original);
    const environment = {
      HOME: home,
      USERPROFILE: home,
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: policy,
      GEMINI_CLI_SYSTEM_DEFAULTS_PATH: join(home, "defaults.json"),
    };
    const setup = await cli.run({
      arguments: ["setup", "--client", "gemini_cli", "--yes", "--json"],
      cwd: home,
      environment,
    });
    expect(setup.exitCode).toBe(1);
    expect(setup.json).toMatchObject({
      status: "needs_human",
      plannedActions: [],
      appliedActions: [],
      remediation: expect.stringContaining("mcp.excluded"),
    });
    expect(await readFile(policy, "utf8")).toBe(original);
    await expect(
      access(join(home, ".gemini/settings.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(policy + ".rea.backup")).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

cliTest(
  "Gemini intersects system/default/user allowlists and accepts an empty effective allowlist",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-gemini-allowlists-");
    const system = join(home, "system.json");
    const defaults = join(home, "defaults.json");
    const user = join(home, ".gemini/settings.json");
    await mkdir(dirname(user), { recursive: true });
    await writeFile(
      system,
      JSON.stringify({ mcp: { allowed: ["rea", "other"] } }),
    );
    await writeFile(defaults, JSON.stringify({ mcp: { allowed: ["other"] } }));
    await writeFile(
      user,
      JSON.stringify({ mcp: { allowed: ["rea", "other"] } }),
    );
    const environment = {
      HOME: home,
      USERPROFILE: home,
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: system,
      GEMINI_CLI_SYSTEM_DEFAULTS_PATH: defaults,
    };
    const run = () =>
      cli.run({
        arguments: ["setup", "--client", "gemini_cli", "--yes", "--json"],
        cwd: home,
        environment,
      });
    const blocked = await run();
    expect(blocked.exitCode).toBe(1);
    expect(blocked.json).toMatchObject({
      status: "needs_human",
      appliedActions: [],
    });
    await writeFile(defaults, JSON.stringify({ mcp: { allowed: ["rea"] } }));
    const allowed = await run();
    expect(allowed.exitCode).toBe(0);
    expect(allowed.json).toMatchObject({ status: "ready" });
    expect(JSON.parse(await readFile(defaults, "utf8"))).toEqual({
      mcp: { allowed: ["rea"] },
    });
    // The consumer treats an empty consolidated allowlist as unrestricted.
    await writeFile(defaults, JSON.stringify({ mcp: { allowed: [] } }));
    const empty = await run();
    expect(empty.exitCode).toBe(0);
    expect(empty.json).toMatchObject({ status: "ready", appliedActions: [] });
  },
);
