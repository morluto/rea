import { access, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import {
  VerifierFixture,
  withVerifierFixture,
} from "../../scripts/lib/verifier-fixture.mjs";

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

it("removes a private root only after every registered cleanup confirms, in order", async () => {
  const fixture = await VerifierFixture.open({ prefix: "rea-fixture-test-" });
  const order: string[] = [];
  try {
    expect((await stat(fixture.path)).mode & 0o077).toBe(0);
    fixture.releaseAfter(async () => {
      order.push("client");
      expect(await exists(fixture.path)).toBe(true);
    });
    fixture.releaseAfter(async () => {
      order.push("transport");
      expect(await exists(fixture.path)).toBe(true);
    });
    await fixture.release();
    expect(order).toEqual(["client", "transport"]);
    expect(fixture.released).toBe(true);
    expect(await exists(fixture.path)).toBe(false);
  } finally {
    await fixture.release().catch(() => undefined);
  }
});

it("retains the root when a cleanup fails and retries only that cleanup", async () => {
  const fixture = await VerifierFixture.open({ prefix: "rea-fixture-test-" });
  await writeFile(join(fixture.path, "evidence"), "retained");
  const clientFailure = new Error("client close failed");
  const order: string[] = [];
  let clientFails = true;
  fixture.releaseAfter(async () => {
    order.push("client");
    if (clientFails) throw clientFailure;
  });
  fixture.releaseAfter(async () => {
    order.push("transport");
  });
  try {
    const failure: unknown = await fixture
      .release()
      .catch((cause: unknown) => cause);
    // The later cleanup is still attempted; the root is not removed.
    expect(order).toEqual(["client", "transport"]);
    expect(failure).toBeInstanceOf(AggregateError);
    const errors = (failure as AggregateError).errors as Error[];
    expect(errors[0]).toBe(clientFailure);
    expect(errors[1]?.message).toContain(
      `Retained verifier fixture ${fixture.path}`,
    );
    expect(fixture.released).toBe(false);
    expect(await exists(join(fixture.path, "evidence"))).toBe(true);
    // Whoever holds the failure holds the fixture as its cleanup lease.
    expect((failure as { cleanupLeases?: unknown[] }).cleanupLeases?.[0]).toBe(
      fixture,
    );
    clientFails = false;
    await fixture.release();
    expect(order).toEqual(["client", "transport", "client"]);
    expect(await exists(fixture.path)).toBe(false);
  } finally {
    clientFails = false;
    await fixture.release().catch(() => undefined);
  }
});

it("reports a failed root removal with its path and removes it on retry", async () => {
  const removal = new Error("controlled root removal failure");
  let attempts = 0;
  const fixture = new VerifierFixture({
    path: "/fixture/root",
    close: async () => {
      attempts += 1;
      if (attempts === 1) throw removal;
    },
  });
  const failure: unknown = await fixture
    .release()
    .catch((cause: unknown) => cause);
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors).toEqual([
    removal,
    new Error("Retained verifier fixture /fixture/root."),
  ]);
  expect(fixture.released).toBe(false);
  await fixture.release();
  expect(fixture.released).toBe(true);
  expect(attempts).toBe(2);
});

it("shares one concurrent release and refuses late registration", async () => {
  let closes = 0;
  const fixture = new VerifierFixture({
    path: "/fixture/root",
    close: async () => {
      closes += 1;
    },
  });
  const first = fixture.release();
  expect(() => fixture.releaseAfter(async () => undefined)).toThrow(
    /already being released/u,
  );
  await Promise.all([first, fixture.release()]);
  expect(closes).toBe(1);
});

it("keeps the verification failure and the cleanup failure", async () => {
  const primary = new Error("verification failed");
  const cleanup = new Error("command cleanup failed");
  const fixture = new VerifierFixture({
    path: "/fixture/root",
    close: async () => undefined,
  });
  fixture.releaseAfter(() => Promise.reject(cleanup));
  const failure: unknown = await withVerifierFixture(fixture, () => {
    throw primary;
  }).catch((cause: unknown) => cause);
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).cause).toBe(primary);
  const [first, retained] = (failure as AggregateError).errors as [
    Error,
    AggregateError,
  ];
  expect(first).toBe(primary);
  expect(retained.errors[0]).toBe(cleanup);
  expect(fixture.released).toBe(false);
});

it("allocates a plain temporary directory for child scratch space", async () => {
  const fixture = await VerifierFixture.open({
    prefix: "rea-fixture-scratch-",
    private: false,
  });
  expect(await exists(fixture.path)).toBe(true);
  await fixture.release();
  expect(await exists(fixture.path)).toBe(false);
});
