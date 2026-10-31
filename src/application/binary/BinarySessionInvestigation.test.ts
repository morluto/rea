import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";

import { createEvidence } from "../../domain/evidence.js";
import {
  createEvidenceBundle,
  parseEvidenceBundle,
} from "../../domain/evidenceBundle.js";
import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import { err, ok } from "../../domain/result.js";
import type { RecordUnknownInput } from "../../domain/residualUnknown.js";
import { OwnedStagedOutput } from "../../filesystem/OwnedStagedOutput.js";
import {
  ControllableAnalysisClient,
  createBinarySessionTargets,
  createCacheProvider,
  createDeferred,
  createTestBinarySession,
} from "../../../tests/fixtures/binarySession.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";

const observation = (label: string) =>
  createEvidence(
    undefined,
    { id: "fixture", name: "Lifecycle fixture", version: "1" },
    { operation: label, parameters: {}, result: { fixture: label } },
  );
const unknownRequirements: Omit<RecordUnknownInput, "question" | "domain"> = {
  severity: "medium",
  supporting_evidence_ids: [],
  contradicting_evidence_ids: [],
  required_authority: "shipped-artifact",
  required_confidence: "observed",
  required_environment: null,
  recommended_probes: [],
  relationships: [],
};
const unknownInput: RecordUnknownInput = {
  ...unknownRequirements,
  question: "Which source revision produced this lifecycle fixture?",
  domain: "provenance",
};

const seed = (session: ReturnType<typeof createTestBinarySession>) => {
  expect(session.recordEvidence(observation("retained_fixture")).ok).toBe(true);
  const recorded = session.recordUnknown(unknownInput);
  if (!recorded.ok) throw recorded.error;
  expect(
    session.updateUnknown({
      ...unknownRequirements,
      unknown_id: recorded.value.unknown_id,
      expected_revision: 1,
      status: "investigating",
      resolution: null,
    }).ok,
  ).toBe(true);
  return session.exportEvidenceBundle();
};

it("publishes engine retirement with its pending cleanup owner already visible", async () => {
  const [target] = await createBinarySessionTargets();
  const entered = createDeferred<void>();
  const release = createDeferred<void>();
  const provider = createCacheProvider([]);
  const session = createTestBinarySession({
    ...provider,
    createClient: (...arguments_) => ({
      ...provider.createClient(...arguments_),
      close: async () => {
        entered.resolve();
        await release.promise;
        return ok(null);
      },
    }),
  });
  const notifications: ReturnType<typeof session.status>[] = [];
  let unsubscribe: () => void = () => undefined;
  try {
    expect((await session.open(target)).ok).toBe(true);
    expect(
      (
        await session.execute("address_name", {
          address: "0x1000",
          document: "fixture",
        })
      ).ok,
    ).toBe(true);
    unsubscribe = session.onAnalysisSnapshotChanged(() => {
      notifications.push(session.status());
    });
    const closing = session.close();
    await entered.promise;
    expect(notifications.length).toBeGreaterThan(0);
    for (const status of await Promise.all(notifications))
      expect(status).toMatchObject({ open: false, cleanup_pending: true });
    release.resolve();
    expect((await closing).ok).toBe(true);
    expect(await session.status()).toMatchObject({
      open: false,
      cleanup_pending: false,
    });
  } finally {
    unsubscribe();
    release.resolve();
    await session.close();
  }
});

it("preserves metadata invalidation across reset until the mutated engine is retired", async () => {
  const [target] = await createBinarySessionTargets();
  const calls: string[] = [];
  const base = createCacheProvider(calls);
  const createClient = vi.fn(base.createClient);
  const session = createTestBinarySession({ ...base, createClient });
  const parameters = { address: "0x1000", document: "fixture" };
  try {
    expect((await session.open(target)).ok).toBe(true);
    expect((await session.execute("address_name", parameters)).ok).toBe(true);
    const replay = session.exportAnalysisSnapshot();
    if (!replay.ok) throw replay.error;
    expect(replay.value.entries).toHaveLength(1);
    // The fixture declares this operation as a metadata mutation. No real
    // provider or target bytes are changed by the simulated observation.
    expect(
      (
        await session.execute("set_address_name", {
          ...parameters,
          name: "renamed",
        })
      ).ok,
    ).toBe(true);
    expect(session.exportAnalysisSnapshot()).toMatchObject({
      ok: false,
      error: { _tag: "EvidenceIntegrityError" },
    });
    const before = session.exportEvidenceBundle();
    expect(await session.resetInvestigation()).toEqual({
      ok: true,
      value: {
        cleared_evidence_records: before.records.length,
        cleared_unknown_revisions: 0,
        cleared_unknown_heads: 0,
        retained_target: true,
      },
    });
    expect(session.activeTarget()?.path).toBe(target);
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(session.exportAnalysisSnapshot()).toMatchObject({
      ok: false,
      error: { _tag: "EvidenceIntegrityError" },
    });
    expect(session.importAnalysisSnapshot(replay.value)).toMatchObject({
      ok: false,
      error: { _tag: "EvidenceIntegrityError" },
    });
    expect((await session.execute("address_name", parameters)).ok).toBe(true);
    expect((await session.execute("address_name", parameters)).ok).toBe(true);
    expect(
      calls.filter((operation) => operation === "address_name"),
    ).toHaveLength(3);
    expect((await session.close()).ok).toBe(true);
    expect((await session.open(target)).ok).toBe(true);
    expect(session.exportAnalysisSnapshot().ok).toBe(true);
  } finally {
    await session.dispose();
  }
});

it("preserves records through failed disposal and clears them only after its owned cleanup succeeds", async () => {
  const [target] = await createBinarySessionTargets();
  const client = new ControllableAnalysisClient();
  const realClose = client.close.bind(client);
  const failure = new ProviderCleanupError(
    "fixture",
    ["fixture-owned-engine"],
    { reason: "Controlled disposal cleanup refusal" },
  );
  let allowed = false;
  const close = vi
    .spyOn(client, "close")
    .mockImplementation(() =>
      allowed ? realClose() : Promise.resolve(err(failure)),
    );
  const createClient = vi.fn(() => client);
  const session = createTestBinarySession(createClient);
  try {
    expect((await session.open(target)).ok).toBe(true);
    expect(
      (
        await session.execute("address_name", {
          address: "0x1000",
          document: "fixture",
        })
      ).ok,
    ).toBe(true);
    const before = seed(session);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(await session.dispose()).toMatchObject({
        ok: false,
        error: { cleanupIncomplete: true },
      });
      expect(session.exportEvidenceBundle()).toEqual(before);
      expect(session.listUnknowns()[0]?.revision).toBe(2);
      expect(session.activeTarget()).toBeUndefined();
    }
    expect((await session.open(target)).ok).toBe(false);
    expect(createClient).toHaveBeenCalledTimes(1);
    allowed = true;
    expect(await session.dispose()).toEqual(ok(null));
    expect(session.exportEvidenceBundle()).toEqual(createEvidenceBundle([]));
    expect(session.listUnknowns()).toEqual([]);
    const closeCalls = close.mock.calls.length;
    expect(await session.dispose()).toEqual(ok(null));
    expect(close).toHaveBeenCalledTimes(closeCalls);
  } finally {
    allowed = true;
    close.mockRestore();
    await session.dispose();
  }
});

it("drains prior metadata writes and refuses later admissions and direct writes after disposal", async () => {
  const [target] = await createBinarySessionTargets();
  const calls: string[] = [];
  const session = createTestBinarySession(createCacheProvider(calls));
  const entered = createDeferred<void>();
  const release = createDeferred<void>();
  let committedBeforeClear = false;
  try {
    expect((await session.open(target)).ok).toBe(true);
    expect(
      (
        await session.execute("address_name", {
          address: "0x1000",
          document: "fixture",
        })
      ).ok,
    ).toBe(true);
    const snapshot = session.exportAnalysisSnapshot();
    if (!snapshot.ok) throw snapshot.error;
    const before = session.withAdmittedAnalysis(
      "before_dispose",
      undefined,
      async () => {
        entered.resolve();
        await release.promise;
        const record = observation("admitted_before_disposal");
        const written = session.recordEvidence(record);
        committedBeforeClear =
          written.ok && session.hasEvidence(record.evidence_id);
        return written;
      },
    );
    await entered.promise;
    const disposing = session.dispose();
    const late = vi.fn(async () =>
      session.importEvidenceBundle(
        createEvidenceBundle([observation("late_import")]),
      ),
    );
    const after = session.withAdmittedAnalysis(
      "import_evidence_bundle",
      undefined,
      late,
    );
    release.resolve();
    expect((await before).ok).toBe(true);
    expect(committedBeforeClear).toBe(true);
    expect(await disposing).toEqual(ok(null));
    expect((await after).ok).toBe(false);
    expect(late).not.toHaveBeenCalled();
    const afterSettled = vi.fn(async () => session.recordUnknown(unknownInput));
    expect(
      (
        await session.withAdmittedAnalysis(
          "record_unknown",
          undefined,
          afterSettled,
        )
      ).ok,
    ).toBe(false);
    expect(afterSettled).not.toHaveBeenCalled();
    expect(session.recordEvidence(observation("after_dispose")).ok).toBe(false);
    expect(
      session.importEvidenceBundle(
        createEvidenceBundle([observation("after_dispose_import")]),
      ).ok,
    ).toBe(false);
    expect(session.importAnalysisSnapshot(snapshot.value).ok).toBe(false);
    expect(session.recordUnknown(unknownInput).ok).toBe(false);
    expect(
      session.recordEvidenceWithUnknown(
        observation("after_dispose_unknown"),
        unknownInput,
      ).ok,
    ).toBe(false);
    expect((await session.open(target)).ok).toBe(false);
    expect((await session.openBundleResources(target)).ok).toBe(false);
    expect(session.exportEvidenceBundle()).toEqual(createEvidenceBundle([]));
  } finally {
    release.resolve();
    await session.dispose();
  }
});

it.each(["preaborted", "queued"] as const)(
  "preserves exact reset cancellation reason when %s",
  async (phase) => {
    const root = await createTestTempDirectory("rea-reset-cancel-reason-");
    const session = createTestBinarySession(
      () => new ControllableAnalysisClient(),
    );
    const before = seed(session);
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const reason = { caller: "explicit reset cancellation", phase };
    const controller = new AbortController();
    const path = join(root, "must-not-publish.json");
    let blocker: Promise<unknown> | undefined;
    try {
      if (phase === "queued") {
        blocker = session.withAdmittedAnalysis(
          "before_reset",
          undefined,
          async () => {
            entered.resolve();
            await release.promise;
          },
        );
        await entered.promise;
      } else controller.abort(reason);
      const resetting = session.resetInvestigation({
        savePath: path,
        signal: controller.signal,
      });
      if (phase === "queued") controller.abort(reason);
      release.resolve();
      await blocker;
      const result = await resetting;
      if (result.ok) throw new Error("Cancelled reset reported success");
      expect(result.error._tag).toBe("AnalysisCancelledError");
      expect(result.error.cause).toBe(reason);
      expect(session.exportEvidenceBundle()).toEqual(before);
      await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      release.resolve();
      await blocker;
      await session.dispose();
    }
  },
);

it("retains exact cancellation reason and a complete checkpoint during final cleanup", async () => {
  const root = await createTestTempDirectory("rea-reset-final-cancel-");
  const path = join(root, "published.json");
  const session = createTestBinarySession(
    () => new ControllableAnalysisClient(),
  );
  const before = seed(session);
  const reason = { caller: "cancel reset after actual staged-output cleanup" };
  const controller = new AbortController();
  const original = OwnedStagedOutput.prototype.close;
  let interrupted = false;
  const seam = vi
    .spyOn(OwnedStagedOutput.prototype, "close")
    .mockImplementation(async function (this: OwnedStagedOutput) {
      await original.call(this);
      if (dirname(this.directory) === root && !interrupted) {
        interrupted = true;
        controller.abort(reason);
      }
    });
  try {
    const result = await session.resetInvestigation({
      savePath: path,
      signal: controller.signal,
    });
    if (result.ok) throw new Error("Cancelled reset reported success");
    expect(interrupted).toBe(true);
    expect(result.error._tag).toBe("AnalysisCancelledError");
    expect(result.error.cause).toBe(reason);
    const saved = await readFile(path);
    expect(parseEvidenceBundle(JSON.parse(saved.toString("utf8")))).toEqual(
      before,
    );
    expect(result.error.diagnostics?.saved_bundle).toEqual({
      path,
      bytes: saved.length,
      records: before.records.length,
      unknowns: before.unknowns.length,
    });
    expect(session.exportEvidenceBundle()).toEqual(before);
    expect((await session.resetInvestigation()).ok).toBe(true);
    expect(session.exportEvidenceBundle()).toEqual(createEvidenceBundle([]));
  } finally {
    seam.mockRestore();
    await session.dispose();
  }
});
