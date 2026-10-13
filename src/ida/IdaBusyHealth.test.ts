import { expect, it } from "vitest";
import type { JsonValue } from "../domain/jsonValue.js";
import type { IdaMcpConnection } from "./IdaMcpConnection.js";
import { readSettledHealth } from "./IdaBusyHealth.js";

const busy = (tool: string): JsonValue => ({
  status: "busy",
  busy_tool: tool,
  busy_sec: 0,
  queued_calls: 0,
});
const ok: JsonValue = { status: "ok", module: "target" };

/** Connection that answers each health read from a script and counts reads. */
const scripted = (answers: readonly JsonValue[]) => {
  const reads: number[] = [];
  const connection: IdaMcpConnection = {
    connect: async () => [],
    serverInfo: () => null,
    close: async () => undefined,
    detach: () => undefined,
    call: async () => {
      reads.push(reads.length);
      const answer = answers[Math.min(reads.length - 1, answers.length - 1)];
      if (answer === undefined) throw new Error("empty script");
      return answer;
    },
  };
  return { connection, reads };
};

/** Virtual clock: sleeping advances time, nothing really waits. */
const virtualClock = (onSleep?: (ms: number) => void) => {
  let time = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    clock: {
      now: () => time,
      delay: async (ms: number) => {
        sleeps.push(ms);
        time += ms;
        onSleep?.(ms);
      },
    },
  };
};

it("sleeps the fixed retry delay between busy reads and returns the settled answer", async () => {
  const { connection, reads } = scripted([busy("a"), busy("a"), ok]);
  const { clock, sleeps } = virtualClock();

  const raw = await readSettledHealth(connection, {
    database: "db",
    timeoutMs: 10_000,
    clock,
  });

  expect(raw, "the settled payload is returned unchanged").toEqual(ok);
  expect(reads.length, "one read per poll").toBe(3);
  expect(sleeps, "two fixed 100 ms pauses").toEqual([100, 100]);
});

it("clamps the last pause to the remaining budget and stops without another read at expiry", async () => {
  const { connection, reads } = scripted([busy("config_json_get")]);
  const { clock, sleeps } = virtualClock();

  const failure = await readSettledHealth(connection, {
    database: "db",
    timeoutMs: 350,
    clock,
  }).catch((cause: unknown) => cause);

  expect(sleeps, "three full pauses, then the 50 ms remainder").toEqual([
    100, 100, 100, 50,
  ]);
  expect(reads.length, "no read is started once the budget is spent").toBe(4);
  expect(failure, "expiry while busy is a timeout").toMatchObject({
    _tag: "AnalysisTimeoutError",
    timeoutMs: 350,
  });
});

it("does not read again when the only pause consumes the whole budget", async () => {
  const { connection, reads } = scripted([busy("config_json_get")]);
  const { clock } = virtualClock();

  const failure = await readSettledHealth(connection, {
    database: "db",
    timeoutMs: 100,
    clock,
  }).catch((cause: unknown) => cause);

  expect(reads.length, "the single read before the pause is the only one").toBe(
    1,
  );
  expect(failure, "the last busy payload ends the wait").toMatchObject({
    _tag: "AnalysisTimeoutError",
  });
});

it("reports the busy tool of the last observation", async () => {
  const { connection } = scripted([busy("first_tool"), busy("last_tool")]);
  const { clock } = virtualClock();

  const failure = await readSettledHealth(connection, {
    database: "db",
    timeoutMs: 150,
    clock,
  }).catch((cause: unknown) => cause);

  expect(failure, "the operation names the tool seen last").toMatchObject({
    operation: "server_health: headless worker still busy in last_tool",
    cause: busy("last_tool"),
  });
});

it("rejects without another read when the signal aborts after the pause has fulfilled", async () => {
  const controller = new AbortController();
  const { connection, reads } = scripted([busy("config_json_get")]);
  const { clock } = virtualClock(() => controller.abort());

  const failure = await readSettledHealth(connection, {
    database: "db",
    timeoutMs: 10_000,
    signal: controller.signal,
    clock,
  }).catch((cause: unknown) => cause);

  expect(reads.length, "the abort wins over the next read").toBe(1);
  expect(failure, "the abort is surfaced, not a timeout").toMatchObject({
    name: "AbortError",
  });
});
