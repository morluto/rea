import { createGdbFixtureOwner } from "./gdbTestHelpers.js";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GdbSessionManager } from "../../../src/gdb/GdbSessionManager.js";
import { AnalysisSettings } from "../../../src/application/AnalysisSettings.js";

const gdbSettingsFixture = `#!${process.execPath}
process.stdout.write("(gdb)\\n");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
 input += chunk;
 for (;;) {
  const end = input.indexOf("\\n"); if (end < 0) break;
  const line = input.slice(0,end); input = input.slice(end+1);
  const match = /^(\\d+)/.exec(line);
  if (match && line.includes("list-thread-groups")) process.stdout.write(match[1] + "^done,groups=[]\\n");
  else if (match) process.stdout.write(match[1] + "^done\\n");
 }
});`;

const debuggerDeadlineOverride = {
  setting: "debugger.command_deadline_ms",
  action: "set",
  value: 5000,
} as const;

describe("persistent debugger session managers", () => {
  let directory: string | undefined;
  const fixtureOwner = createGdbFixtureOwner();
  const managers: Array<{ closeAll(): Promise<void> }> = [];

  afterEach(async () => {
    await fixtureOwner.cleanup(managers, async () => {
      if (directory !== undefined)
        await rm(directory, { recursive: true, force: true });
      directory = undefined;
    });
  });

  it("runs a correlated GDB MI command, reports status, and closes its owned process", async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-gdb-manager-"));
    const provider = join(directory, "fake-gdb.mjs");
    await writeFile(
      provider,
      `#!${process.execPath}
process.stdout.write("(gdb)\\n");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const boundary = input.indexOf("\\n");
    if (boundary < 0) break;
    const line = input.slice(0, boundary);
    input = input.slice(boundary + 1);
    const match = /^(\\d+)/.exec(line);
    if (match && line.includes("list-thread-groups"))
      process.stdout.write(match[1] + "^done,groups=[]\\n");
    else if (match) process.stdout.write(match[1] + "^done\\n");
  }
});
`,
    );
    await chmod(provider, 0o700);
    const manager = new GdbSessionManager({
      spawnProcess: fixtureOwner.spawnProcess,
      platform: "linux",
      environment: { REA_GDB_COMMAND: provider },
    });
    managers.push(manager);

    const started = await manager.start();
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(manager.status(started.value.session_id)?.state).toBe("ready");

    const result = await manager.execute(
      started.value.session_id,
      "show version",
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.result.mi).toMatch(/^\d+\^done/u);

    const closed = await manager.close(started.value.session_id);
    expect(closed.ok).toBe(true);
    expect(manager.status(started.value.session_id)).toBeUndefined();
  });

  it.each([
    ["debugger.command_deadline_ms", "REA_DEBUGGER_COMMAND_DEADLINE_MS", 5000],
    [
      "debugger.max_command_output_bytes",
      "REA_DEBUGGER_MAX_COMMAND_OUTPUT_BYTES",
      4096,
    ],
  ] as const)(
    "restores a GDB session after resetting invalid %s",
    async (setting, environmentName, value) => {
      directory = await mkdtemp(join(tmpdir(), "rea-gdb-setting-"));
      const provider = join(directory, "fake-gdb.mjs");
      await writeFile(provider, gdbSettingsFixture);
      await chmod(provider, 0o700);
      const environment = {
        REA_GDB_COMMAND: provider,
        [environmentName]: "invalid",
        REA_DEBUGGER_MAX_PENDING_COMMANDS: "1",
      };
      const settings = new AnalysisSettings(environment);
      const set = () =>
        settings.update({ changes: [{ setting, action: "set", value }] });
      expect(set().ok).toBe(true);
      if (setting === "debugger.max_command_output_bytes")
        expect(
          settings.update({ changes: [debuggerDeadlineOverride] }).ok,
        ).toBe(true);
      const manager = new GdbSessionManager({
        spawnProcess: fixtureOwner.spawnProcess,
        platform: "linux",
        environment,
      });
      managers.push(manager);
      const started = await settings.run(() => manager.start());
      if (!started.ok) throw started.error;
      const execute = () =>
        settings.run(() =>
          manager.execute(started.value.session_id, "show version"),
        );
      expect((await execute()).ok).toBe(true);
      expect(
        settings.update({ changes: [{ setting, action: "reset" }] }).ok,
      ).toBe(true);
      expect(await execute()).toMatchObject({
        ok: false,
        error: { _tag: "ConfigurationError" },
      });
      expect(set().ok).toBe(true);
      expect((await execute()).ok).toBe(true);
      expect(
        (await settings.run(() => manager.close(started.value.session_id))).ok,
      ).toBe(true);
    },
  );

  it("does not start GDB when it rejects the required auto-load setting", async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-gdb-autoload-"));
    const provider = join(directory, "fake-gdb-reject.mjs");
    await writeFile(
      provider,
      `#!${process.execPath}
process.stdout.write("(gdb)\\n");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const boundary = input.indexOf("\\n");
    if (boundary < 0) break;
    const line = input.slice(0, boundary);
    input = input.slice(boundary + 1);
    const match = /^(\\d+)(.*)/.exec(line);
    if (match) process.stdout.write(match[1] + (match[2].includes("-gdb-set auto-load off") ? "^error,msg=\\"rejected\\"\\n" : "^done\\n"));
  }
});
`,
    );
    await chmod(provider, 0o700);
    const manager = new GdbSessionManager({
      spawnProcess: fixtureOwner.spawnProcess,
      platform: "linux",
      environment: { REA_GDB_COMMAND: provider },
    });
    managers.push(manager);

    const started = await manager.start();

    expect(started.ok).toBe(false);
    if (!started.ok)
      expect(JSON.stringify(started.error)).toContain(
        "automatic-loading disable command",
      );
  });
});

it("starts GDB without applying an invalid console output limit", async () => {
  const owner = createGdbFixtureOwner();
  const directory = await mkdtemp(join(tmpdir(), "rea-gdb-start-output-"));
  const provider = join(directory, "fake-gdb.mjs");
  await writeFile(provider, gdbSettingsFixture);
  await chmod(provider, 0o700);
  const environment = {
    REA_GDB_COMMAND: provider,
    REA_DEBUGGER_MAX_COMMAND_OUTPUT_BYTES: "invalid",
  };
  const manager = new GdbSessionManager({
    spawnProcess: owner.spawnProcess,
    platform: "linux",
    environment,
  });
  try {
    const started = await manager.start();
    if (!started.ok) throw started.error;
    expect(
      await manager.execute(started.value.session_id, "show version"),
    ).toMatchObject({ ok: false, error: { _tag: "ConfigurationError" } });
    expect(await manager.close(started.value.session_id)).toMatchObject({
      ok: true,
      value: { target_state: "none_observed" },
    });
  } finally {
    await owner.cleanup([manager], () =>
      rm(directory, { recursive: true, force: true }),
    );
  }
});
