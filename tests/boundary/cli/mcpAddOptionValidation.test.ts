import {
  access,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect } from "vitest";

import {
  createTestWorkspace,
  removeTestWorkspace,
} from "../../support/workspace/workspaceFixture.js";
import { cliTest, type TestCli } from "../../support/cli/cliFixture.js";
import { registrationEnvironment } from "../../support/cli/registrationEnvironment.js";

let sharedRoot = "";
let sharedHome = "";
let sharedEnvironment: NodeJS.ProcessEnv = {};

beforeAll(async () => {
  sharedRoot = (await createTestWorkspace("rea-mcp-add-validation-")).root;
  sharedHome = join(sharedRoot, "home");
  sharedEnvironment = await registrationEnvironment(sharedHome);
});

beforeEach(async () => {
  for (const directory of [".config", ".cursor", "appdata"]) {
    await rm(join(sharedHome, directory), { recursive: true, force: true });
  }
});

afterAll(async () => {
  if (sharedRoot !== "") {
    await removeTestWorkspace(sharedRoot);
  }
});

const runMcpAdd = (
  cli: TestCli,
  arguments_: readonly string[],
  cwd = sharedRoot,
) =>
  cli.run({
    arguments: [...arguments_, "--json"],
    cwd,
    environment: sharedEnvironment,
  });

cliTest("mcp add rejects valued options without a value", async ({ cli }) => {
  const settingsPath = join(sharedHome, ".config", "amp", "settings.json");

  for (const [flag, field] of [
    ["--agent", "agent"],
    ["--command", "command"],
    ["-c", "command"],
    ["-c=", "command"],
    ["--agent=", "agent"],
  ] as const) {
    const result = await runMcpAdd(cli, ["mcp", "add", flag]);
    expect(result.exitCode, result.stderr).toBe(1);
    expect(result.json).toMatchObject({
      code: "VALIDATION_ERROR",
      fieldErrors: expect.arrayContaining([
        expect.objectContaining({
          code: "invalid_value",
          missing: false,
          path: field,
        }),
      ]),
    });
    await expect(access(settingsPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  }

  // Incur would swallow the following flag as the option value; REA rejects it.
  const swallowed = await runMcpAdd(cli, [
    "mcp",
    "add",
    "--command",
    "--agent",
    "amp",
  ]);
  expect(swallowed.exitCode, swallowed.stderr).toBe(1);
  expect(swallowed.json).toMatchObject({
    code: "VALIDATION_ERROR",
    fieldErrors: expect.arrayContaining([
      expect.objectContaining({
        code: "invalid_value",
        missing: false,
        path: "command",
      }),
    ]),
  });
  await expect(access(settingsPath)).rejects.toMatchObject({
    code: "ENOENT",
  });

  await mkdir(join(sharedHome, ".config", "amp"), { recursive: true });
  const existingSettings = '{"existing":true}\n';
  await writeFile(settingsPath, existingSettings);
  const rejectedWithExistingSettings = await runMcpAdd(cli, [
    "mcp",
    "add",
    "--agent",
  ]);
  expect(
    rejectedWithExistingSettings.exitCode,
    rejectedWithExistingSettings.stderr,
  ).toBe(1);
  expect(rejectedWithExistingSettings.json).toMatchObject({
    code: "VALIDATION_ERROR",
  });
  expect(await readFile(settingsPath, "utf8")).toBe(existingSettings);

  // A registration with an explicit agent still writes the Amp registration.
  await rm(join(sharedHome, ".config"), { recursive: true, force: true });
  const registered = await runMcpAdd(cli, ["mcp", "add", "--agent", "amp"]);
  expect(registered.exitCode, registered.stderr).toBe(0);
  const settings = JSON.parse(await readFile(settingsPath, "utf8"));
  expect(settings["amp.mcpServers"].rea).toMatchObject({
    command: expect.any(String),
  });
});

cliTest(
  "mcp add rejects an argument that is neither an option nor a value",
  async ({ cli }) => {
    const settingsPath = join(sharedHome, ".config", "amp", "settings.json");

    // Incur skips a stray word, so the registration used to succeed for a request
    // REA cannot honor and wrote the settings file anyway.
    for (const arguments_ of [
      ["mcp", "add", "extra", "--agent", "amp"],
      ["mcp", "add", "--agent", "amp", "extra"],
      ["mcp", "add", "--agent=amp", "extra"],
      ["mcp", "add", "--bogus", "--agent", "amp"],
    ] as const) {
      const result = await runMcpAdd(cli, arguments_);
      expect(result.exitCode, result.stderr).toBe(1);
      expect(result.json).toMatchObject({
        code: "VALIDATION_ERROR",
        message: expect.stringMatching(/Unexpected argument: (extra|--bogus)/),
        fieldErrors: expect.arrayContaining([
          expect.objectContaining({
            code: "invalid_value",
            missing: false,
            path: expect.stringMatching(/arguments|command/),
          }),
        ]),
      });
      await expect(access(settingsPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    }

    const original =
      '{"amp.mcpServers":{"rea":{"command":"old","env":{"KEEP":"1"}}},"theme":"dark"}\n';
    await mkdir(join(sharedHome, ".config", "amp"), { recursive: true });
    await writeFile(settingsPath, original);
    const before = await stat(settingsPath);
    const rejected = await runMcpAdd(cli, [
      "mcp",
      "add",
      "extra",
      "--agent=amp",
    ]);
    expect(rejected.exitCode, rejected.stderr).toBe(1);
    expect(await readFile(settingsPath, "utf8")).toBe(original);
    expect((await stat(settingsPath)).mtimeMs).toBe(before.mtimeMs);
    expect(await readdir(join(sharedHome, ".config", "amp"))).toEqual([
      "settings.json",
    ]);

    // Verify the actual stored command, rather than an already-existing file.
    for (const options of [
      ["--agent", "amp", "--command", "node --version"],
      ["--agent=amp", "--command=node --version"],
      ["--agent=amp", "-c=node --version"],
    ]) {
      const registered = await runMcpAdd(cli, ["mcp", "add", ...options]);
      expect(registered.exitCode, registered.stderr).toBe(0);
      expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({
        "amp.mcpServers": {
          rea: { command: "node", args: ["--version"], env: { KEEP: "1" } },
        },
        theme: "dark",
      });
    }
    expect(await readFile(`${settingsPath}.rea.backup`, "utf8")).toBe(original);
  },
);

cliTest(
  "mcp add names the option the reported error is about",
  async ({ cli }) => {
    // A stray word alongside a missing value: the message describes the missing
    // flag, so `path` must name that option rather than the stray argument.
    for (const [arguments_, field] of [
      [["mcp", "add", "extra", "--command"], "command"],
      [["mcp", "add", "extra", "-c"], "command"],
      [["mcp", "add", "extra", "--agent"], "agent"],
    ] as const) {
      const result = await runMcpAdd(cli, arguments_);
      expect(result.exitCode, result.stderr).toBe(1);
      expect(result.json).toMatchObject({
        code: "VALIDATION_ERROR",
        fieldErrors: [
          expect.objectContaining({ code: "invalid_value", path: field }),
        ],
      });
      expect(result.json).toMatchObject({
        message: expect.stringContaining("Missing value for flag"),
      });
    }
  },
);

cliTest(
  "packaged --no-global refuses a global-only member before writing any selected client",
  async ({ cli }) => {
    const project = join(sharedRoot, "project");
    await rm(project, { recursive: true, force: true });
    await mkdir(project, { recursive: true });
    const result = await runMcpAdd(
      cli,
      ["mcp", "add", "--agent", "cursor", "--agent", "goose", "--no-global"],
      project,
    );
    expect(result.exitCode, result.stderr).toBe(1);
    expect(result.json).toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining("project-scoped"),
    });
    const goose =
      process.platform === "win32"
        ? join(sharedHome, "appdata", "Block", "goose", "config", "config.yaml")
        : join(sharedHome, ".config", "goose", "config.yaml");
    for (const path of [
      join(sharedHome, ".cursor", "mcp.json"),
      join(project, ".cursor", "mcp.json"),
      goose,
    ])
      await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
  },
);
