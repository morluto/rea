import { chmod, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { expect, it, onTestFinished } from "vitest";

import { fakeBuildComputers as setUp } from "../../fixtures/fakeAgentEnvComputer.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("joins a start still in progress when the owner closes, and refuses later starts", async () => {
  const { computers, runner, start } = await setUp(
    {},
    { FAKE_DEPLOY_SECONDS: "30" },
  );
  const order: string[] = [];
  const pending = start().then((result) => {
    order.push("start settled");
    return result;
  });
  while ((await runner.notes("runs.jsonl")).length === 0) await delay(50);
  await computers.closeAll();
  order.push("closeAll returned");
  expect(order).toEqual(["start settled", "closeAll returned"]);
  const started = await pending;
  expect(started.ok).toBe(false);
  if (!started.ok) expect(started.error._tag).toBe("AnalysisCancelledError");
  // Shutdown cancelled the deploy, whose own interruption tore it down.
  expect(await runner.notes("interrupted.jsonl")).toHaveLength(1);
  const later = await start();
  expect(later.ok).toBe(false);
  expect(await runner.notes("runs.jsonl")).toHaveLength(1);
});

it("keeps a failed start whose teardown is unconfirmed, so close and shutdown can retry it", async () => {
  const state = await createTestTempDirectory("fake-docker-");
  const down = join(state, "docker-down");
  const docker = join(state, "docker");
  await writeFile(down, "");
  await writeFile(
    docker,
    `#!/bin/sh\n[ -e '${down}' ] && { echo "Cannot connect to the Docker daemon" >&2; exit 1; }\nexit 0\n`,
  );
  await chmod(docker, 0o755);
  const { computers, runner, start } = await setUp(
    { readinessFails: true },
    { FAKE_TEARDOWN_FAILS: "1", REA_DOCKER_COMMAND: docker },
  );
  const started = await start();
  if (started.ok) throw new Error("readiness failed, so the start must fail");
  // The primary failure stays the error; the unconfirmed teardown rides on it.
  expect(started.error.userMessage).toContain("Xvfb exited");
  expect(started.error.cleanupIncomplete).toBe(true);
  expect(started.error.cleanup?.reason).toContain(
    "Cannot connect to the Docker daemon",
  );
  const id = started.error.diagnostics?.computer_id;
  if (typeof id !== "string") throw new Error("the failure names its owner");
  // The retained owner retries the same sandbox; it cannot be driven.
  expect((await computers.close(id)).ok).toBe(false);
  expect(
    (
      await computers.act(
        { computer_id: id, action: "wait" },
        new AbortController().signal,
      )
    ).ok,
  ).toBe(false);
  await rm(down);
  await computers.closeAll();
  expect(await computers.close(id)).toMatchObject({ ok: false });
  expect(await runner.notes("teardowns.jsonl")).toHaveLength(1);
});

it("waits for a command the computer answers after fetch's wait for headers ends", async () => {
  const home = await createTestTempDirectory("fake-exec-home-");
  const { computers, start } = await setUp({ exec: { home, bin: home } });
  onTestFinished(() => computers.closeAll());
  const started = await start();
  if (!started.ok) throw started.error;
  const steps = computers.steps(started.value.value.computer_id);
  if (steps === undefined) throw new Error("the started computer is held");
  // fetch's dispatcher with undici's 300 s wait for headers cut to 200 ms, which fires after about 1 s.
  const key = Symbol.for("undici.globalDispatcher.1");
  const global = globalThis as Record<symbol, unknown>;
  const dispatcher = global[key] as {
    readonly constructor: new (options: object) => unknown;
  };
  global[key] = new dispatcher.constructor({ headersTimeout: 200 });
  try {
    expect(await steps.computer.exec(["sleep", "3"], 10)).toMatchObject({
      exit_code: 0,
      timed_out: false,
    });
  } finally {
    global[key] = dispatcher;
  }
});

it("cancels a call in progress and the one waiting behind it when the owner closes", async () => {
  const app = {
    name: "notes",
    state: {},
    seed: {},
    methods: [],
    unreadyAfterReset: 600,
  };
  const { computers, runner, start } = await setUp({ app });
  const started = await start();
  if (!started.ok) throw started.error;
  const act = (action: "reset" | "screenshot") =>
    computers.act(
      { computer_id: started.value.value.computer_id, action },
      new AbortController().signal,
    );
  const reset = act("reset");
  while (app.methods.length === 0) await delay(50);
  const waiting = act("screenshot");
  await computers.closeAll();
  for (const result of await Promise.all([reset, waiting]))
    expect(result).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCancelledError" },
    });
  expect(await runner.notes("teardowns.jsonl")).toHaveLength(1);
});
