import {
  access,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest("mcp add rejects valued options without a value", async ({ cli }) => {
  const root = await createTestTempDirectory("rea-mcp-add-value-");
  const home = join(root, "home");
  const settingsPath = (selectedHome: string) =>
    join(selectedHome, ".config", "amp", "settings.json");
  const run = (arguments_: readonly string[], selectedHome = home) =>
    cli.run({
      arguments: [...arguments_, "--json"],
      cwd: root,
      environment: {
        HOME: selectedHome,
        USERPROFILE: selectedHome,
        XDG_CONFIG_HOME: join(selectedHome, ".config"),
      },
      timeoutMs: 20_000,
    });

  for (const [flag, field] of [
    ["--agent", "agent"],
    ["--command", "command"],
    ["-c", "command"],
    ["-c=", "command"],
    ["--agent=", "agent"],
  ] as const) {
    const result = await run(["mcp", "add", flag]);
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
    await expect(access(settingsPath(home))).rejects.toMatchObject({
      code: "ENOENT",
    });
  }

  // Incur would swallow the following flag as the option value; REA rejects it.
  const swallowed = await run(["mcp", "add", "--command", "--agent", "amp"]);
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
  await expect(access(settingsPath(home))).rejects.toMatchObject({
    code: "ENOENT",
  });

  const existingHome = join(root, "existing-home");
  const existingSettingsPath = settingsPath(existingHome);
  await mkdir(join(existingHome, ".config", "amp"), { recursive: true });
  const existingSettings = '{"existing":true}\n';
  await writeFile(existingSettingsPath, existingSettings);
  const rejectedWithExistingSettings = await run(
    ["mcp", "add", "--agent"],
    existingHome,
  );
  expect(
    rejectedWithExistingSettings.exitCode,
    rejectedWithExistingSettings.stderr,
  ).toBe(1);
  expect(rejectedWithExistingSettings.json).toMatchObject({
    code: "VALIDATION_ERROR",
  });
  expect(await readFile(existingSettingsPath, "utf8")).toBe(existingSettings);

  // A registration with an explicit agent still writes the Amp registration.
  const registered = await run(["mcp", "add", "--agent", "amp"]);
  expect(registered.exitCode, registered.stderr).toBe(0);
  const settings = JSON.parse(await readFile(settingsPath(home), "utf8"));
  expect(settings["amp.mcpServers"].rea).toMatchObject({
    command: expect.any(String),
  });
});

cliTest(
  "mcp add rejects an argument that is neither an option nor a value",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-mcp-add-argument-");
    const home = join(root, "home");
    const settingsPath = join(home, ".config", "amp", "settings.json");
    const run = (arguments_: readonly string[]) =>
      cli.run({
        arguments: [...arguments_, "--json"],
        cwd: root,
        environment: {
          HOME: home,
          USERPROFILE: home,
          XDG_CONFIG_HOME: join(home, ".config"),
        },
        timeoutMs: 20_000,
      });

    // Incur skips a stray word, so the registration used to succeed for a request
    // REA cannot honor and wrote the settings file anyway.
    for (const arguments_ of [
      ["mcp", "add", "extra", "--agent", "amp"],
      ["mcp", "add", "--agent", "amp", "extra"],
      ["mcp", "add", "--agent=amp", "extra"],
      ["mcp", "add", "--bogus", "--agent", "amp"],
    ] as const) {
      const result = await run(arguments_);
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
    await mkdir(join(home, ".config", "amp"), { recursive: true });
    await writeFile(settingsPath, original);
    const before = await stat(settingsPath);
    const rejected = await run(["mcp", "add", "extra", "--agent=amp"]);
    expect(rejected.exitCode, rejected.stderr).toBe(1);
    expect(await readFile(settingsPath, "utf8")).toBe(original);
    expect((await stat(settingsPath)).mtimeMs).toBe(before.mtimeMs);
    expect(await readdir(join(home, ".config", "amp"))).toEqual([
      "settings.json",
    ]);

    // Verify the actual stored command, rather than an already-existing file.
    for (const options of [
      ["--agent", "amp", "--command", "node --version"],
      ["--agent=amp", "--command=node --version"],
      ["--agent=amp", "-c=node --version"],
    ]) {
      const registered = await run(["mcp", "add", ...options]);
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
    const root = await createTestTempDirectory("rea-mcp-add-field-");
    const home = join(root, "home");
    const run = (arguments_: readonly string[]) =>
      cli.run({
        arguments: [...arguments_, "--json"],
        cwd: root,
        environment: {
          HOME: home,
          USERPROFILE: home,
          XDG_CONFIG_HOME: join(home, ".config"),
        },
        timeoutMs: 20_000,
      });

    // A stray word alongside a missing value: the message describes the missing
    // flag, so `path` must name that option rather than the stray argument.
    for (const [arguments_, field] of [
      [["mcp", "add", "extra", "--command"], "command"],
      [["mcp", "add", "extra", "-c"], "command"],
      [["mcp", "add", "extra", "--agent"], "agent"],
    ] as const) {
      const result = await run(arguments_);
      expect(result.exitCode, result.stderr).toBe(1);
      expect(result.json).toMatchObject({
        code: "VALIDATION_ERROR",
        fieldErrors: [
          expect.objectContaining({ code: "invalid_value", path: field }),
        ],
      });
      expect(
        (result.json as { message?: string }).message,
        "the message and the field must describe the same error",
      ).toContain("Missing value for flag");
    }
  },
);
