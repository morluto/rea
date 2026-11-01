import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { expect } from "vitest";
import { PRODUCT_IDENTITY } from "../../../src/identity.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { MCP_BOOTSTRAP_FILES } from "../../../scripts/lib/cli-runtime-files.mjs";

cliTest(
  "public Cursor setup downloads a local plugin only after opt-in and approval",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-cursor-local-cli-");
    const bin = join(home, "selected tools");
    await mkdir(bin);
    const downloads = join(home, "downloads.json");
    const hijacked = join(home, "hijacked");
    const script = join(bin, "npm-fixture.mjs");
    const manifest = JSON.parse(
      await readFile(
        new URL("../../../.claude-plugin/plugin.json", import.meta.url),
        "utf8",
      ),
    );
    await writeFile(
      script,
      `
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
const args = process.argv.slice(2);
if (args[0] !== 'install' || !args.includes(${JSON.stringify(PRODUCT_IDENTITY.registrationPackageSpecifier)})) throw new Error('unexpected npm invocation');
const prefix = args[args.indexOf('--prefix') + 1];
const root = join(prefix, 'node_modules', 'rea-agents');
for (const path of ['.claude-plugin', 'scripts/lib', 'dist/mcp', 'dist/cli-runtime', 'skills/reverse-engineer-anything', 'assets']) await mkdir(join(root, path), { recursive: true });
await writeFile(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify(${JSON.stringify(manifest)}));
await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'rea-agents', version: ${JSON.stringify(PRODUCT_IDENTITY.packageVersion)} }));
for (const path of ['scripts/plugin-mcp-launcher.mjs', 'scripts/rea.mjs', ...${JSON.stringify(MCP_BOOTSTRAP_FILES)}, 'dist/cli.js', 'skills/reverse-engineer-anything/SKILL.md', 'assets/rea-plugin.png']) await writeFile(join(root, path), 'fixture package');
let count = 0;
try { count = JSON.parse(await readFile(${JSON.stringify(downloads)}, 'utf8')); } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
await writeFile(${JSON.stringify(downloads)}, JSON.stringify(count + 1));
`,
    );
    await writeFile(
      join(bin, process.platform === "win32" ? "npm.cmd" : "npm"),
      process.platform === "win32"
        ? `@"${process.execPath}" "${script}" %*\r\n`
        : `#!/usr/bin/env node\nimport ${JSON.stringify(script)};\n`,
      { mode: 0o755 },
    );
    if (process.platform === "win32") {
      await writeFile(
        join(bin, "npm.ps1"),
        "throw 'PowerShell shim must be skipped'",
      );
      await writeFile(
        join(home, "npm.cmd"),
        `@echo hijacked>"${hijacked}"\r\n@exit /b 1\r\n`,
      );
    }
    const run = (mode: string) =>
      cli.run({
        arguments: [
          "setup",
          "--client",
          "cursor",
          "--cursor-plugin",
          "--json",
          mode,
        ],
        cwd: home,
        environment: {
          HOME: home,
          USERPROFILE: home,
          PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
          ...(process.platform === "win32"
            ? { PATHEXT: ".PS1;.CMD;.EXE" }
            : {}),
        },
      });
    const ordinary = await cli.run({
      arguments: ["setup", "--client", "cursor", "--json", "--dry-run"],
      cwd: home,
      environment: { HOME: home, USERPROFILE: home },
    });
    expect(ordinary.exitCode, ordinary.stdout + ordinary.stderr).toBe(0);
    expect(JSON.stringify(ordinary.json)).not.toContain(
      "REA local plugin for Cursor",
    );
    const preview = await run("--dry-run");
    expect(preview.exitCode, preview.stdout + preview.stderr).toBe(0);
    expect(preview.json).toMatchObject({
      status: "planned",
      plannedActions: [
        expect.objectContaining({
          id: "configure_client:cursor",
          label: "REA local plugin for Cursor",
          external: true,
        }),
      ],
    });
    await expect(access(downloads)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(home, ".cursor"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const installed = await run("--yes");
    expect(installed.exitCode, installed.stdout + installed.stderr).toBe(0);
    expect(installed.json).toMatchObject({
      status: "ready",
      doctor: { scope: { plugin_clients: ["cursor"] } },
    });
    const rerun = await run("--yes");
    expect(rerun.exitCode, rerun.stdout + rerun.stderr).toBe(0);
    expect(rerun.json).toMatchObject({
      status: "ready",
      plannedActions: [],
      appliedActions: [],
    });
    const ordinaryRerun = await cli.run({
      arguments: ["setup", "--client", "cursor", "--json", "--yes"],
      cwd: home,
      environment: { HOME: home, USERPROFILE: home },
    });
    expect(
      ordinaryRerun.exitCode,
      ordinaryRerun.stdout + ordinaryRerun.stderr,
    ).toBe(0);
    expect(ordinaryRerun.json).toMatchObject({
      status: "ready",
      plannedActions: [],
      appliedActions: [],
    });
    expect(await readFile(downloads, "utf8")).toBe("1");
    expect(await readdir(join(home, ".cursor", "plugins", "local"))).toEqual([
      "rea",
    ]);
    for (const path of [
      hijacked,
      join(home, ".cursor", "mcp.json"),
      join(home, ".cursor", "skills", PRODUCT_IDENTITY.skillName, "SKILL.md"),
    ])
      await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
  },
  120_000,
);
