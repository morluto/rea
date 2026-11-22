import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const scenarios = [
  {
    client: "grok_build",
    path: ".grok/config.toml",
    unrelated: { model: "x", mcp_servers: { other: { command: "other" } } },
    original: [
      "# root explanation",
      'model = "x" # inline model note',
      "",
      "# about rea",
      "[mcp_servers.rea]",
      "# inside the rea table",
      'command = "npx"',
      'args = ["-y", "rea-agents@6.1.0", "mcp"]',
      "",
      "# between rea and its environment",
      "[mcp_servers.rea.env]",
      'OLD = "value"',
      "# after the rea environment",
      "",
      "# about the other server",
      "[mcp_servers.other]",
      'command = "other" # other inline note',
      "",
      "# trailing note about the file",
      "",
    ].join("\n"),
    comments: [
      "# root explanation",
      'model = "x" # inline model note',
      "# about rea",
      "# inside the rea table",
      "# between rea and its environment",
      "# after the rea environment",
      "# about the other server",
      'command = "other" # other inline note',
      "# trailing note about the file",
    ],
  },
  {
    client: "codex",
    path: ".codex/config.toml",
    unrelated: {},
    original: [
      "# about rea",
      "[mcp_servers.rea]",
      'command = "npx"',
      'args = ["-y", "rea-agents@6.1.0", "mcp"]',
      "# trailing note without a line break",
    ].join("\n"),
    comments: ["# about rea", "# trailing note without a line break"],
  },
] as const;

/** Read unrelated values independently of the installed launcher's spelling. */
const unrelatedValues = (text: string) => {
  const document = parseToml(text);
  const servers = document.mcp_servers;
  if (typeof servers === "object" && servers !== null) {
    Reflect.deleteProperty(servers, "rea");
    if (Object.keys(servers).length === 0) delete document.mcp_servers;
  }
  return document;
};

cliTest(
  "TOML setup and uninstall keep comments around middle and final registrations",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-toml-comments-");
    const configs = scenarios.map((scenario) => ({
      ...scenario,
      path: join(home, scenario.path),
    }));
    for (const config of configs) {
      await mkdir(dirname(config.path), { recursive: true });
      await writeFile(config.path, config.original);
    }
    const run = (arguments_: readonly string[]) =>
      cli.run({
        arguments: arguments_,
        cwd: home,
        environment: {
          HOME: home,
          USERPROFILE: home,
          CODEX_HOME: join(home, ".codex"),
          GROK_HOME: join(home, ".grok"),
          XDG_CONFIG_HOME: join(home, ".config"),
          TMPDIR: home,
        },
      });
    const setup = [
      "setup",
      ...configs.flatMap(({ client }) => ["--client", client]),
      "--skill=false",
      "--json",
    ];

    const preview = await run([...setup, "--dry-run"]);
    expect(preview.exitCode, preview.stdout).toBe(0);
    expect(preview.json).toMatchObject({ status: "planned" });
    for (const { path, original } of configs)
      expect(await readFile(path, "utf8"), path).toBe(original);

    const applied = await run([...setup, "--yes"]);
    expect(applied.exitCode, applied.stdout).toBe(0);
    expect(applied.json).toMatchObject({
      status: "ready",
      clients: {
        codex: { status: "configured" },
        grok_build: { status: "configured" },
      },
    });
    const configured = [];
    for (const { path, original, comments, unrelated } of configs) {
      const text = await readFile(path, "utf8");
      configured.push({ path, text });
      for (const comment of comments) expect(text, path).toContain(comment);
      expect(text, path).not.toContain("rea-agents@6.1.0");
      expect(unrelatedValues(text), path).toEqual(unrelated);
      expect(parseToml(text), path).toHaveProperty("mcp_servers.rea.command");
      expect(await readFile(`${path}.rea.backup`, "utf8"), path).toBe(original);
    }

    const repeated = await run([...setup, "--yes"]);
    expect(repeated.exitCode, repeated.stdout).toBe(0);
    expect(repeated.json).toMatchObject({
      status: "ready",
      appliedActions: [],
    });
    for (const { path, text } of configured)
      expect(await readFile(path, "utf8"), path).toBe(text);

    const removed = await run(["uninstall", "--json"]);
    expect(removed.exitCode, removed.stdout).toBe(0);
    expect(removed.json).toMatchObject({ status: "complete" });
    for (const { path, comments, unrelated } of configs) {
      const text = await readFile(path, "utf8");
      for (const comment of comments) expect(text, path).toContain(comment);
      expect(parseToml(text), path).not.toHaveProperty("mcp_servers.rea");
      expect(unrelatedValues(text), path).toEqual(unrelated);
      expect(text.endsWith("\n"), path).toBe(true);
    }
  },
);
