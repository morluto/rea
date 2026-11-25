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

const consoleLine = (name: string) => `-interpreter-exec console "${name}"`;

const makeQueueProvider = async (directory: string) => {
  const provider = join(directory, "fake-gdb-queue.mjs");
  const activePath = join(directory, "active-command");
  const releasePaths = {
    hold: join(directory, "release-hold"),
    follower: join(directory, "release-follower"),
  };
  const unmodeledPath = join(directory, "unmodeled");
  const tracePath = join(directory, "commands");
  const replies = Object.fromEntries(
    ["hold", "first-follower", "second-follower", "after-drain"].map((name) => [
      consoleLine(name),
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
const gates = new Map(${JSON.stringify([
      [consoleLine("hold"), releasePaths.hold],
      [consoleLine("first-follower"), releasePaths.follower],
    ])});
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
    const releasePath = gates.get(command);
    if (releasePath !== undefined) {
      holding = true;
      writeFileSync(activePath, command);
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
  return { provider, activePath, releasePaths, unmodeledPath, tracePath };
};

it("serializes live commands and keeps cancelled placeholders within the GDB queue limit", async () => {
  directory = await mkdtemp(join(tmpdir(), "rea-gdb-command-queue-limit-"));
  const { provider, activePath, releasePaths, unmodeledPath, tracePath } =
    await makeQueueProvider(directory);
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
  const awaitHeld = (command: string, operation: Promise<unknown>) =>
    awaitAcknowledgement(
      waitFor(async () =>
        expect(await readFile(activePath, "utf8")).toBe(consoleLine(command)),
      ),
      operation,
      `held GDB command ${command}`,
    );
  const trace = async () =>
    (await readFile(tracePath, "utf8")).trimEnd().split("\n");
  const expectedTrace = [
    "hold",
    "first-follower",
    "second-follower",
    "after-drain",
  ].map(consoleLine);

  try {
    await awaitHeld("hold", active);
    const controllers = Array.from({ length: 13 }, () => new AbortController());
    const queued = controllers.map((controller, index) =>
      manager.execute(sessionId, `queued-${index}`, controller.signal),
    );
    const first = manager.execute(sessionId, "first-follower");
    const second = manager.execute(sessionId, "second-follower");
    pending.push(...queued, first, second);
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

    await writeFile(releasePaths.hold, "");
    expect((await active).ok).toBe(true);
    await awaitHeld("first-follower", first);
    expect(await trace()).toEqual(expectedTrace.slice(0, 2));
    await writeFile(releasePaths.follower, "");
    expect(
      (await Promise.all([first, second])).map((result) => result.ok),
    ).toEqual([true, true]);
    expect(await manager.execute(sessionId, "after-drain")).toMatchObject({
      ok: true,
      value: { result: { completion_status: "complete" } },
    });
    expect(await trace()).toEqual(expectedTrace);
    expect(await manager.close(sessionId)).toMatchObject({
      ok: true,
      value: { target_state: "none_observed" },
    });
    expect(manager.status(sessionId)).toBeUndefined();
    await expectNoUnmodeledGdbCommands(unmodeledPath);
  } finally {
    try {
      await Promise.all(
        Object.values(releasePaths).map((path) => writeFile(path, "")),
      );
    } finally {
      await Promise.allSettled(pending);
    }
  }
});
