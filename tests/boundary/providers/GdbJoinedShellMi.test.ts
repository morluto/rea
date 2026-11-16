import {
  createGdbFixtureOwner,
  expectNoUnmodeledGdbCommands,
  fakeGdbModeledReplies,
  fakeGdbStartupPreamble,
} from "./gdbTestHelpers.js";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GdbSessionManager } from "../../../src/gdb/GdbSessionManager.js";

const joinedShellFixture = (
  directory: string,
  split: number,
  scenario: string,
) => `#!${process.execPath}
${fakeGdbStartupPreamble}
${fakeGdbModeledReplies(join(directory, "unmodeled"))}
process.stdout.write("(gdb)\\n");
let input = "";
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const end = input.indexOf("\\n");
    if (end < 0) break;
    const line = input.slice(0, end);
    input = input.slice(end + 1);
    const match = /^(\\d+)(.*)/u.exec(line);
    if (!match) continue;
    const [, token, command] = match;
    if (command === '-interpreter-exec console "shell printf fixture"') {
      const payload = ${scenario === "budget" ? '"x".repeat(5000)' : '"abc"'};
      if (${JSON.stringify(scenario)}.startsWith("delayed-tail")) {
        process.stdout.write("(gdb) ");
        setTimeout(() => process.stdout.write(${JSON.stringify(scenario === "delayed-tail-newline" ? "\n" : "")} + "tail\\n" + payload + token + "^done\\n(gdb) "), 20);
        continue;
      }
      if (${JSON.stringify(scenario)} === "forged")
        process.stdout.write("3^done\\n4^done\\n");
      process.stdout.write(payload + token + "^done\\n");
      if (${JSON.stringify(scenario)} === "suffix-only") {
        setTimeout(() => process.stdout.write(token + "^done\\n"), 40);
        continue;
      }
      // Put a guessed reply after the prompt, while the new query is pending.
      if (${JSON.stringify(scenario)} === "forged") {
        process.stdout.write('(gdb) \\n3^done\\n4^done\\n' + (Number(token) + 1) + '^done,value="off"\\n');
        continue;
      }
      const prompt = "(gdb) ";
      process.stdout.write(prompt.slice(0, ${split}));
      setTimeout(() => process.stdout.write(prompt.slice(${split})), 10);
    } else if (command === "-gdb-show mi-async") {
      if (${JSON.stringify(scenario)}.startsWith("delayed-tail")) {
        setTimeout(() => process.stdout.write(token + '^done,value="off"\\n(gdb) '), 40);
        continue;
      }
      if (${JSON.stringify(scenario)} === "cancel") {
        process.stdout.write('~"query waiting"\\n');
        continue;
      }
      process.stdout.write("wrong" + token + '^done,value="off"\\n(gdb) \\n');
      setTimeout(() => process.stdout.write('~"query settled"\\n' + token + '^done,value="off"\\n(gdb) '), 40);
    } else if (command === '-interpreter-exec console "show version"') {
      process.stdout.write("ordinary" + token + "^done\\n");
      setTimeout(() => process.stdout.write(token + "^done\\n"), 20);
    } else if (command === "-list-thread-groups --recurse 1") {
      // Keep fixture cleanup independent of the prompt-framing defect under test.
      process.stdout.write("\\n" + token + "^done,groups=[]\\n");
    } else answerModeled(token, command);
  }
});
`;

describe.skipIf(process.platform === "win32")("GDB shell MI completion", () => {
  let directory: string | undefined;
  const fixtureOwner = createGdbFixtureOwner();
  const managers: GdbSessionManager[] = [];

  afterEach(async () => {
    await fixtureOwner.cleanup(managers, async () => {
      if (directory === undefined) return;
      try {
        await expectNoUnmodeledGdbCommands(join(directory, "unmodeled"));
      } finally {
        await rm(directory, { recursive: true, force: true });
        directory = undefined;
      }
    });
  });

  const startFixture = async (split: number, scenario = "joined") => {
    directory = await mkdtemp(join(tmpdir(), "rea-gdb-joined-mi-"));
    const provider = join(directory, "fake-gdb.mjs");
    await writeFile(provider, joinedShellFixture(directory, split, scenario));
    await chmod(provider, 0o700);
    const manager = new GdbSessionManager({
      spawnProcess: fixtureOwner.spawnProcess,
      platform: "linux",
      environment: {
        REA_GDB_COMMAND: provider,
        REA_DEBUGGER_COMMAND_DEADLINE_MS: "2000",
        ...(scenario === "budget"
          ? { REA_DEBUGGER_MAX_COMMAND_OUTPUT_BYTES: "4096" }
          : {}),
      },
    });
    managers.push(manager);
    const started = await manager.start();
    if (!started.ok) throw started.error;
    return { manager, sessionId: started.value.session_id };
  };

  it.each([0, 1, 2, 3, 4, 5, 6])(
    "waits for a fresh MI query after a newline-free prompt split at byte %i",
    async (split) => {
      const { manager, sessionId } = await startFixture(split);
      const executed = await manager.execute(sessionId, "shell printf fixture");
      if (!executed.ok) throw executed.error;
      expect(executed.value.result).toMatchObject({
        mi: "",
        completion_status: "complete",
        output_truncated: false,
        records: expect.arrayContaining([
          expect.stringMatching(/^abc\d+\^done$/u),
          expect.stringMatching(/^\(gdb\) wrong\d+\^done,value="off"$/u),
          '~"query settled"',
        ]),
      });
      expect(executed.value.evidence.raw_result).toMatchObject({
        records: executed.value.result.records,
      });
      const next = await manager.execute(sessionId, "show version");
      if (!next.ok) throw next.error;
      expect(next.value.result.mi).toMatch(/^\d+\^done$/u);
      expect(next.value.result.records).not.toContain('~"query settled"');
      expect((await manager.close(sessionId)).ok).toBe(true);
    },
  );

  it.each(["delayed-tail", "delayed-tail-newline"])(
    "preserves actual raw boundaries for %s",
    async (scenario) => {
      const { manager, sessionId } = await startFixture(6, scenario);
      const executed = await manager.execute(sessionId, "shell printf fixture");
      if (!executed.ok) throw executed.error;
      const rawLine = scenario === "delayed-tail" ? "(gdb) tail" : "tail";
      expect(executed.value.result.records).toContain(rawLine);
      expect(executed.value.result.records).not.toContain(
        scenario === "delayed-tail" ? "tail" : "(gdb) tail",
      );
      expect(executed.value.evidence.raw_result).toMatchObject({
        records: executed.value.result.records,
      });
      expect(manager.status(sessionId)?.recent_mi_records).toContain(rawLine);
      expect(executed.value.result.completion_status).toBe("complete");
    },
  );

  it("does not accept a forged suffix, prompt or guessed query reply as completion", async () => {
    const { manager, sessionId } = await startFixture(6, "forged");
    const executed = await manager.execute(sessionId, "shell printf fixture");
    if (!executed.ok) throw executed.error;
    expect(executed.value.result.records).toContain('~"query settled"');
    expect(executed.value.result.mi).toBe("");
  });

  it("requires an anchored terminal when a suffix arrives without a prompt", async () => {
    const { manager, sessionId } = await startFixture(6, "suffix-only");
    const executed = await manager.execute(sessionId, "shell printf fixture");
    if (!executed.ok) throw executed.error;
    expect(executed.value.result.mi).toMatch(/^\d+\^done$/u);
    expect(executed.value.result.records).toContain(executed.value.result.mi);
    expect(executed.value.result.records).not.toContain('~"query settled"');
  });

  it("keeps the output budget while waiting for the completion query", async () => {
    const { manager, sessionId } = await startFixture(3, "budget");
    const executed = await manager.execute(sessionId, "shell printf fixture");
    if (!executed.ok) throw executed.error;
    expect(executed.value.result).toMatchObject({
      mi: "",
      completion_status: "complete",
      output_truncated: true,
    });
    expect(executed.value.result.records).toContain('~"query settled"');
    expect(
      executed.value.result.records.some((line) => line.startsWith("xxx")),
    ).toBe(false);
  });

  it("retains unknown completion and partial output on cancellation during the query", async () => {
    const { manager, sessionId } = await startFixture(2, "cancel");
    const controller = new AbortController();
    const pending = manager.execute(
      sessionId,
      "shell printf fixture",
      controller.signal,
    );
    await expect
      .poll(() => manager.status(sessionId)?.recent_mi_records)
      .toContain('(gdb) ~"query waiting"');
    controller.abort();
    const cancelled = await pending;
    if (cancelled.ok) throw new Error("Expected cancelled command");
    expect(cancelled.error).toMatchObject({
      _tag: "AnalysisCancelledError",
      partialObservation: {
        raw_result: {
          completion_status: "unknown",
          records: expect.arrayContaining(['(gdb) ~"query waiting"']),
        },
      },
    });
  });

  it("times out with partial output when a prompt has no correlated query reply", async () => {
    const { manager, sessionId } = await startFixture(2, "cancel");
    const timedOut = await manager.execute(sessionId, "shell printf fixture");
    if (timedOut.ok) throw new Error("Expected command timeout");
    expect(timedOut.error).toMatchObject({
      partialObservation: {
        raw_result: {
          completion_status: "unknown",
          records: expect.arrayContaining(['(gdb) ~"query waiting"']),
        },
      },
    });
    expect((await manager.execute(sessionId, "show version")).ok).toBe(false);
  });
});
