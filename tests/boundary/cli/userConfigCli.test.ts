import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
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

cliTest(
  "doctor resolves selected client settings from the same file as MCP startup",
  async ({ cli, processes }) => {
    const home = await createTestTempDirectory("rea-client-settings-origin-");
    const terminalConfigHome = join(home, "terminal-config");
    const clientConfigHome = join(home, "client-config");
    const clientConfig = join(clientConfigHome, "rea", "rea.json");
    const codexHome = join(home, ".codex");
    const codexConfig = join(codexHome, "config.toml");
    const terminalIda = join(home, "terminal-ida.json");
    const clientIda = join(home, "client-ida.json");
    const explicitIda = join(home, "explicit-ida.json");
    const environment: NodeJS.ProcessEnv = {
      HOME: home,
      USERPROFILE: home,
      CODEX_HOME: codexHome,
      XDG_CONFIG_HOME: terminalConfigHome,
      REA_IDA_MCP_CONFIG: undefined,
    };
    const save = async (configHome: string, providerConfig: string) => {
      const path = join(configHome, "rea", "rea.json");
      await mkdir(dirname(path), { recursive: true });
      await writeFile(
        path,
        JSON.stringify({ REA_IDA_MCP_CONFIG: providerConfig }),
      );
    };
    await save(terminalConfigHome, terminalIda);
    await save(clientConfigHome, clientIda);
    await mkdir(codexHome);
    const cliPath = join(process.cwd(), "scripts", "rea.mjs");
    const writeRegistration = (explicit?: string) =>
      writeFile(
        codexConfig,
        [
          "[mcp_servers.rea]",
          `command = ${JSON.stringify(process.execPath)}`,
          `args = ${JSON.stringify([cliPath, "mcp"])}`,
          "startup_timeout_sec = 30",
          "tool_timeout_sec = 450",
          "[mcp_servers.rea.env]",
          `XDG_CONFIG_HOME = ${JSON.stringify(clientConfigHome)}`,
          ...(explicit === undefined
            ? []
            : [`REA_IDA_MCP_CONFIG = ${JSON.stringify(explicit)}`]),
        ].join("\n"),
      );
    const doctor = () =>
      cli.run({
        arguments: [
          "doctor",
          "--client",
          "codex",
          "--provider",
          "ida",
          "--skill=false",
          "--json",
        ],
        cwd: home,
        environment,
        freshProcess: true,
      });
    const expectInspection = async (
      setting: string,
      source: "config" | "env",
    ) => {
      const result = await doctor();
      expect(result.exitCode).toBe(1);
      expect(result.json).toMatchObject({
        providerInspections: expect.arrayContaining([
          expect.objectContaining({
            id: "ida",
            configured: true,
            checks: expect.arrayContaining([
              expect.objectContaining({
                code: "invalid_configuration",
                detail: expect.stringContaining(setting),
              }),
            ]),
            providerSettings: {
              REA_IDA_MCP_CONFIG: { value: setting, source },
            },
          }),
        ]),
      });
    };

    await writeRegistration();
    await expectInspection(clientIda, "config");
    await writeFile(
      clientIda,
      JSON.stringify({ url: "http://127.0.0.1:12345/mcp", protocol: "native" }),
    );
    const setup = await cli.run({
      arguments: [
        "setup",
        "--client",
        "codex",
        "--skill=false",
        "--yes",
        "--json",
      ],
      cwd: home,
      environment: { ...environment, XDG_CONFIG_HOME: undefined },
      freshProcess: true,
    });
    expect(setup.json, setup.stderr).toMatchObject({ status: "ready" });
    const configured = await readFile(codexConfig, "utf8");
    expect(configured).toContain("XDG_CONFIG_HOME");
    expect(configured).not.toContain("REA_IDA_MCP_CONFIG");

    await writeRegistration(explicitIda);
    await expectInspection(explicitIda, "env");

    await writeFile(clientConfig, "{");
    const invalid = await doctor();
    expect(invalid.exitCode).toBe(1);
    expect(invalid.json).toMatchObject({
      providerInspections: expect.arrayContaining([
        expect.objectContaining({
          id: "ida",
          checks: expect.arrayContaining([
            expect.objectContaining({
              code: "invalid_configuration",
              detail: expect.stringContaining(clientConfig),
            }),
          ]),
        }),
      ]),
    });
    const launch = await processes.run(process.execPath, [cliPath, "mcp"], {
      cwd: home,
      env: { ...environment, XDG_CONFIG_HOME: clientConfigHome },
    });
    expect(launch.exitCode).toBe(1);
    expect(launch.stderr).toContain(clientConfig);
  },
);

cliTest.skipIf(process.platform === "win32")(
  "refuses a saved configuration FIFO during reads and edits without waiting for a writer",
  async ({ cli, processes }) => {
    const home = await createTestTempDirectory("rea-user-config-fifo-");
    const xdg = join(home, "xdg");
    const config = join(xdg, "rea", "rea.json");
    await mkdir(dirname(config), { recursive: true });
    const created = await processes.run("mkfifo", [config], {
      timeoutMs: 5_000,
    });
    expect(created.exitCode, created.stderr).toBe(0);
    for (const arguments_ of [
      ["doctor", "--json"],
      ["mcp"],
      ["config", "--set", `JAVA_HOME=${join(home, "java")}`, "--json"],
    ]) {
      const result = await cli.run({
        arguments: arguments_,
        cwd: home,
        environment: { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: xdg },
        freshProcess: true,
        timeoutMs: 5_000,
      });
      expect(result.exitCode, JSON.stringify(arguments_)).toBe(1);
      const diagnostic = [result.stdout, result.stderr].join("\n");
      expect(diagnostic).toContain(config);
      expect(diagnostic).toContain("regular JSON file");
    }
    expect((await lstat(config)).isFIFO()).toBe(true);
    expect(await readdir(dirname(config))).toEqual(["rea.json"]);
  },
);

// Linux verifies a launcher against authenticated publisher metadata. The macOS
// fixture can exercise selection with a local executable and no publisher access.
cliTest.runIf(process.platform === "darwin")(
  "doctor uses the selected client file for Hopper and ILSpy probes",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-static-provider-settings-");
    const configHome = join(home, "client-config");
    const savedConfig = join(configHome, "rea", "rea.json");
    const codexHome = join(home, ".codex");
    const codexConfig = join(codexHome, "config.toml");
    const hopper = join(home, "selected-hopper");
    const ilspy = join(home, "selected-ilspycmd");
    await writeFile(hopper, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await writeFile(ilspy, "#!/bin/sh\nprintf 'ilspycmd: 9.1.0\\n'\n", {
      mode: 0o700,
    });
    await mkdir(dirname(savedConfig), { recursive: true });
    await mkdir(codexHome);
    await writeFile(
      savedConfig,
      JSON.stringify({
        HOPPER_LAUNCHER_PATH: hopper,
        REA_ILSPY_CMD_PATH: ilspy,
      }),
    );
    const cliPath = join(process.cwd(), "scripts", "rea.mjs");
    await writeFile(
      codexConfig,
      [
        "[mcp_servers.rea]",
        `command = ${JSON.stringify(process.execPath)}`,
        `args = ${JSON.stringify([cliPath, "mcp"])}`,
        "startup_timeout_sec = 30",
        "tool_timeout_sec = 450",
        "[mcp_servers.rea.env]",
        `XDG_CONFIG_HOME = ${JSON.stringify(configHome)}`,
      ].join("\n"),
    );
    const run = (...arguments_: string[]) =>
      cli.run({
        arguments: [
          ...arguments_,
          "--client",
          "codex",
          "--skill=false",
          "--json",
        ],
        cwd: home,
        environment: {
          HOME: home,
          USERPROFILE: home,
          CODEX_HOME: codexHome,
          XDG_CONFIG_HOME: undefined,
          HOPPER_LAUNCHER_PATH: undefined,
          REA_ILSPY_CMD_PATH: undefined,
        },
        freshProcess: true,
      });
    const report = await run("doctor");
    expect(report.json).toMatchObject({
      hopperPath: hopper,
      staticProviderSettings: {
        HOPPER_LAUNCHER_PATH: { value: hopper, source: "config" },
        REA_ILSPY_CMD_PATH: { value: ilspy, source: "config" },
      },
      checks: expect.arrayContaining([
        expect.objectContaining({ name: "hopper", ok: true, detail: hopper }),
        expect.objectContaining({
          name: "ilspycmd",
          ok: true,
          detail: expect.stringContaining(ilspy),
        }),
      ]),
    });

    const setup = await run("setup", "--yes");
    expect(setup.exitCode, setup.stdout).toBe(0);
    const setupRegistration = await readFile(codexConfig, "utf8");
    expect(setupRegistration).toContain("XDG_CONFIG_HOME");
    expect(setupRegistration).not.toContain("HOPPER_LAUNCHER_PATH");
    expect(setupRegistration).not.toContain("REA_ILSPY_CMD_PATH");

    await writeFile(savedConfig, "{");
    const invalid = await run("doctor");
    expect(invalid.exitCode).toBe(1);
    expect(invalid.json).not.toHaveProperty("hopperPath");
    expect(invalid.json).toMatchObject({
      checks: expect.arrayContaining(
        ["hopper", "ilspycmd"].map((name) =>
          expect.objectContaining({
            name,
            ok: false,
            detail: expect.stringContaining(savedConfig),
          }),
        ),
      ),
    });
  },
);
