import {
  createGdbFixtureOwner,
  expectNoUnmodeledGdbCommands,
  FAKE_GDB_SESSION_REPLIES,
  FAKE_GDB_VERSION,
  fakeGdbModeledReplies,
  fakeGdbStartupPreamble,
  fakeGdbVersionStream,
} from "./gdbTestHelpers.js";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import { chmod, readFile, writeFile } from "node:fs/promises";

import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import { GdbSessionManager } from "../../../src/gdb/GdbSessionManager.js";
import { gdbReportedVersion } from "../../../src/gdb/GdbProviderIdentity.js";
import { AnalysisSettings } from "../../../src/application/AnalysisSettings.js";

const SHOW_VERSION_REPLIES = {
  ...FAKE_GDB_SESSION_REPLIES,
  '-interpreter-exec console "show version"': "^done",
};

/** A fake GDB that models a session running `show version`. */
const gdbSettingsFixture = (directory: string) => `#!${process.execPath}
${fakeGdbStartupPreamble}
${fakeGdbModeledReplies(join(directory, "unmodeled"), SHOW_VERSION_REPLIES)}
process.stdout.write("(gdb)\\n");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
 input += chunk;
 for (;;) {
  const end = input.indexOf("\\n"); if (end < 0) break;
  const line = input.slice(0,end); input = input.slice(end+1);
  const match = /^(\\d+)/.exec(line);
  if (match) answerModeled(match[1], line.slice(match[1].length));
 }
});`;

/** A fake GDB that answers the auto-load setting with `reply`. */
const autoLoadReplyFixture = (
  directory: string,
  reply: string,
) => `#!${process.execPath}
${fakeGdbStartupPreamble}
${fakeGdbModeledReplies(join(directory, "unmodeled"))}
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
    if (match?.[2] === "-gdb-set auto-load off") process.stdout.write(match[1] + "${reply}\\n");
    else if (match) answerModeled(match[1], line.slice(match[1].length));
  }
});
`;

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
      if (directory === undefined) return;
      try {
        await expectNoUnmodeledGdbCommands(join(directory, "unmodeled"));
      } finally {
        directory = undefined;
      }
    });
  });

  it("runs a correlated GDB MI command, reports status, and closes its owned process", async () => {
    directory = await createTestTempDirectory("rea-gdb-manager-");
    const provider = join(directory, "fake-gdb.mjs");
    await writeFile(
      provider,
      `#!${process.execPath}
${fakeGdbStartupPreamble}
${fakeGdbModeledReplies(join(directory, "unmodeled"), SHOW_VERSION_REPLIES)}
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
    if (match) answerModeled(match[1], line.slice(match[1].length));
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
    // Evidence names the version this GDB reported for -gdb-version.
    if (result.ok)
      expect(result.value.evidence.provider).toEqual({
        id: "gnu.gdb",
        name: "GNU GDB",
        version: FAKE_GDB_VERSION,
      });

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
      directory = await createTestTempDirectory("rea-gdb-setting-");
      const provider = join(directory, "fake-gdb.mjs");
      await writeFile(provider, gdbSettingsFixture(directory));
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

  // A malformed ^done is not a success record: the typed MI parser refuses it
  // where a ^done prefix match would have accepted the setting.
  it.each([
    ["rejects", String.raw`^error,msg=\"rejected\"`],
    [
      "answers with a malformed ^done for",
      String.raw`^done,msg=\"unterminated`,
    ],
  ])(
    "does not start GDB when it %s the required auto-load setting",
    async (_label, reply) => {
      directory = await createTestTempDirectory("rea-gdb-autoload-");
      const provider = join(directory, "fake-gdb-reject.mjs");
      await writeFile(provider, autoLoadReplyFixture(directory, reply));
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
    },
  );
});

it("starts GDB without applying an invalid console output limit", async () => {
  const owner = createGdbFixtureOwner();
  const directory = await createTestTempDirectory("rea-gdb-start-output-");
  const provider = join(directory, "fake-gdb.mjs");
  await writeFile(provider, gdbSettingsFixture(directory));
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
    await expectNoUnmodeledGdbCommands(join(directory, "unmodeled"));
  } finally {
    await owner.cleanup([manager], async () => undefined);
  }
});

it.each([
  ["upstream build", ['~"GNU gdb (GDB) 15.1\\n"', '~"Copyright"'], "15.1"],
  [
    "distribution build",
    [
      '=thread-group-added,id="i1"',
      '~"GNU gdb (Ubuntu 12.1-0ubuntu1~22.04) 12.1\\n"',
    ],
    "12.1",
  ],
  ["another banner", ['~"GDB 15.1\\n"'], null],
  ["no version token", ['~"GNU gdb (GDB)\\n"'], null],
  ["a malformed record", ['~"GNU gdb (GDB) 15.1'], null],
  ["no console record", ['&"GNU gdb (GDB) 15.1\\n"'], null],
])("reads the -gdb-version banner: %s", (_case, records, version) => {
  expect(gdbReportedVersion(records)).toBe(version);
});

it("leaves the GDB version unknown when its banner is not strict UTF-8", async () => {
  const owner = createGdbFixtureOwner();
  const directory = await createTestTempDirectory("rea-gdb-version-utf8-");
  const provider = join(directory, "fake-gdb.mjs");
  const unmodeledPath = join(directory, "unmodeled");
  await writeFile(
    provider,
    `#!${process.execPath}
import { appendFileSync } from "node:fs";
const modeled = new Set([
  "-gdb-set auto-load off",
  '-interpreter-exec console "show version"',
  "-gdb-exit",
]);
process.stdout.write("(gdb)\\n");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (let end = input.indexOf("\\n"); end >= 0; end = input.indexOf("\\n")) {
    const [, token = "", command = ""] = /^(\\d+)(.*)$/.exec(input.slice(0, end)) ?? [];
    input = input.slice(end + 1);
    if (command === "-gdb-version")
      process.stdout.write(Buffer.concat([
        Buffer.from('~"GNU gdb (GDB) 15.'),
        Buffer.from([0xff]),
        Buffer.from('\\\\n"\\n' + token + "^done\\n"),
      ]));
    else if (command === "-list-thread-groups --recurse 1")
      process.stdout.write(token + "^done,groups=[]\\n");
    else if (modeled.has(command)) process.stdout.write(token + "^done\\n");
    else {
      appendFileSync(${JSON.stringify(unmodeledPath)}, command + "\\n");
      process.stdout.write(token + '^error,msg="unmodeled request"\\n');
    }
  }
});
`,
  );
  await chmod(provider, 0o700);
  const manager = new GdbSessionManager({
    spawnProcess: owner.spawnProcess,
    platform: "linux",
    environment: { REA_GDB_COMMAND: provider },
  });
  try {
    const started = await manager.start();
    if (!started.ok) throw started.error;
    const result = await manager.execute(
      started.value.session_id,
      "show version",
    );
    if (!result.ok) throw result.error;
    expect(result.value.evidence.provider).toEqual({
      id: "gnu.gdb",
      name: "GNU GDB",
      version: null,
    });
    expect((await manager.close(started.value.session_id)).ok).toBe(true);
    await expect(readFile(unmodeledPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await owner.cleanup([manager], async () => undefined);
  }
});

it("answers the fake GDB version query across split chunks and listeners", async () => {
  const stdin = Object.assign(new EventEmitter(), { setEncoding: () => {} });
  const written: string[] = [];
  runInNewContext(fakeGdbStartupPreamble, {
    process: { stdin, stdout: { write: (text: string) => written.push(text) } },
    setImmediate,
  });
  const received: [string[], string[]] = [[], []];
  for (const lines of received)
    stdin.on("data", (chunk: string) => lines.push(chunk));
  stdin.emit("data", "1-gdb-ver");
  stdin.emit("data", "sion\n2-ne");
  stdin.emit("data", "xt\n");
  await new Promise((resolve) => setImmediate(resolve));
  expect(written).toEqual([`${fakeGdbVersionStream}1^done\n`]);
  expect(received).toEqual([["2-next\n"], ["2-next\n"]]);
});
