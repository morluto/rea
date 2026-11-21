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
