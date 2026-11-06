import { chmod, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { expect, it } from "vitest";

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
