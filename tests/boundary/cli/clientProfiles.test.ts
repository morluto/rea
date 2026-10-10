import { access, mkdir, readFile, writeFile, rm } from "node:fs/promises";
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
    config: ".config/opencode/opencode.json",
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
      if (testCase.client === "grok_build") {
        const original = await readFile(config, "utf8");
        await writeFile(
          config,
          original.replace(
            "[mcp_servers.rea]",
            "[mcp_servers.rea]\ndisabled = true",
          ),
        );
        expect(
          (await run(["doctor", "--client", "grok_build", "--json"])).exitCode,
        ).toBe(0);
        await writeFile(config, original);
      }
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
    const report = uninstall.json as {
      items?: readonly { name: string; status: string }[];
    };
    const opencodeItems = report.items?.filter(
      ({ name }) => name === "opencode",
    );
    expect(opencodeItems).toEqual([
      expect.objectContaining({ status: "removed" }),
    ]);
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

cliTest(
  "OpenCode doctor sees a global registration when the custom directory is absent",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-opencode-absent-custom-");
    const global = join(home, ".config/opencode/opencode.json");
    const custom = join(home, "missing-custom");
    await mkdir(dirname(global), { recursive: true });
    await writeFile(
      global,
      JSON.stringify({
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
        },
      }),
    );
    const run = (args: readonly string[]) =>
      cli.run({
        arguments: args,
        cwd: home,
        environment: {
          HOME: home,
          USERPROFILE: home,
          OPENCODE_CONFIG_DIR: custom,
        },
      });
    const doctor = await run(["doctor", "--client", "opencode", "--json"]);
    expect(doctor.exitCode).toBe(0);
    expect(doctor.json).toMatchObject({
      identity: {
        registrations: expect.arrayContaining([
          expect.objectContaining({ client: "opencode", state: "aligned" }),
        ]),
      },
    });
    const planned = await run([
      "setup",
      "--client",
      "opencode",
      "--dry-run",
      "--json",
    ]);
    expect(planned.json).toMatchObject({
      clientStates: expect.arrayContaining([
        expect.objectContaining({
          client: expect.objectContaining({ name: "opencode" }),
          detected: true,
        }),
      ]),
    });
    await expect(access(custom)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

cliTest(
  "OpenCode retains the XDG global layer when a custom directory is selected",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-opencode-global-custom-");
    const global = join(home, ".config/opencode/opencode.json");
    const custom = join(home, "custom/opencode.jsonc");
    await mkdir(dirname(global), { recursive: true });
    await mkdir(dirname(custom), { recursive: true });
    const owned = {
      type: "local",
      command: [
        "npx",
        "-y",
        PRODUCT_IDENTITY.registrationPackageSpecifier,
        "mcp",
      ],
      enabled: true,
    };
    const original = JSON.stringify({
      mcp: { rea: owned, other: { type: "local", command: ["other"] } },
    });
    await writeFile(global, original);
    await writeFile(custom, "{}");
    const run = (args: readonly string[]) =>
      cli.run({
        arguments: args,
        cwd: home,
        environment: {
          HOME: home,
          USERPROFILE: home,
          OPENCODE_CONFIG_DIR: dirname(custom),
        },
      });
    const doctor = await run(["doctor", "--client", "opencode", "--json"]);
    expect(doctor.json).toMatchObject({
      identity: {
        registrations: expect.arrayContaining([
          expect.objectContaining({ client: "opencode", state: "aligned" }),
        ]),
      },
    });
    await writeFile(global, "malformed");
    expect(
      (await run(["setup", "--client", "opencode", "--yes", "--json"])).json,
    ).toMatchObject({
      status: "needs_human",
      plannedActions: [],
      appliedActions: [],
      remediation: expect.stringContaining(global),
    });
    expect(await readFile(custom, "utf8")).toBe("{}");
    await writeFile(global, original);
    expect(
      (await run(["setup", "--client", "opencode", "--yes", "--json"]))
        .exitCode,
    ).toBe(0);
    expect((await run(["uninstall", "--json"])).exitCode).toBe(0);
    expect(parse(await readFile(global, "utf8"))).toEqual({
      mcp: { other: { type: "local", command: ["other"] } },
    });
    expect(parse(await readFile(custom, "utf8"))).toEqual({ mcp: {} });
  },
);

cliTest(
  "Gemini blocks a conflicting system definition and accepts an identical managed entry",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-gemini-managed-server-");
    const user = join(home, ".gemini/settings.json");
    const system = join(home, "system.json");
    const defaults = join(home, "defaults.json");
    const environment = {
      HOME: home,
      USERPROFILE: home,
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: system,
      GEMINI_CLI_SYSTEM_DEFAULTS_PATH: defaults,
    };
    const run = (args: readonly string[]) =>
      cli.run({ arguments: args, cwd: home, environment });
    const command = ["setup", "--client", "gemini_cli", "--yes", "--json"];
    // A user registration overrides a default definition, including its entire env object.
    await writeFile(
      defaults,
      JSON.stringify({
        mcpServers: {
          rea: { command: "managed-default", env: { EXTRA: "default" } },
        },
      }),
    );
    expect((await run(command)).exitCode).toBe(0);
    const original = await readFile(user, "utf8");
    const managed = JSON.stringify({
      mcpServers: { rea: { command: "managed-override", args: [] } },
      unrelated: true,
    });
    await writeFile(system, managed);
    expect((await run(command)).json).toMatchObject({
      status: "needs_human",
      plannedActions: [],
      appliedActions: [],
      remediation: expect.stringContaining(system),
    });
    expect(
      (await run(["doctor", "--client", "gemini_cli", "--json"])).json,
    ).toMatchObject({
      healthy: false,
      identity: {
        registrations: expect.arrayContaining([
          expect.objectContaining({
            client: "gemini_cli",
            state: "stale",
            remediation: expect.stringContaining("mcpServers.rea"),
          }),
        ]),
      },
    });
    expect(await readFile(user, "utf8")).toBe(original);
    expect(await readFile(system, "utf8")).toBe(managed);
    const aligned = JSON.stringify({
      mcpServers: JSON.parse(original).mcpServers,
    });
    await writeFile(system, aligned);
    expect((await run(command)).json).toMatchObject({
      status: "ready",
      appliedActions: [],
    });
    expect(
      (await run(["doctor", "--client", "gemini_cli", "--json"])).exitCode,
    ).toBe(0);
    expect(await readFile(system, "utf8")).toBe(aligned);
    await expect(access(system + ".rea.backup")).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

cliTest(
  "Gemini workspace policy follows persisted trust and explicit trust overrides",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-gemini-workspace-policy-");
    const project = join(home, "project");
    const workspace = join(project, ".gemini/settings.json");
    const trust = join(home, "trust.json");
    await mkdir(dirname(workspace), { recursive: true });
    const environment: NodeJS.ProcessEnv = {
      HOME: home,
      USERPROFILE: home,
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: join(home, "system.json"),
      GEMINI_CLI_SYSTEM_DEFAULTS_PATH: join(home, "defaults.json"),
      GEMINI_CLI_TRUSTED_FOLDERS_PATH: trust,
    };
    const run = (args: readonly string[]) =>
      cli.run({ arguments: args, cwd: project, environment });
    const command = ["setup", "--client", "gemini_cli", "--yes", "--json"];
    const original = JSON.stringify({
      mcp: { excluded: ["rea"] },
      unrelated: true,
    });
    await writeFile(workspace, original);
    await writeFile(
      trust,
      JSON.stringify({ [home]: "TRUST_FOLDER", [project]: "DO_NOT_TRUST" }),
    );
    expect((await run(command)).exitCode).toBe(0);
    await writeFile(
      trust,
      JSON.stringify({ [join(project, "child")]: "TRUST_PARENT" }),
    );
    expect((await run(command)).json).toMatchObject({
      status: "needs_human",
      appliedActions: [],
      remediation: expect.stringContaining(workspace),
    });
    expect(
      (await run(["doctor", "--client", "gemini_cli", "--json"])).json,
    ).toMatchObject({
      healthy: false,
      identity: {
        registrations: expect.arrayContaining([
          expect.objectContaining({
            client: "gemini_cli",
            state: "stale",
            remediation: expect.stringContaining("mcp.excluded"),
          }),
        ]),
      },
    });
    environment.GEMINI_CLI_TRUST_WORKSPACE = "false";
    expect((await run(command)).json).toMatchObject({
      status: "ready",
      appliedActions: [],
    });
    environment.GEMINI_CLI_TRUST_WORKSPACE = "true";
    await writeFile(workspace, JSON.stringify({ mcp: { allowed: ["other"] } }));
    expect((await run(command)).json).toMatchObject({
      status: "needs_human",
      remediation: expect.stringContaining("mcp.allowed"),
    });
    // Restricted mode takes precedence over an explicit trust opt-in.
    environment.GEMINI_RESTRICTED_MODE = "true";
    expect((await run(command)).json).toMatchObject({
      status: "ready",
      appliedActions: [],
    });
    expect(JSON.parse(await readFile(workspace, "utf8"))).toEqual({
      mcp: { allowed: ["other"] },
    });
    await expect(access(workspace + ".rea.backup")).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

cliTest(
  "Gemini workspace definitions use shallow precedence and remain read-only",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-gemini-workspace-server-");
    const project = join(home, "project");
    const workspace = join(project, ".gemini/settings.json");
    const system = join(home, "system.json");
    await mkdir(dirname(workspace), { recursive: true });
    const environment: NodeJS.ProcessEnv = {
      HOME: home,
      USERPROFILE: home,
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: system,
      GEMINI_CLI_SYSTEM_DEFAULTS_PATH: join(home, "defaults.json"),
      GEMINI_CLI_TRUST_WORKSPACE: "true",
    };
    const run = (args: readonly string[]) =>
      cli.run({ arguments: args, cwd: project, environment });
    const command = ["setup", "--client", "gemini_cli", "--yes", "--json"];
    const original = JSON.stringify({
      mcpServers: { rea: { command: "project-server", args: [] } },
    });
    await writeFile(workspace, original);
    expect((await run(command)).json).toMatchObject({
      status: "needs_human",
      plannedActions: [],
      appliedActions: [],
      remediation: expect.stringContaining(workspace),
    });
    await expect(
      access(join(home, ".gemini/settings.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    // Obtain this setup invocation's actual command while workspace settings are untrusted.
    environment.GEMINI_CLI_TRUST_WORKSPACE = "false";
    expect((await run(command)).exitCode).toBe(0);
    const user = JSON.parse(
      await readFile(join(home, ".gemini/settings.json"), "utf8"),
    );
    environment.GEMINI_CLI_TRUST_WORKSPACE = "true";
    // System's entire entry wins over the workspace entry.
    await writeFile(system, JSON.stringify({ mcpServers: user.mcpServers }));
    expect((await run(command)).exitCode).toBe(0);
    expect(
      (await run(["doctor", "--client", "gemini_cli", "--json"])).exitCode,
    ).toBe(0);
    expect(await readFile(workspace, "utf8")).toBe(original);
    await expect(access(workspace + ".rea.backup")).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

cliTest(
  "Gemini validates trust configuration and honors a disabled folder trust feature",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-gemini-trust-invalid-");
    const project = join(home, "project");
    const workspace = join(project, ".gemini/settings.json");
    const user = join(home, ".gemini/settings.json");
    const trust = join(home, ".gemini/trustedFolders.json");
    await mkdir(dirname(workspace), { recursive: true });
    await mkdir(dirname(user), { recursive: true });
    await writeFile(workspace, JSON.stringify({ mcp: { excluded: ["rea"] } }));
    await writeFile(trust, JSON.stringify({ [project]: "INVALID" }));
    const run = () =>
      cli.run({
        arguments: ["setup", "--client", "gemini_cli", "--yes", "--json"],
        cwd: project,
        environment: {
          HOME: home,
          USERPROFILE: home,
          GEMINI_CLI_SYSTEM_SETTINGS_PATH: join(home, "system.json"),
          GEMINI_CLI_SYSTEM_DEFAULTS_PATH: join(home, "defaults.json"),
        },
      });
    expect((await run()).json).toMatchObject({
      status: "needs_human",
      plannedActions: [],
      appliedActions: [],
      remediation: expect.stringContaining(trust),
    });
    await expect(access(user)).rejects.toMatchObject({ code: "ENOENT" });
    await rm(trust);
    await writeFile(
      user,
      JSON.stringify({ security: { folderTrust: { enabled: false } } }),
    );
    expect((await run()).json).toMatchObject({
      status: "needs_human",
      remediation: expect.stringContaining("mcp.excluded"),
    });
  },
);
