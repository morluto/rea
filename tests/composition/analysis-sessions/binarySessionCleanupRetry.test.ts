import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";

import {
  createAnalysisExecution,
  type AnalysisClient,
} from "../../../src/application/AnalysisProvider.js";
import { HopperStartError } from "../../../src/domain/hopperErrors.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { ProviderCleanupError } from "../../../src/domain/providerCleanupError.js";
import { err, ok as resultOk } from "../../../src/domain/result.js";
import type {
  BridgeLauncher,
  BridgeSession,
} from "../../../src/hopper/BridgeLauncher.js";
import { HopperClient } from "../../../src/hopper/HopperClient.js";
import {
  acquireHopperTargetLease,
  type HopperTargetLease,
} from "../../../src/hopper/HopperTargetLease.js";
import { cleanupOwnedProcessGroup } from "../../../src/process/ProcessOwnership.js";
import { spawnOwnedProviderProcess } from "../../../src/process/ProviderProcess.js";
import { hopperFixturePath } from "../../boundary/providers/hopper/hopperClient.fixture.js";
import { observed as ok } from "../../fixtures/analysisExecution.js";
import {
  createBinarySessionTargets,
  createDeferred,
  createTestBinarySession,
} from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const retryFixture = async (
  execute: AnalysisClient["execute"] = () => Promise.resolve(ok(null)),
) => {
  const parent = await createTestTempDirectory("rea-session-cleanup-retry-");
  const runtime = join(parent, "owned-runtime");
  const document = join(parent, "retained-document");
  await mkdir(runtime);
  await writeFile(join(runtime, "observation"), "owned observation");
  await writeFile(document, "caller-retained document");
  const targets = await createBinarySessionTargets();
  let allowed = false;
  let created = 0;
  const cleanupError = new ProviderCleanupError("fixture", [runtime], {
    reason: "owned runtime removal denied",
    leftover_paths: [runtime],
  });
  const client: AnalysisClient = {
    execute,
    close: async (options) => {
      if (!allowed) return err(cleanupError);
      await rm(runtime, { recursive: true, force: true });
      if (options?.retainDocument !== true) await rm(document, { force: true });
      return resultOk(null);
    },
  };
  const session = createTestBinarySession(() => {
    created += 1;
    return created === 1
      ? client
      : {
          execute: () => Promise.resolve(ok(null)),
          close: () => Promise.resolve(resultOk(null)),
        };
  });
  onTestFinished(async () => {
    allowed = true;
    await session.close();
  });
  return {
    session,
    targets,
    runtime,
    document,
    cleanupError,
    allowCleanup: () => {
      allowed = true;
    },
    created: () => created,
  };
};

it.each(["close", "switch", "open after close"] as const)(
  "retries owned cleanup before completing %s",
  async (transition) => {
    const fixture = await retryFixture();
    const {
      session,
      targets: [first, second],
      runtime,
      cleanupError,
    } = fixture;
    expect((await session.open(first)).ok).toBe(true);
    const attempt = () =>
      transition === "close" ? session.close() : session.open(second);
    const initial =
      transition === "switch" ? await attempt() : await session.close();
    expect(initial).toEqual(err(cleanupError));
    expect(session.activeTarget()).toBeUndefined();
    expect(await session.execute("address_name", {})).toMatchObject({
      ok: false,
    });
    await access(runtime);

    expect(await attempt()).toEqual(err(cleanupError));
    expect(fixture.created()).toBe(1);
    await access(runtime);

    fixture.allowCleanup();
    expect((await attempt()).ok).toBe(true);
    await expect(access(runtime)).rejects.toMatchObject({ code: "ENOENT" });
    expect(fixture.created()).toBe(transition === "close" ? 1 : 2);
  },
);

it("keeps a failed candidate for cleanup and preserves its startup failure", async () => {
  const primary = new HopperStartError();
  const fixture = await retryFixture(() => Promise.resolve(err(primary)));
  const result = await fixture.session.open(fixture.targets[0]);
  expect(result).toMatchObject({
    ok: false,
    error: {
      cleanupIncomplete: true,
      cleanupResources: [fixture.runtime],
      diagnostics: {
        primary_error: projectAnalysisError(primary),
        cleanup_error: projectAnalysisError(fixture.cleanupError),
      },
    },
  });
  expect(fixture.session.activeTarget()).toBeUndefined();
  fixture.allowCleanup();
  expect((await fixture.session.close()).ok).toBe(true);
  await expect(access(fixture.runtime)).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("retains cancelled startup cleanup and the cancellation reason", async () => {
  const controller = new AbortController();
  const fixture = await retryFixture(() => {
    controller.abort();
    return Promise.resolve(ok(null));
  });
  expect(
    await fixture.session.open(fixture.targets[0], {
      signal: controller.signal,
    }),
  ).toMatchObject({
    ok: false,
    error: {
      cleanupIncomplete: true,
      cleanupResources: [fixture.runtime],
      diagnostics: { primary_error: { code: "cancelled" } },
    },
  });
  fixture.allowCleanup();
  expect((await fixture.session.close()).ok).toBe(true);
  await expect(access(fixture.runtime)).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("preserves caller-selected document retention when retrying cleanup", async () => {
  const fixture = await retryFixture();
  expect((await fixture.session.open(fixture.targets[0])).ok).toBe(true);
  expect(
    await fixture.session.close({ retainProviderDocuments: true }),
  ).toEqual(err(fixture.cleanupError));
  fixture.allowCleanup();
  expect((await fixture.session.close()).ok).toBe(true);
  await expect(access(fixture.runtime)).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await readFile(fixture.document, "utf8")).toBe(
    "caller-retained document",
  );
});

it("honors an explicit retention choice on a cleanup retry", async () => {
  const fixture = await retryFixture();
  expect((await fixture.session.open(fixture.targets[0])).ok).toBe(true);
  expect(await fixture.session.close()).toEqual(err(fixture.cleanupError));
  fixture.allowCleanup();
  expect(
    (await fixture.session.close({ retainProviderDocuments: true })).ok,
  ).toBe(true);
  await expect(access(fixture.runtime)).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await readFile(fixture.document, "utf8")).toBe(
    "caller-retained document",
  );
});

it("keeps failed restoration resources available for a close retry", async () => {
  const parent = await createTestTempDirectory("rea-restore-cleanup-retry-");
  const runtime = join(parent, "restore-runtime");
  await mkdir(runtime);
  await writeFile(join(runtime, "observation"), "restore observation");
  const [first, second] = await createBinarySessionTargets();
  let created = 0;
  let allowed = false;
  const session = createTestBinarySession(() => {
    const index = ++created;
    return {
      execute: () =>
        Promise.resolve(index === 1 ? ok(null) : err(new HopperStartError())),
      close: async () => {
        if (index !== 3) return resultOk(null);
        if (!allowed)
          throw new ProviderCleanupError("fixture", [runtime], {
            reason: "restoration cleanup denied",
          });
        await rm(runtime, { recursive: true, force: true });
        return resultOk(null);
      },
    };
  });
  onTestFinished(async () => {
    allowed = true;
    await session.close();
  });
  expect((await session.open(first)).ok).toBe(true);
  expect(await session.open(second)).toMatchObject({
    ok: false,
    error: { cleanupIncomplete: true, cleanupResources: [runtime] },
  });
  expect(session.activeTarget()).toBeUndefined();
  allowed = true;
  expect((await session.close()).ok).toBe(true);
  await expect(access(runtime)).rejects.toMatchObject({ code: "ENOENT" });
});

it("does not start a replacement cancelled while pending cleanup completes", async () => {
  const parent = await createTestTempDirectory("rea-cancel-cleanup-retry-");
  const runtime = join(parent, "owned-runtime");
  await mkdir(runtime);
  await writeFile(join(runtime, "observation"), "owned observation");
  const [first, second] = await createBinarySessionTargets();
  const entered = createDeferred<void>();
  const release = createDeferred<void>();
  let allowed = false;
  let created = 0;
  const session = createTestBinarySession(() => {
    const index = ++created;
    return {
      execute: () => Promise.resolve(ok(null)),
      close: async () => {
        if (index !== 1) return resultOk(null);
        if (!allowed)
          return err(
            new ProviderCleanupError("fixture", [runtime], {
              reason: "cleanup denied",
            }),
          );
        entered.resolve();
        await release.promise;
        await rm(runtime, { recursive: true, force: true });
        return resultOk(null);
      },
    };
  });
  onTestFinished(async () => {
    allowed = true;
    release.resolve();
    await session.close();
  });
  expect((await session.open(first)).ok).toBe(true);
  expect((await session.close()).ok).toBe(false);
  allowed = true;
  const controller = new AbortController();
  const opening = session.open(second, { signal: controller.signal });
  await entered.promise;
  controller.abort();
  release.resolve();
  expect(await opening).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisCancelledError" },
  });
  expect(created).toBe(1);
  await expect(access(runtime)).rejects.toMatchObject({ code: "ENOENT" });
});

class RetryingHopperLauncher implements BridgeLauncher {
  cleanupAllowed = false;
  cleanupAttempts = 0;
  directory: string | undefined;
  lease: HopperTargetLease | undefined;

  constructor(
    readonly leaseDirectory: string,
    readonly targetPath: string,
    readonly cleanupRequired = false,
  ) {}

  acquire(runId: string) {
    return acquireHopperTargetLease({
      targetPath: this.targetPath,
      targetKind: "database",
      loaderArgs: [],
      runId,
      directory: this.leaseDirectory,
    });
  }

  async launch(session: BridgeSession) {
    const lease = await this.acquire(session.runId);
    if (!lease.acquired)
      return err(
        new HopperStartError({ userMessage: "fixture lease is held" }),
      );
    this.lease = lease.lease;
    this.directory = session.directory;
    const started = await spawnOwnedProviderProcess({
      command: process.execPath,
      arguments: [
        hopperFixturePath,
        session.socketPath,
        session.token,
        session.runId,
        this.cleanupRequired ? "cleanup-required" : "acknowledge",
      ],
      runId: session.runId,
      expectedCommand: null,
    });
    return resultOk({
      ...started,
      ownsProcessLifetime: true as const,
      providerLifetime: "launcher-process" as const,
      shutdownMode: "process-cleanup" as const,
      cleanup: () => {
        this.cleanupAttempts += 1;
        return this.cleanupAllowed
          ? cleanupOwnedProcessGroup(started.ownership)
          : Promise.resolve({
              cleaned: false as const,
              reason: "fixture process cleanup not confirmed",
            });
      },
      releaseLease: () => lease.lease.release(),
    });
  }
}

it("retains Hopper process handles, private files, and lease until an actual session cleanup retry succeeds", async () => {
  const leaseDirectory = await mkdtemp("/tmp/rea-hl-");
  onTestFinished(() => rm(leaseDirectory, { recursive: true, force: true }));
  const [first, second] = await createBinarySessionTargets();
  const launcher = new RetryingHopperLauncher(leaseDirectory, first);
  const hopper = new HopperClient({ launcher, startupTimeoutMs: 10_000 });
  let clientsCreated = 0;
  const session = createTestBinarySession(() => {
    clientsCreated += 1;
    return {
      execute: async () => {
        const started = await hopper.start();
        return started.ok
          ? resultOk(
              createAnalysisExecution(null, {
                id: "hopper",
                name: "fixture Hopper",
                version: null,
              }),
            )
          : started;
      },
      close: (options) => hopper.close(options),
    };
  });
  onTestFinished(async () => {
    launcher.cleanupAllowed = true;
    await session.close();
    await hopper.close();
    await launcher.lease?.release();
  });
  expect(await session.open(first)).toMatchObject({ ok: true });
  expect(await session.close()).toMatchObject({
    ok: false,
    error: { cleanupIncomplete: true },
  });
  const runtime = launcher.directory;
  if (runtime === undefined)
    throw new Error("Fixture did not capture its runtime");
  await access(runtime);
  expect(launcher.cleanupAttempts).toBe(1);
  expect(await launcher.acquire("other-owner")).toMatchObject({
    acquired: false,
  });
  expect(await session.open(second)).toMatchObject({
    ok: false,
    error: { cleanupIncomplete: true },
  });
  expect(clientsCreated).toBe(1);
  expect(launcher.cleanupAttempts).toBe(2);
  launcher.cleanupAllowed = true;
  expect(await session.close()).toEqual(resultOk(null));
  expect(launcher.cleanupAttempts).toBe(3);
  await expect(access(runtime)).rejects.toMatchObject({ code: "ENOENT" });
  const replacement = await launcher.acquire("replacement-owner");
  expect(replacement.acquired).toBe(true);
  if (replacement.acquired) await replacement.lease.release();
  expect((await session.open(second)).ok).toBe(true);
  expect(clientsCreated).toBe(2);
});

it("reports a direct Hopper close failure and retries the retained owned process", async () => {
  const leaseDirectory = await mkdtemp("/tmp/rea-hl-");
  onTestFinished(() => rm(leaseDirectory, { recursive: true, force: true }));
  const [target] = await createBinarySessionTargets();
  const launcher = new RetryingHopperLauncher(leaseDirectory, target, true);
  const hopper = new HopperClient({ launcher, startupTimeoutMs: 10_000 });
  onTestFinished(async () => {
    launcher.cleanupAllowed = true;
    await hopper.close();
    await launcher.lease?.release();
  });
  expect(await hopper.start()).toMatchObject({ ok: true });
  expect(await hopper.close()).toMatchObject({
    ok: false,
    error: { cleanupIncomplete: true },
  });
  expect(launcher.cleanupAttempts).toBe(1);
  launcher.cleanupAllowed = true;
  expect(await hopper.close()).toEqual(resultOk(null));
  expect(launcher.cleanupAttempts).toBe(2);
});
