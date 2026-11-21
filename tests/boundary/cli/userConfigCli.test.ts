import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "reports persisted setting origins and keeps startup recovery actionable",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-user-config-cli-");
    const xdg = join(home, ".config");
    const config = join(xdg, "rea", "rea.json");
    const saved = join(home, "java-saved");
    const override = join(home, "java-env");
    const environment = {
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: xdg,
      JAVA_HOME: undefined,
      HOPPER_LAUNCHER_PATH: undefined,
    };
    const run = (
      arguments_: readonly string[],
      env = environment as NodeJS.ProcessEnv,
    ) =>
      cli.run({
        arguments: arguments_,
        cwd: home,
        environment: env,
        freshProcess: true,
      });

    const set = await run(["config", "--set", `JAVA_HOME=${saved}`, "--json"]);
    expect(set.exitCode, [set.stdout, set.stderr].join("\n")).toBe(0);
    const get = ["config", "--get", "JAVA_HOME", "--json"];
    expect((await run(get)).json).toMatchObject({
      value: saved,
      source: "config",
    });
    expect(
      (await run(get, { ...environment, JAVA_HOME: override })).json,
    ).toMatchObject({
      value: override,
      source: "env",
    });

    if (process.platform === "darwin" || process.platform === "linux") {
      const hopper = await run([
        "config",
        "--get",
        "HOPPER_LAUNCHER_PATH",
        "--json",
      ]);
      expect(hopper.json).toMatchObject({
        source: "auto-detect",
        value: expect.stringMatching(/[/]hopper$/iu),
      });
    }
    await mkdir(dirname(config), { recursive: true });
    await writeFile(config, "{ broken");
    const version = await run(["--version", "--json"]);
    expect(version.exitCode, version.stderr).toBe(0);
    const doctor = await run(["doctor", "--json"]);
    expect(doctor.exitCode).toBe(1);
    expect(doctor.json).toMatchObject({
      ok: false,
      error: {
        code: "CONFIGURATION_INVALID",
        message: expect.stringContaining("must be valid JSON"),
      },
    });
    const mcp = await run(["mcp"]);
    expect(mcp.exitCode).toBe(1);
    expect(mcp.stderr).toContain(config);
    expect(mcp.stderr).toContain("must be valid JSON");
    expect(await readFile(config, "utf8")).toBe("{ broken");
  },
);

cliTest(
  "setup leaves shared defaults live and preserves client overrides",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-user-config-setup-");
    const config = join(home, ".cursor", "mcp.json");
    const firstDefault = join(home, "first-ida.json");
    const secondDefault = join(home, "second-ida.json");
    const clientOverride = join(home, "cursor-ida.json");
    const environment: NodeJS.ProcessEnv = {
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, "xdg"),
      CURSOR_CONFIG_DIR: undefined,
      REA_IDA_MCP_CONFIG: undefined,
    };
    const run = (arguments_: readonly string[], env = environment) =>
      cli.run({
        arguments: arguments_,
        cwd: home,
        environment: env,
        freshProcess: true,
      });
    const save = async (path: string) => {
      const result = await run([
        "config",
        "--set",
        `REA_IDA_MCP_CONFIG=${path}`,
        "--json",
      ]);
      expect(result.exitCode, result.stderr).toBe(0);
    };
    const setup = async (env = environment) => {
      const result = await run(
        ["setup", "--client", "cursor", "--skill=false", "--yes", "--json"],
        env,
      );
      expect(result.json, result.stderr).toMatchObject({ status: "ready" });
      return JSON.parse(await readFile(config, "utf8"));
    };

    await save(firstDefault);
    const initial = await setup();
    expect(initial.mcpServers.rea.env ?? {}).not.toHaveProperty(
      "REA_IDA_MCP_CONFIG",
    );

    await save(secondDefault);
    expect(
      (await run(["config", "--get", "REA_IDA_MCP_CONFIG", "--json"])).json,
    ).toMatchObject({ value: secondDefault, source: "config" });
    expect((await setup()).mcpServers.rea.env ?? {}).not.toHaveProperty(
      "REA_IDA_MCP_CONFIG",
    );

    expect(
      (await setup({ ...environment, REA_IDA_MCP_CONFIG: clientOverride }))
        .mcpServers.rea.env,
    ).toMatchObject({ REA_IDA_MCP_CONFIG: clientOverride });
    expect((await setup()).mcpServers.rea.env).toMatchObject({
      REA_IDA_MCP_CONFIG: clientOverride,
    });
  },
);
