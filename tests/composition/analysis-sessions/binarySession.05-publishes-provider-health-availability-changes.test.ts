import { describe, expect, it } from "vitest";

import { ProviderAdapterError } from "../../../src/domain/errors.js";
import { err } from "../../../src/domain/result.js";
import {
  createBinarySessionTargets,
  createCacheProvider,
  createTestBinarySession,
} from "../../fixtures/binarySession.js";
import { observed as ok } from "../../fixtures/analysisExecution.js";

describe("binary session", () => {
  it("publishes provider-health availability changes and resets on target switch", async () => {
    const [first, second] = await createBinarySessionTargets();
    const provider = createCacheProvider([]);
    provider.createClient = () => ({
      execute: (operation) =>
        Promise.resolve(
          operation === "health"
            ? ok(null)
            : err(new ProviderAdapterError("fixture", operation)),
        ),
      close: () => Promise.resolve(),
    });
    const session = createTestBinarySession(provider);
    let changes = 0;
    session.onAvailabilityChanged(() => {
      changes += 1;
    });
    expect((await session.open(first)).ok).toBe(true);
    expect((await session.execute("address_name", {})).ok).toBe(false);
    expect(session.status()).toMatchObject({
      capabilities: expect.arrayContaining([
        expect.objectContaining({
          operation: "address_name",
          available: false,
          reason: "Provider became unavailable during this session.",
        }),
      ]),
    });
    expect(changes).toBe(1);
    expect((await session.open(second)).ok).toBe(true);
    expect(session.status()).toMatchObject({
      capabilities: expect.arrayContaining([
        expect.objectContaining({
          operation: "address_name",
          available: true,
          reason: null,
        }),
      ]),
    });
    expect(changes).toBe(2);
  });

  it("isolates availability observers from execution results and session state", async () => {
    const [first] = await createBinarySessionTargets();
    const provider = createCacheProvider([]);
    let providerCalls = 0;
    provider.createClient = () => ({
      execute: (operation) => {
        if (operation === "health") return Promise.resolve(ok(null));
        providerCalls += 1;
        return Promise.resolve(
          providerCalls === 1
            ? err(new ProviderAdapterError("fixture", operation))
            : ok(operation),
        );
      },
      close: () => Promise.resolve(),
    });
    const session = createTestBinarySession(provider);
    expect((await session.open(first)).ok).toBe(true);
    const input = { address: "0x1000", document: "first" };
    expect((await session.execute("address_name", input)).ok).toBe(false);

    session.onAvailabilityChanged(() => {
      throw new Error("external observer failed");
    });
    session.onAvailabilityChanged(() =>
      Promise.reject(new Error("async external observer failed")),
    );
    let delivered = 0;
    session.onAvailabilityChanged(() => {
      delivered += 1;
    });

    await expect(session.execute("address_name", input)).resolves.toMatchObject(
      { ok: true },
    );
    expect(delivered).toBe(1);
    expect(session.status()).toMatchObject({
      capabilities: expect.arrayContaining([
        expect.objectContaining({
          operation: "address_name",
          available: true,
          reason: null,
        }),
      ]),
    });
    expect((await session.execute("address_name", input)).ok).toBe(true);
    expect(providerCalls).toBe(2);
  });

  it("does not replay operations with filesystem side effects", async () => {
    const [first] = await createBinarySessionTargets();
    const calls: string[] = [];
    const session = createTestBinarySession(createCacheProvider(calls, true));
    expect((await session.open(first)).ok).toBe(true);
    const input = { address: "0x1000", document: "first" };
    expect((await session.execute("address_name", input)).ok).toBe(true);
    expect((await session.execute("address_name", input)).ok).toBe(true);
    expect(calls).toEqual(["health", "address_name", "address_name"]);
    await session.close();
  });
});
