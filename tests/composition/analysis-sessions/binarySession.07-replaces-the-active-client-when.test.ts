import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import type { AnalysisClient } from "../../../src/application/AnalysisProvider.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { HopperStartError } from "../../../src/domain/errors.js";
import { err } from "../../../src/domain/result.js";
import { observed as ok } from "../../fixtures/analysisExecution.js";

class TestClient implements AnalysisClient {
  closed = 0;
  constructor(
    readonly pendingHealth?: Promise<ReturnType<typeof ok>>,
    readonly failHealth = false,
    readonly pendingCall?: Promise<ReturnType<typeof ok>>,
  ) {}
  execute(name: string) {
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
  const directory = await createTestTempDirectory("bb-session-");
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

describe("binary session", () => {
  it("replaces the active client when a canonical path changes contents", async () => {
    const directory = await createTestTempDirectory("bb-session-");
    const path = join(directory, "mutable.hop");
    await writeFile(path, "one");
    const clients: Array<{
      readonly targetSha256: string;
      readonly calls: string[];
      closed: number;
    }> = [];
    const session = createTestBinarySession((target) => {
      const state = {
        targetSha256: target.sha256,
        calls: [] as string[],
        closed: 0,
      };
      clients.push(state);
      return {
        execute: (operation) => {
          state.calls.push(operation);
          return Promise.resolve(
            ok(operation === "health" ? null : target.sha256),
          );
        },
        close: () => {
          state.closed += 1;
          return Promise.resolve();
        },
      };
    });

    const first = await session.open(path);
    expect(first.ok).toBe(true);
    await writeFile(path, "two");
    const second = await session.open(path);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(second.value.sha256).not.toBe(first.value.sha256);
    expect(session.activeTarget()?.sha256).toBe(second.value.sha256);
    expect(await session.execute("binary_overview", {})).toMatchObject({
      ok: true,
      value: { result: second.value.sha256 },
    });
    expect(clients).toMatchObject([
      {
        targetSha256: first.value.sha256,
        calls: ["health"],
        closed: 1,
      },
      {
        targetSha256: second.value.sha256,
        calls: ["health", "binary_overview"],
        closed: 0,
      },
    ]);
    await session.close();
  });

  it("waits for an active call before closing its client during a switch", async () => {
    const [first, second] = await targets();
    const active = deferred<ReturnType<typeof ok>>();
    const clients: TestClient[] = [];
    const session = createTestBinarySession(() => {
      const value = new TestClient(
        undefined,
        false,
        clients.length === 0 ? active.promise : undefined,
      );
      clients.push(value);
      return value;
    });
    await session.open(first);
    const call = session.execute("procedure_pseudo_code", {});
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
    const health = deferred<ReturnType<typeof ok>>();
    let created = 0;
    const session = createTestBinarySession(() => {
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
    if (!result.ok) expect(result.error._tag).toBe("AnalysisCancelledError");
    expect(created).toBe(1);
  });
});
