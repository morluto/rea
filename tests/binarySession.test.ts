import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  BinarySession,
  type BinaryClient,
} from "../src/application/BinarySession.js";
import { HopperStartError } from "../src/domain/errors.js";
import { err, ok } from "../src/domain/result.js";

let directory: string | undefined;
afterEach(async () => {
  if (directory !== undefined)
    await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("binary session", () => {
  it("requires an open binary and closes idempotently", async () => {
    const session = new BinarySession(() => client());
    expect((await session.callTool("binary_overview", {})).ok).toBe(false);
    expect(await session.close()).toEqual({ ok: true, value: null });
  });

  it("keeps the active client when a switch fails", async () => {
    directory = await mkdtemp(join(tmpdir(), "bb-session-"));
    const first = join(directory, "first.hop");
    const second = join(directory, "second.hop");
    await writeFile(first, "one");
    await writeFile(second, "two");
    let created = 0;
    const session = new BinarySession(() => client(created++ === 1));
    expect((await session.open(first)).ok).toBe(true);
    expect((await session.open(second)).ok).toBe(false);
    expect(session.status()).toMatchObject({ open: true });
    expect(JSON.stringify(session.status())).toContain("first.hop");
    expect(created).toBe(2);
  });

  it("serializes concurrent opens and leaves the last target active", async () => {
    const [first, second] = await targets();
    const clients: TestClient[] = [];
    const session = new BinarySession(() => {
      const value = new TestClient();
      clients.push(value);
      return value;
    });
    const one = session.open(first);
    const two = session.open(second);
    expect((await one).ok).toBe(true);
    expect((await two).ok).toBe(true);
    expect(session.status()).toMatchObject({ open: true });
    expect(JSON.stringify(session.status())).toContain("second.hop");
    expect(clients[0]?.closed).toBe(1);
  });

  it("waits for an active call before closing its client during a switch", async () => {
    const [first, second] = await targets();
    const active = deferred<ReturnType<typeof ok<null>>>();
    const clients: TestClient[] = [];
    const session = new BinarySession(() => {
      const value = new TestClient(
        undefined,
        false,
        clients.length === 0 ? active.promise : undefined,
      );
      clients.push(value);
      return value;
    });
    await session.open(first);
    const call = session.callTool("long", {});
    const switching = session.open(second);
    await Promise.resolve();
    expect(clients[0]?.closed).toBe(0);
    active.resolve(ok(null));
    await call;
    await switching;
    expect(clients[0]?.closed).toBe(1);
  });

  it("cancels an open queued behind another transition without creating a client", async () => {
    const [first, second] = await targets();
    const health = deferred<ReturnType<typeof ok<null>>>();
    let created = 0;
    const session = new BinarySession(() => {
      created += 1;
      return new TestClient(created === 1 ? health.promise : undefined);
    });
    const opening = session.open(first);
    const controller = new AbortController();
    const queued = session.open(second, { signal: controller.signal });
    controller.abort();
    health.resolve(ok(null));
    await opening;
    const result = await queued;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error._tag).toBe("HopperCancelledError");
    expect(created).toBe(1);
  });

  it("cancels a call while it waits for a transition", async () => {
    const [first] = await targets();
    const health = deferred<ReturnType<typeof ok<null>>>();
    const session = new BinarySession(() => new TestClient(health.promise));
    const opening = session.open(first);
    const controller = new AbortController();
    const call = session.callTool(
      "overview",
      {},
      { signal: controller.signal },
    );
    controller.abort();
    const result = await call;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error._tag).toBe("HopperCancelledError");
    health.resolve(ok(null));
    await opening;
  });

  it("closes a failed candidate and preserves the previous target", async () => {
    const [first, second] = await targets();
    const clients: TestClient[] = [];
    const session = new BinarySession(() => {
      const value = new TestClient(undefined, clients.length === 1);
      clients.push(value);
      return value;
    });
    await session.open(first);
    await session.open(second);
    expect(clients[1]?.closed).toBe(1);
    expect(clients[0]?.closed).toBe(0);
    expect(JSON.stringify(session.status())).toContain("first.hop");
    await session.close();
    await session.close();
    expect(clients[0]?.closed).toBe(1);
  });
});

const client = (fail = false): BinaryClient => ({
  callTool: () =>
    Promise.resolve(fail ? err(new HopperStartError()) : ok(null)),
  close: () => Promise.resolve(),
});

class TestClient implements BinaryClient {
  closed = 0;
  constructor(
    readonly pendingHealth?: Promise<ReturnType<typeof ok<null>>>,
    readonly failHealth = false,
    readonly pendingCall?: Promise<ReturnType<typeof ok<null>>>,
  ) {}
  callTool(name: string) {
    if (name === "health")
      return this.failHealth
        ? Promise.resolve(err(new HopperStartError()))
        : (this.pendingHealth ?? Promise.resolve(ok(null)));
    return this.pendingCall ?? Promise.resolve(ok(null));
  }
  close(): Promise<void> {
    this.closed += 1;
    return Promise.resolve();
  }
}

const targets = async (): Promise<readonly [string, string]> => {
  directory ??= await mkdtemp(join(tmpdir(), "bb-session-"));
  const first = join(directory, "first.hop");
  const second = join(directory, "second.hop");
  await writeFile(first, "one");
  await writeFile(second, "two");
  return [first, second];
};

const deferred = <T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} => {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      resolvePromise?.(value);
    },
  };
};
