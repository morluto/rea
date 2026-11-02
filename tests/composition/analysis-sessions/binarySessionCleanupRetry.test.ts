import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";

import {
  AnalysisCleanupLease,
  AnalysisCleanupLeaseGroup,
} from "../../../src/artifacts/AnalysisCleanupLease.js";
import type {
  AnalysisClient,
  AnalysisProvider,
} from "../../../src/application/AnalysisProvider.js";
import { HopperStartError } from "../../../src/domain/hopperErrors.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { ProviderCleanupError } from "../../../src/domain/providerCleanupError.js";
import { err, ok as resultOk } from "../../../src/domain/result.js";
import { observed as ok } from "../../fixtures/analysisExecution.js";
import {
  createBinarySessionTargets,
  createCacheProvider,
  createDeferred,
  createTestBinarySession,
} from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const CLOSE_RETRY = { operation: "close_binary" } as const;

const retryFixture = async (
  execute: AnalysisClient["execute"] = () => Promise.resolve(ok(null)),
  onClose?: () => void,
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
  const runIds: string[] = [];
  const cleanupError = new ProviderCleanupError("fixture", [runtime], {
    reason: "owned runtime removal denied",
    leftover_paths: [runtime],
  });
  const cleanupLease = new AnalysisCleanupLease(
    () => rm(runtime, { recursive: true, force: true }),
    [runtime],
  );
  new AnalysisCleanupLeaseGroup(cleanupError, [cleanupLease]);
  const client: AnalysisClient = {
    execute,
    operationHealthSnapshot: () => ({
      state: "unreachable",
      stage: "connection",
      retryAction: "restart_provider",
      exitCode: null,
      requests: [],
    }),
    close: async (options) => {
      onClose?.();
      if (!allowed) return err(cleanupError);
      await cleanupLease.release();
      if (options?.retainDocument !== true) await rm(document, { force: true });
      return resultOk(null);
    },
  };
  const session = createTestBinarySession((_target, _profile, context) => {
    if (context === undefined) throw new Error("missing analysis run context");
    runIds.push(context.runId);
    created += 1;
    return created === 1
      ? {
          ...client,
          runtimeLineageSnapshots: () => [
            {
              provider: {
                id: "fixture",
                name: "Fixture analysis provider",
                version: "1",
              },
              observation: {
                status: "unavailable" as const,
                observedAt: "2026-10-16T00:00:00Z",
                runId: context.runId,
                launcherPid: 123,
                processGroupId: 123,
                reason: "fixture lineage unavailable",
              },
            },
          ],
        }
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
    runIds,
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
    expect(await session.status()).toMatchObject({
      open: false,
      cleanup_pending: true,
      analysis_run: {
        run_id: fixture.runIds[0],
        process_lineage: {
          status: "snapshots",
          snapshots: [
            { observation: { reason: "fixture lineage unavailable" } },
          ],
        },
      },
      provider_operation_health: { state: "unreachable", stage: "connection" },
    });
    expect(await session.execute("address_name", {})).toMatchObject({
      ok: false,
    });
    await access(runtime);

    expect(await attempt()).toEqual(err(cleanupError));
    expect(await session.status()).toMatchObject({
      analysis_run: { run_id: fixture.runIds[0] },
    });
    expect(fixture.created()).toBe(1);
    await access(runtime);

    fixture.allowCleanup();
    expect((await attempt()).ok).toBe(true);
    expect(await session.status()).toMatchObject({ cleanup_pending: false });
    await expect(access(runtime)).rejects.toMatchObject({ code: "ENOENT" });
    expect(fixture.created()).toBe(transition === "close" ? 1 : 2);
    expect(await session.status()).toMatchObject({
      analysis_run:
        transition === "close"
          ? null
          : {
              run_id: fixture.runIds[1],
              process_lineage: { status: "not_observed" },
            },
    });
    expect(new Set(fixture.runIds).size).toBe(fixture.created());
  },
);

it("settles a retained analysis client before admitting an external mutation", async () => {
  const fixture = await retryFixture();
  const [target] = fixture.targets;
  expect((await fixture.session.open(target)).ok).toBe(true);
  expect(await fixture.session.close()).toEqual(err(fixture.cleanupError));
  const operation = vi.fn(async () => resultOk("provider finished"));
  const mutate = () =>
    fixture.session.withAdmittedExternalMutation(
      target,
      undefined,
      operation,
      (_value, failure) => failure,
    );
  expect(await mutate()).toEqual(err(fixture.cleanupError));
  expect(operation).not.toHaveBeenCalled();
  await access(fixture.runtime);
  fixture.allowCleanup();
  expect(await mutate()).toEqual(resultOk(resultOk("provider finished")));
  expect(operation).toHaveBeenCalledOnce();
  await expect(access(fixture.runtime)).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await fixture.session.status()).toMatchObject({
    cleanup_pending: false,
  });
  await fixture.session.close();
});

it("keeps recorded unknowns when a target switch cannot retire the previous provider", async () => {
  const fixture = await retryFixture();
  const [first, second] = fixture.targets;
  expect((await fixture.session.open(first)).ok).toBe(true);
  expect(
    fixture.session.recordUnknown({
      question: "Does this function reach the network?",
      severity: "medium",
      domain: "network",
      supporting_evidence_ids: [],
      contradicting_evidence_ids: [],
      required_authority: "shipped-artifact",
      required_confidence: "observed",
      required_environment: null,
      recommended_probes: [],
      relationships: [],
    }).ok,
  ).toBe(true);

  const switched = await fixture.session.open(second);

  expect(switched.ok).toBe(false);
  expect(fixture.session.listUnknowns({})).toHaveLength(1);
});

it("keeps a queued close behind an open that is still settling prior cleanup", async () => {
  const fixture = await retryFixture();
  const [first] = fixture.targets;
  const release = createDeferred<void>();
  const order: string[] = [];

  const opening = fixture.session
    .open(first, {
      beforeOpen: async () => {
        order.push("cleanup-start");
        await release.promise;
        order.push("cleanup-end");
        return resultOk(null);
      },
    })
    .then((result) => {
      order.push("open");
      return result;
    });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const closing = fixture.session.close().then((result) => {
    order.push("close");
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(order).toEqual(["cleanup-start"]);

  release.resolve();
  await Promise.all([opening, closing]);

  expect(order).toEqual(["cleanup-start", "cleanup-end", "open", "close"]);
  expect(fixture.session.activeTarget()).toBeUndefined();
});

it("offers a caller's close retry only while the session retains its cleanup", async () => {
  const fixture = await retryFixture();
  expect((await fixture.session.open(fixture.targets[0])).ok).toBe(true);
  // One-shot callers name no retry and therefore receive none.
  const oneShot = await fixture.session.close();
  if (oneShot.ok) throw new Error("Expected retained cleanup");
  expect(projectAnalysisError(oneShot.error)).not.toHaveProperty("recovery");

  const offered = await fixture.session.close({ cleanupRetry: CLOSE_RETRY });
  if (offered.ok) throw new Error("Expected retained cleanup");
  expect(projectAnalysisError(offered.error)).toMatchObject({
    code: "cleanup_incomplete",
    recovery: { kind: "retry_cleanup", operation: "close_binary" },
    details: { resources: [fixture.runtime] },
  });

  fixture.allowCleanup();
  expect((await fixture.session.close({ cleanupRetry: CLOSE_RETRY })).ok).toBe(
    true,
  );
  expect(projectAnalysisError(fixture.cleanupError)).not.toHaveProperty(
    "recovery",
  );
});

it("offers a close retry after a saved snapshot but not after a failed save", async () => {
  const [first] = await createBinarySessionTargets();
  const parent = await createTestTempDirectory("rea-snapshot-close-retry-");
  const failedSave = join(parent, "failed-save.json");
  const savedPath = join(parent, "saved.json");
  const cache = createCacheProvider([]);
  let allowed = false;
  const cleanupError = new ProviderCleanupError("fixture", ["runtime"], {
    reason: "runtime removal denied",
  });
  const provider: AnalysisProvider = {
    ...cache,
    createClient: (...arguments_) => ({
      ...cache.createClient(...arguments_),
      close: async () => (allowed ? resultOk(null) : err(cleanupError)),
    }),
  };
  const session = createTestBinarySession(provider);
  onTestFinished(async () => {
    allowed = true;
    await session.close();
  });
  expect((await session.open(first)).ok).toBe(true);
  // The composite route creates the provider client on first use.
  expect((await session.execute("address_name", {})).ok).toBe(true);

  // A retained session file owner shows the offer does not follow pending
  // cleanup alone: the failed save keeps the target open.
  let releaseFile = false;
  session.resourceScope.retain(
    {
      close: async () => {
        if (!releaseFile) throw new Error("retained descriptor close denied");
      },
      cleanupResources: [failedSave],
    },
    failedSave,
  );
  const saveFailure = new ProviderCleanupError("rea", [failedSave], {
    reason: "snapshot descriptor close denied",
  });
  const write = vi
    .spyOn(session, "writeAnalysisSnapshot")
    .mockResolvedValueOnce(err(saveFailure));
  onTestFinished(() => write.mockRestore());
  expect(
    await session.closeWithSnapshot(failedSave, false, {
      cleanupRetry: CLOSE_RETRY,
    }),
  ).toEqual(err(saveFailure));
  expect(projectAnalysisError(saveFailure)).not.toHaveProperty("recovery");
  expect(await session.status()).toMatchObject({
    open: true,
    cleanup_pending: true,
  });

  releaseFile = true;
  const closed = await session.closeWithSnapshot(savedPath, false, {
    cleanupRetry: CLOSE_RETRY,
  });
  if (closed.ok) throw new Error("Expected retained provider cleanup");
  expect(projectAnalysisError(closed.error)).toMatchObject({
    code: "cleanup_incomplete",
    recovery: { kind: "retry_cleanup", operation: "close_binary" },
    details: {
      resources: ["runtime"],
      partial_observation: { saved_snapshot: { bytes: expect.any(Number) } },
    },
  });
  await access(savedPath);
  allowed = true;
  expect((await session.close({ cleanupRetry: CLOSE_RETRY })).ok).toBe(true);
  expect(await session.status()).toMatchObject({ cleanup_pending: false });
});

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
  expect(await fixture.session.status()).toMatchObject({
    open: false,
    cleanup_pending: true,
    analysis_run: {
      run_id: fixture.runIds[0],
      process_lineage: { status: "snapshots" },
    },
  });
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
  expect(await fixture.session.status()).toMatchObject({
    open: false,
    cleanup_pending: true,
    analysis_run: {
      run_id: fixture.runIds[0],
      process_lineage: { status: "snapshots" },
    },
  });
  fixture.allowCleanup();
  expect((await fixture.session.close()).ok).toBe(true);
  await expect(access(fixture.runtime)).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("keeps cancellation as the primary when previous-client retirement fails after abort", async () => {
  const controller = new AbortController();
  const reason = { phase: "binary-retirement" };
  const fixture = await retryFixture(undefined, () => controller.abort(reason));
  expect((await fixture.session.open(fixture.targets[0])).ok).toBe(true);
  const result = await fixture.session.open(fixture.targets[1], {
    signal: controller.signal,
  });
  if (result.ok) throw new Error("Expected cancelled retirement");
  expect(result.error.cleanupIncomplete).toBe(true);
  expect(result.error.cleanupPrimary).toMatchObject({
    _tag: "AnalysisCancelledError",
  });
  expect(result.error.cleanupPrimary?.cause).toBe(reason);
  expect(await fixture.session.status()).toMatchObject({
    open: false,
    cleanup_pending: true,
  });
  fixture.allowCleanup();
  expect((await fixture.session.close()).ok).toBe(true);
  expect(fixture.cleanupError.cleanupIncomplete).toBe(false);
  expect(result.error.cleanupIncomplete).toBe(false);
  expect(projectAnalysisError(result.error)).toMatchObject({
    code: "cancelled",
  });
  expect(result.error.cleanupPrimary?.cause).toBe(reason);
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
  const runIds: string[] = [];
  const session = createTestBinarySession((_target, _profile, context) => {
    if (context === undefined) throw new Error("missing analysis run context");
    runIds.push(context.runId);
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
  expect(await session.status()).toMatchObject({
    open: false,
    cleanup_pending: true,
    analysis_run: { run_id: runIds[2] },
  });
  expect(new Set(runIds).size).toBe(3);
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
