import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { expect } from "vitest";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

// A real child command exercises setup's CLI wiring and owned-process boundary.
const clientSource = `import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
const path = process.env.PLUGIN_TEST_STATE;
const state = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { installed: false, mutations: [] };
const args = process.argv.slice(2);
if (args[0] !== 'plugin') process.exit(2);
if (args[1] === 'list') {
  if (!existsSync(process.env.PLUGIN_TEST_CONFIG)) {
    mkdirSync(dirname(process.env.PLUGIN_TEST_CONFIG), { recursive: true });
    writeFileSync(process.env.PLUGIN_TEST_CONFIG, process.env.PLUGIN_TEST_CLIENT === 'codex' ? 'model = "fixture"\\n' : '{"existing":true}');
  }
  const entries = state.installed ? [process.env.PLUGIN_TEST_CLIENT === 'codex'
    ? { pluginId: 'rea@rea', name: 'rea', enabled: true }
    : { id: 'rea@rea', scope: 'user', enabled: true }] : [];
  console.log(JSON.stringify(process.env.PLUGIN_TEST_CLIENT === 'codex' ? { installed: entries } : entries));
} else {
  state.mutations.push(args);
  if (args[1] !== 'marketplace') state.installed = true;
  writeFileSync(path, JSON.stringify(state));
}
`;

for (const [id, command] of [
  ["codex", "codex"],
  ["claude_code", "claude"],
] as const)
  cliTest(
    `public setup installs the ${id} plugin after approval and is idempotent`,
    async ({ cli }) => {
      const root = await createTestTempDirectory("rea-plugin-first-");
      const home = join(root, "client home");
      await mkdir(home);
      const bin = join(home, "bin");
      await mkdir(bin);
      const script = join(bin, "client.mjs");
      await writeFile(script, clientSource);
      const hijackMarker = join(home, "client-hijacked");
      if (process.platform === "win32")
        await writeFile(
          join(home, `${command}.cmd`),
          `@echo hijacked>"${hijackMarker}"\r\n@exit /b 1\r\n`,
        );
      await writeFile(
        join(bin, `${command}${process.platform === "win32" ? ".cmd" : ""}`),
        process.platform === "win32"
          ? `@"${process.execPath}" "${script}" %*\r\n`
          : `#!/usr/bin/env node\nimport ${JSON.stringify(script)};\n`,
        { mode: 0o755 },
      );
      const state = join(home, "plugin-state.json");
      const config =
        command === "codex"
          ? join(home, ".codex", "config.toml")
          : join(home, ".claude", ".claude.json");
      const run = (mode: string) =>
        cli.run({
          arguments: ["setup", "--client", id, "--json", mode],
          cwd: home,
          environment: {
            HOME: home,
            USERPROFILE: home,
            CODEX_HOME: join(home, ".codex"),
            CLAUDE_CONFIG_DIR: join(home, ".claude"),
            PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
            PLUGIN_TEST_STATE: state,
            PLUGIN_TEST_CLIENT: command,
            PLUGIN_TEST_CONFIG: config,
          },
        });
      const preview = await run("--dry-run");
      expect(preview.exitCode, `${preview.stdout}\n${preview.stderr}`).toBe(0);
      expect(preview.json).toMatchObject({
        status: "planned",
        plannedActions: [
          {
            id: `configure_client:${id}`,
            external: true,
            commands: [
              ...(command === "claude" ? ["claude plugin list --json"] : []),
              `${command} plugin marketplace add morluto/rea`,
              `${command} plugin ${command === "codex" ? "add" : "install"} rea@rea${command === "claude" ? " --scope user" : ""}`,
              ...(command === "claude"
                ? ["claude plugin enable rea@rea --scope user"]
                : []),
            ],
          },
        ],
      });
      await expect(access(state)).rejects.toMatchObject({ code: "ENOENT" });
      const original =
        command === "codex" ? await readFile(config, "utf8") : undefined;
      if (command === "claude")
        await expect(access(config)).rejects.toMatchObject({ code: "ENOENT" });
      const installed = await run("--yes");
      expect(
        installed.exitCode,
        `${installed.stdout}\n${installed.stderr}`,
      ).toBe(0);
      expect(installed.json).toMatchObject({
        status: "ready",
        doctor: { scope: { plugin_clients: [id] } },
      });
      const afterInstall = await readFile(state, "utf8");
      expect(JSON.parse(afterInstall)).toMatchObject({
        installed: true,
        mutations: expect.any(Array),
      });
      const again = await run("--yes");
      expect(again.exitCode, `${again.stdout}\n${again.stderr}`).toBe(0);
      expect(again.json).toMatchObject({
        status: "ready",
        ...(command === "codex"
          ? { plannedActions: [], appliedActions: [] }
          : {}),
      });
      expect(await readFile(state, "utf8")).toBe(afterInstall);
      await expect(access(hijackMarker)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await readFile(config, "utf8")).toBe(
        original ?? '{"existing":true}',
      );
      for (const path of [
        join(home, ".claude.json"),
        join(
          home,
          ".agents",
          "skills",
          "reverse-engineer-anything",
          "SKILL.md",
        ),
      ])
        await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
    },
    120_000,
  );
