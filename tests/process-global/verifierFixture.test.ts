import { access, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import {
  onceConfirmed,
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
    expect((failure as { cleanupLeases?: unknown[] }).cleanupLeases?.[0]).toBe(
      fixture,
    );
    expect(() => fixture.releaseAfter(() => undefined)).toThrow(
      /already being released/u,
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
  // The failure the caller catches carries the retained fixture itself.
  expect((failure as { cleanupLeases?: unknown[] }).cleanupLeases?.[0]).toBe(
    fixture,
  );
});

it("runs a cleanup shared by two fixtures once it has confirmed", async () => {
  let attempts = 0;
  const closeClient = onceConfirmed(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("client close failed");
  });
  const fixtures = [1, 2].map(
    () =>
      new VerifierFixture({
        path: "/fixture/root",
        close: async () => undefined,
      }),
  );
  for (const fixture of fixtures) fixture.releaseAfter(closeClient);
  await expect(fixtures[0]!.release()).rejects.toBeInstanceOf(AggregateError);
  await fixtures[1]!.release();
  await fixtures[0]!.release();
  // The first failure is retried once; the confirmed close is not repeated.
  expect(attempts).toBe(2);
  expect(fixtures.every((fixture) => fixture.released)).toBe(true);
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

it("keeps a retained root across every release and names why", async () => {
  let closes = 0;
  const fixture = new VerifierFixture({
    path: "/fixture/root",
    close: async () => {
      closes += 1;
    },
  });
  fixture.retain("Command cleanup is incomplete.");
  for (const _attempt of [1, 2]) {
    const failure: unknown = await fixture
      .release()
      .catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(
      ((failure as AggregateError).errors as Error[]).map(
        ({ message }) => message,
      ),
    ).toEqual([
      "Command cleanup is incomplete.",
      "Retained verifier fixture /fixture/root because a cleanup that may still use it did not confirm.",
    ]);
  }
  expect(closes).toBe(0);
  expect(fixture.released).toBe(false);
});

it("keeps an artifact directory, owned by the verifier and named on stderr", async () => {
  const parent = await VerifierFixture.open({ prefix: "rea-fixture-test-" });
  const written: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const artifacts = await VerifierFixture.keepArtifacts({
      prefix: "rea-client-",
      parent: parent.path,
    });
    expect(artifacts.kept).toBe(true);
    expect(artifacts.path.startsWith(join(parent.path, "rea-client-"))).toBe(
      true,
    );
    expect((await stat(artifacts.path)).mode & 0o077).toBe(0);
    expect(written).toEqual([
      `Keeping verifier artifacts at ${artifacts.path}\n`,
    ]);
  } finally {
    process.stderr.write = write;
    await parent.release();
  }
});

it("keeps a root on request after its cleanups confirm, and names it", async () => {
  let closes = 0;
  const order: string[] = [];
  const fixture = new VerifierFixture({
    path: "/fixture/kept",
    close: async () => {
      closes += 1;
    },
  });
  let failing = true;
  fixture.releaseAfter(() => {
    order.push("client");
    if (failing) throw new Error("client did not close");
  });
  const written: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    // An unconfirmed cleanup retains the root as release would.
    await expect(fixture.keep("kept for review")).rejects.toMatchObject({
      cleanupLeases: [fixture],
    });
    expect(written).toEqual([]);
    failing = false;
    await fixture.keep("kept for review");
    expect(written).toEqual([
      "Keeping verifier fixture /fixture/kept: kept for review\n",
    ]);
  } finally {
    process.stderr.write = write;
  }
  expect(order).toEqual(["client", "client"]);
  expect(closes).toBe(0);
  expect(fixture.released).toBe(false);
  expect(() => fixture.releaseAfter(() => undefined)).toThrow(
    /already being released/u,
  );
});

it("closes early resources now and keeps a failed one for release to retry", async () => {
  let closes = 0;
  const fixture = new VerifierFixture({
    path: "/fixture/early",
    close: async () => {
      closes += 1;
    },
  });
  const calls: string[] = [];
  let clientFails = true;
  const failure: unknown = await fixture
    .closeEarly([
      () => {
        calls.push("client");
        if (clientFails) throw new Error("client did not close");
      },
      () => {
        calls.push("transport");
      },
    ])
    .catch((cause: unknown) => cause);
  // Both ran now, in order, and the client's failure is reported.
  expect(calls).toEqual(["client", "transport"]);
  expect(failure).toBeInstanceOf(AggregateError);
  expect(
    ((failure as AggregateError).errors as Error[]).map(
      ({ message }) => message,
    ),
  ).toEqual(["client did not close"]);
  // Release retries only the client and removes the root once it confirms.
  await expect(fixture.release()).rejects.toMatchObject({
    cleanupLeases: [fixture],
  });
  expect(closes).toBe(0);
  clientFails = false;
  await fixture.release();
  expect(calls).toEqual(["client", "transport", "client", "client"]);
  expect(closes).toBe(1);
  expect(fixture.released).toBe(true);
});
