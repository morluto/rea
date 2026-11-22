import {
  access,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest, type TestCli } from "../../support/cli/cliFixture.js";
import { registrationEnvironment } from "../../support/cli/registrationEnvironment.js";

const isolatedRegistration = async (cli: TestCli) => {
  const home = await createTestTempDirectory("rea-mcp-add-validation-");
  const environment = await registrationEnvironment(home);
  return {
    home,
    settingsPath: join(home, ".config", "amp", "settings.json"),
    run: (options: readonly string[], cwd = home) =>
      cli.run({
        arguments: ["mcp", "add", ...options, "--json"],
        cwd,
        environment,
      }),
  };
};

const optionError = (path: string, message: string) => ({
  exitCode: 1,
  json: {
    code: "VALIDATION_ERROR",
    message,
    fieldErrors: [{ code: "invalid_value", missing: false, path, message }],
  },
});

cliTest(
  "mcp add reports the missing value's field before admitting any settings writes",
  async ({ cli }) => {
    const { run, settingsPath } = await isolatedRegistration(cli);
    for (const [options, field, flag] of [
      [["--agent"], "agent", "--agent"],
      [["--command", "--agent", "amp"], "command", "--command"],
      [["extra", "-c="], "command", "-c"],
      [["extra", "--agent="], "agent", "--agent"],
    ] as const) {
      expect(await run(options), options.join(" ")).toMatchObject(
        optionError(field, `Missing value for flag: ${flag}`),
      );
      await expect(access(settingsPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
  },
);

cliTest(
  "mcp add leaves existing settings untouched on refusal and stores the exact valid launcher",
  async ({ cli }) => {
    const { run, settingsPath } = await isolatedRegistration(cli);
    const directory = dirname(settingsPath);
    const original =
      '{"amp.mcpServers":{"rea":{"command":"old","env":{"KEEP":"1"}}},"theme":"dark"}\n';
    await mkdir(directory, { recursive: true });
    await writeFile(settingsPath, original);
    const before = await stat(settingsPath);

    for (const [options, field, message] of [
      [["--agent=amp", "extra"], "arguments", "Unexpected argument: extra"],
      [
        ["--bogus", "--agent", "amp"],
        "arguments",
        "Unexpected argument: --bogus",
      ],
      [
        ["--agent", "amp", "--command"],
        "command",
        "Missing value for flag: --command",
      ],
    ] as const) {
      expect(await run(options), options.join(" ")).toMatchObject(
        optionError(field, message),
      );
      expect(await readFile(settingsPath, "utf8")).toBe(original);
      expect((await stat(settingsPath)).mtimeMs).toBe(before.mtimeMs);
      expect(await readdir(directory)).toEqual(["settings.json"]);
    }

    expect(await run(["--agent=amp", "-c=node --version"])).toMatchObject({
      exitCode: 0,
      json: {
        command: "node",
        args: ["--version"],
        clients: [{ client: "amp", status: "configured" }],
      },
    });
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({
      "amp.mcpServers": {
        rea: { command: "node", args: ["--version"], env: { KEEP: "1" } },
      },
      theme: "dark",
    });
    expect(await readFile(`${settingsPath}.rea.backup`, "utf8")).toBe(original);
  },
);

cliTest(
  "packaged --no-global refuses a global-only member before writing any selected client",
  async ({ cli }) => {
    const { home, run } = await isolatedRegistration(cli);
    const project = join(home, "project");
    await mkdir(project);

    expect(
      await run(
        ["--agent", "cursor", "--agent", "goose", "--no-global"],
        project,
      ),
    ).toMatchObject({
      exitCode: 1,
      json: {
        code: "VALIDATION_ERROR",
        message: expect.stringContaining("project-scoped"),
      },
    });
    const goose =
      process.platform === "win32"
        ? join(home, "appdata", "Block", "goose", "config", "config.yaml")
        : join(home, ".config", "goose", "config.yaml");
    for (const path of [
      join(home, ".cursor", "mcp.json"),
      join(project, ".cursor", "mcp.json"),
      goose,
    ])
      await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
  },
);
