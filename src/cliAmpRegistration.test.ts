import { spawnSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createTestTempDirectory } from "../tests/fixtures/temporaryDirectory.js";

it("admits exact Amp command facts and rejects invalid commands before publication", async () => {
  const home = await createTestTempDirectory("rea-amp-source-command-");
  try {
    await mkdir(join(home, "config"));
    const script = `
      import { homedir } from 'node:os';
      import { resolve, sep, join } from 'node:path';
      import { mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
      const home = process.env.HOME;
      if (!home || await realpath(homedir()) !== await realpath(home))
        throw Error('Fixture HOME was not selected before loading registration writers.');
      for (const key of ['USERPROFILE','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME','XDG_STATE_HOME','APPDATA','LOCALAPPDATA']) {
        const value = resolve(process.env[key] ?? '');
        if (value !== home && !value.startsWith(home + sep))
          throw Error('Fixture config location escapes selected HOME: ' + key);
      }
      const { createCli, closeCliResources } = await import(${JSON.stringify(new URL("./cli.ts", import.meta.url).href)});
      const original = { 'amp.mcpServers': { rea: { command: 'stale-executable', args: ['stale-argument'], env: { KEEP: '1' }, disabled: false }, peer: { command: 'peer' } }, theme: 'dark' };
      const directory = join(home, '.config', 'amp');
      const path = join(directory, 'settings.json');
      const cases = ['""', "'unclosed", 'fixture-server "unclosed', '"/fixture/server path" "" --mcp', String.raw\`'C:\\Program Files\\server.exe' 'C:\\data\\file'\`, 'fixture-server --mcp'];
      const results = [];
      try {
        for (const command of cases) {
          await rm(directory, { recursive: true, force: true });
          await mkdir(directory, { recursive: true });
          const before = JSON.stringify(original) + '\\n';
          await writeFile(path, before);
          let output = '', exitCode = 0;
          await createCli(process.env).serve(['mcp','add','--agent','amp','--command',command,'--json'], { stdout(text) { output += text; }, exit(code) { exitCode = code; } });
          const backup = await readFile(path + '.rea.backup', 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
          results.push({ command, exitCode, output, before, after: await readFile(path, 'utf8'), backup });
        }
      } finally { await closeCliResources(); }
      console.log(JSON.stringify(results));
    `;
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      {
        encoding: "utf8",
        timeout: 20_000,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          WINDIR: process.env.WINDIR,
          TMPDIR: process.env.TMPDIR,
          TMP: process.env.TMP,
          TEMP: process.env.TEMP,
          HOME: home,
          USERPROFILE: home,
          XDG_CONFIG_HOME: join(home, "config"),
          XDG_DATA_HOME: join(home, "data"),
          XDG_CACHE_HOME: join(home, "cache"),
          XDG_STATE_HOME: join(home, "state"),
          APPDATA: join(home, "appdata"),
          LOCALAPPDATA: join(home, "localappdata"),
          REA_LOG_LEVEL: "silent",
        },
      },
    );
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    const results = JSON.parse(child.stdout);
    expect(results).toHaveLength(6);
    for (const result of results.slice(0, 3)) {
      expect(result.exitCode, result.command).toBe(1);
      expect(result.output).toContain("VALIDATION_ERROR");
      expect(result.after).toBe(result.before);
      expect(result.backup).toBeNull();
    }
    const expected = [
      { command: "/fixture/server path", args: ["", "--mcp"] },
      {
        command: String.raw`C:\Program Files\server.exe`,
        args: [String.raw`C:\data\file`],
      },
      { command: "fixture-server", args: ["--mcp"] },
    ];
    for (const [index, result] of results.slice(3).entries()) {
      expect(result.exitCode, result.output).toBe(0);
      const original = JSON.parse(result.before);
      expect(JSON.parse(result.after)).toEqual({
        ...original,
        "amp.mcpServers": {
          ...original["amp.mcpServers"],
          rea: { ...original["amp.mcpServers"].rea, ...expected[index] },
        },
      });
      expect(result.backup).toBe(result.before);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 30_000);
