import {
  createGdbFixtureOwner,
  expectGdbSessionStarted,
  expectNoUnmodeledGdbCommands,
  FAKE_GDB_SESSION_REPLIES,
  fakeGdbModeledReplies,
  fakeGdbStartupPreamble,
} from "./gdbTestHelpers.js";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { GdbSessionManager } from "../../../src/gdb/GdbSessionManager.js";
import { awaitAcknowledgement } from "../../fixtures/lifecycleAcknowledgement.js";
import { waitFor } from "../../support/testWait.js";

let directory: string | undefined;
const managers: GdbSessionManager[] = [];
const fixtureOwner = createGdbFixtureOwner();

afterEach(async () => {
  await fixtureOwner.cleanup(managers, async () => {
    if (directory !== undefined)
      await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });
});

it("serializes live commands and keeps cancelled placeholders within the GDB queue limit", async () => {
  directory = await mkdtemp(join(tmpdir(), "rea-gdb-command-queue-limit-"));
  const provider = join(directory, "fake-gdb-queue.mjs");
  const activePath = join(directory, "active-command");
  const releasePath = join(directory, "release-command");
  const unmodeledPath = join(directory, "unmodeled");
  const tracePath = join(directory, "commands");
  const replies = Object.fromEntries(
    ["hold", "first-follower", "second-follower", "after-drain"].map((name) => [
      `-interpreter-exec console "${name}"`,
      "^done",
    ]),
  );
  await writeFile(
    provider,
    `#!${process.execPath}
${fakeGdbStartupPreamble}
${fakeGdbModeledReplies(unmodeledPath, { ...FAKE_GDB_SESSION_REPLIES, ...replies })}
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
const activePath = ${JSON.stringify(activePath)};
const releasePath = ${JSON.stringify(releasePath)};
const tracePath = ${JSON.stringify(tracePath)};
let holding = false;
process.stdout.write("(gdb)\\n");
process.stdin.on("data", (chunk) => {
  for (const line of chunk.split("\\n")) {
    const match = /^(\\d+)(.*)$/.exec(line);
    if (!match) continue;
    const [, token, command] = match;
    if (command.startsWith("-interpreter-exec console "))
      appendFileSync(tracePath, (holding ? "overlap " : "") + command + "\\n");
    if (command === '-interpreter-exec console "hold"') {
      holding = true;
      writeFileSync(activePath, "active");
      const release = setInterval(() => {
        if (!existsSync(releasePath)) return;
        clearInterval(release);
        holding = false;
        answerModeled(token, command);
      }, 10);
    } else answerModeled(token, command);
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
  const {
    value: { session_id: sessionId },
  } = await expectGdbSessionStarted(manager);
  const active = manager.execute(sessionId, "hold");
  const pending: Promise<unknown>[] = [active];
  const contend = async (command: string) => {
    const controller = new AbortController();
    const response = manager.execute(sessionId, command, controller.signal);
    pending.push(response);
    // If the request queued instead of refusing at capacity, cancel it
    // without releasing the active command.
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();
    return response;
  };
  try {
    await awaitAcknowledgement(
      waitFor(async () =>
        expect(await readFile(activePath, "utf8")).toBe("active"),
      ),
      active,
      "held GDB command",
    );
    const controllers = Array.from({ length: 13 }, () => new AbortController());
    const queued = controllers.map((controller, index) =>
      manager.execute(sessionId, `queued-${index}`, controller.signal),
    );
    const followers = ["first-follower", "second-follower"].map((command) =>
      manager.execute(sessionId, command),
    );
    pending.push(...queued, ...followers);
    const constraint = {
      ok: false,
      error: {
        _tag: "AnalysisResourceConstraintError",
        operation: "gdb_console",
        resource: "transport",
        reportedLimits: {
          max_pending_commands: 16,
          active_or_queued_commands: 16,
        },
      },
    };
    expect(await contend("overflow")).toMatchObject(constraint);

    const reason = { source: "cancelled while queued" };
    for (const controller of controllers) controller.abort(reason);
    expect(await Promise.all(queued)).toEqual(
      Array.from({ length: 13 }, () =>
        expect.objectContaining({
          ok: false,
          error: expect.objectContaining({
            _tag: "AnalysisCancelledError",
            cause: reason,
          }),
        }),
      ),
    );
    expect(await contend("overflow-with-cancelled-placeholders")).toMatchObject(
      constraint,
    );

    await writeFile(releasePath, "release");
    expect((await active).ok).toBe(true);
    expect((await Promise.all(followers)).map((result) => result.ok)).toEqual([
      true,
      true,
    ]);
    expect(await manager.execute(sessionId, "after-drain")).toMatchObject({
      ok: true,
      value: { result: { completion_status: "complete" } },
    });
    expect(await readFile(tracePath, "utf8")).toBe(
      [
        '-interpreter-exec console "hold"',
        '-interpreter-exec console "first-follower"',
        '-interpreter-exec console "second-follower"',
        '-interpreter-exec console "after-drain"',
        "",
      ].join("\n"),
    );
    expect(await manager.close(sessionId)).toMatchObject({
      ok: true,
      value: { target_state: "none_observed" },
    });
    expect(manager.status(sessionId)).toBeUndefined();
    await expectNoUnmodeledGdbCommands(unmodeledPath);
  } finally {
    await writeFile(releasePath, "release");
    await Promise.allSettled(pending);
  }
});
