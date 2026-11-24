import { unknownTarget } from "../../../src/domain/targetIdentity.js";
import { expect, it, onTestFinished } from "vitest";

import { BinarySession } from "../../../src/application/binary/BinarySession.js";
import { InvestigationRecords } from "../../../src/application/investigation/InvestigationRecords.js";
import { immutableAnalysisSnapshot } from "../../../src/domain/analysisSnapshot.js";
import { createEvidence } from "../../../src/domain/evidence.js";
import { createImmutableEvidenceBundle } from "../../../src/domain/evidenceBundle.js";
import { ok } from "../../../src/domain/result.js";
import { createAnalysisExecution } from "../../../src/ports/AnalysisProvider.js";
import { recordUnknownInputSchema } from "../../../src/domain/residualUnknown.js";
import {
  createBinarySessionTargets,
  createCacheProvider,
  createTestBinarySession,
  createTestProviderRouter,
} from "../../fixtures/binarySession.js";

const ownSession = (session: BinarySession): BinarySession => {
  onTestFinished(async () => {
    const closed = await session.close();
    if (!closed.ok) throw closed.error;
  });
  return session;
};

const createSession = (
  records: InvestigationRecords = new InvestigationRecords(),
) =>
  ownSession(
    new BinarySession(
      createTestProviderRouter(createCacheProvider([])),
      records,
    ),
  );

it("uses the composed record owner and preserves best-effort post-commit notifications", async () => {
  const records = new InvestigationRecords();
  const session = createSession(records);
  const observed: number[] = [];
  const unsubscribe = session.onAnalysisSnapshotChanged(() => {
    observed.push(records.exportEvidenceBundle().records.length);
  });
  session.onAnalysisSnapshotChanged(() => {
    throw new Error("Synthetic observer failure");
  });
  session.onAnalysisSnapshotChanged(async () => {
    throw new Error("Synthetic async observer failure");
  });
  const evidence = createEvidence(
    unknownTarget("not-observed"),
    { id: "fixture", name: "Fixture", version: "1" },
    { operation: "independent-app", parameters: {}, result: true },
  );
  expect(session.recordEvidence(evidence)).toEqual({
    ok: true,
    value: "added",
  });
  expect(records.evidenceById(evidence.evidence_id)).toEqual(evidence);
  expect(session.recordEvidence(evidence)).toEqual({
    ok: true,
    value: "duplicate",
  });
  expect(observed).toEqual([1]);
  expect((await session.close()).ok).toBe(true);
  expect(records.exportEvidenceBundle().records).toEqual([evidence]);
  expect(session.exportAnalysisSnapshot()).toMatchObject({
    ok: false,
    error: { _tag: "NoBinaryOpenError" },
  });
  expect(observed).toEqual([1, 1]);
  expect((await session.resetInvestigation()).ok).toBe(true);
  expect(records.exportEvidenceBundle().records).toEqual([]);
  expect(observed).toEqual([1, 1, 0]);
  unsubscribe();
  await new Promise<void>((resolve) => setImmediate(resolve));
});

it("notifies after snapshot and Evidence import both commit, and rejects mismatched targets atomically", async () => {
  const [first, second] = await createBinarySessionTargets();
  const source = ownSession(createTestBinarySession(createCacheProvider([])));
  expect((await source.open(first)).ok).toBe(true);
  expect(
    (
      await source.execute("address_name", {
        address: "0x1000",
        document: "fixture",
      })
    ).ok,
  ).toBe(true);
  const exported = source.exportAnalysisSnapshot();
  if (!exported.ok) throw exported.error;
  expect(exported.value.entries.length).toBeGreaterThan(0);
  const recipient = createSession();
  expect((await recipient.open(first)).ok).toBe(true);
  const notifications: Array<{ entries: number; evidence: number }> = [];
  recipient.onAnalysisSnapshotChanged(() => {
    const snapshot = recipient.exportAnalysisSnapshot();
    if (!snapshot.ok) throw snapshot.error;
    notifications.push({
      entries: snapshot.value.entries.length,
      evidence: snapshot.value.evidence_bundle.records.length,
    });
  });
  expect(recipient.importAnalysisSnapshot(exported.value).ok).toBe(true);
  expect(notifications).toEqual([
    {
      entries: exported.value.entries.length,
      evidence: exported.value.evidence_bundle.records.length,
    },
  ]);
  const incompatible = createSession();
  expect((await incompatible.open(second)).ok).toBe(true);
  let mismatchNotifications = 0;
  incompatible.onAnalysisSnapshotChanged(() => {
    mismatchNotifications += 1;
  });
  const before = incompatible.exportEvidenceBundle();
  expect(incompatible.importAnalysisSnapshot(exported.value).ok).toBe(false);
  expect(incompatible.exportEvidenceBundle()).toEqual(before);
  expect(mismatchNotifications).toBe(0);
});

it("notifies an Unknown-only bundle change even when no new Evidence is added", () => {
  const source = createSession();
  expect(
    source.recordUnknown(
      recordUnknownInputSchema.parse({
        question: "Is this import complete?",
        severity: "medium",
        domain: "investigation",
        required_authority: "analyst-inference",
        required_confidence: "derived",
        required_environment: null,
        recommended_probes: [],
        relationships: [],
      }),
    ).ok,
  ).toBe(true);
  const bundle = source.exportEvidenceBundle();
  const recipient = createSession();
  expect(recipient.importEvidenceBundle({ ...bundle, unknowns: [] }).ok).toBe(
    true,
  );
  const revisions: number[] = [];
  recipient.onAnalysisSnapshotChanged(() => {
    revisions.push(recipient.listUnknowns().length);
  });
  expect(recipient.importEvidenceBundle(bundle)).toEqual({
    ok: true,
    value: {
      recordsAdded: 0,
      unknownsAdded: 1,
      totalRecords: bundle.records.length,
    },
  });
  expect(revisions).toEqual([1]);
  expect(recipient.importEvidenceBundle(bundle)).toEqual({
    ok: true,
    value: {
      recordsAdded: 0,
      unknownsAdded: 0,
      totalRecords: bundle.records.length,
    },
  });
  expect(revisions).toEqual([1]);
});

it("detaches exported snapshot payloads after sealed bundle or snapshot import while keeping internal reads shared", async () => {
  const [first] = await createBinarySessionTargets();
  const session = createSession();
  expect((await session.open(first)).ok).toBe(true);
  const target = session.activeTarget();
  if (target === undefined) throw new Error("Missing open target");
  const evidence = createEvidence(
    target,
    { id: "fixture", name: "Fixture analysis provider", version: "1" },
    {
      operation: "address_name",
      parameters: { address: "0x1000", nested: { flag: true } },
      result: { nested: ["observed"] },
      rawResult: { raw: ["payload"] },
    },
  );
  const sealedBundle = createImmutableEvidenceBundle([evidence]);
  expect(session.importEvidenceBundle(sealedBundle).ok).toBe(true);

  const exported = session.exportAnalysisSnapshot();
  if (!exported.ok) throw exported.error;
  const exportedRecord = exported.value.evidence_bundle.records.find(
    (record) => record.evidence_id === evidence.evidence_id,
  );
  if (exportedRecord === undefined)
    throw new Error("Missing exported Evidence record");
  expect(Object.isFrozen(exportedRecord.normalized_result)).toBe(false);
  expect(Object.isFrozen(exportedRecord.raw_result)).toBe(false);
  expect(Object.isFrozen(exportedRecord.parameters)).toBe(false);
  const normalized = exportedRecord.normalized_result as {
    nested: string[];
    added?: string;
  };
  normalized.added = "edited";
  normalized.nested.push("edited-item");
  const raw = exportedRecord.raw_result as { raw: string[]; edited?: boolean };
  raw.edited = true;
  raw.raw.push("edited-raw");
  expect(exportedRecord.normalized_result).toEqual({
    nested: ["observed", "edited-item"],
    added: "edited",
  });
  expect(exportedRecord.raw_result).toEqual({
    raw: ["payload", "edited-raw"],
    edited: true,
  });

  // Internal reads still share the sealed immutable snapshot untouched.
  const borrowedRecord = session.evidenceForAnalysis(evidence.evidence_id);
  const borrowedBundle = session.immutableEvidenceBundle();
  expect(borrowedRecord).toBe(sealedBundle.records[0]);
  expect(borrowedBundle.records[0]).toBe(borrowedRecord);
  expect(Object.isFrozen(borrowedRecord)).toBe(true);
  expect(Object.isFrozen(borrowedRecord?.normalized_result)).toBe(true);
  expect(Object.isFrozen(borrowedRecord?.raw_result)).toBe(true);
  expect(borrowedRecord).toEqual(evidence);

  // Imported sealed AnalysisSnapshot entries are also detached on export.
  const baseProvider = createCacheProvider([]);
  const source = ownSession(
    createTestBinarySession({
      ...baseProvider,
      createClient: () => ({
        execute: () =>
          Promise.resolve(
            ok(
              createAnalysisExecution(
                { nested: ["entry-observed"] },
                baseProvider.identity(),
                { rawResult: { raw: ["entry-raw"] } },
              ),
            ),
          ),
        close: () => Promise.resolve(ok(null)),
      }),
    }),
  );
  expect((await source.open(first)).ok).toBe(true);
  expect(
    (
      await source.execute("address_name", {
        address: "0x1000",
        document: "fixture",
      })
    ).ok,
  ).toBe(true);
  const sourceSnapshot = source.exportAnalysisSnapshot();
  if (!sourceSnapshot.ok) throw sourceSnapshot.error;
  const sealedSnapshot = immutableAnalysisSnapshot(sourceSnapshot.value);
  const recipient = createSession();
  expect((await recipient.open(first)).ok).toBe(true);
  expect(recipient.importAnalysisSnapshot(sealedSnapshot).ok).toBe(true);
  const reExported = recipient.exportAnalysisSnapshot();
  if (!reExported.ok) throw reExported.error;
  const reExportedEntry = reExported.value.entries[0];
  if (reExportedEntry === undefined)
    throw new Error("Missing re-exported snapshot entry");
  expect(Object.isFrozen(reExportedEntry.execution.result)).toBe(false);
  expect(Object.isFrozen(reExportedEntry.execution.raw_result)).toBe(false);
  expect(Object.isFrozen(reExportedEntry.parameters)).toBe(false);
  (
    reExportedEntry.execution.result as { nested: string[]; edited?: boolean }
  ).edited = true;
  (reExportedEntry.execution.result as { nested: string[] }).nested.push(
    "edited-entry",
  );
  (
    reExportedEntry.execution.raw_result as { raw: string[]; edited?: boolean }
  ).edited = true;
  expect(reExportedEntry.execution.result).toEqual({
    nested: ["entry-observed", "edited-entry"],
    edited: true,
  });
  expect(
    (reExportedEntry.execution.raw_result as { edited?: boolean }).edited,
  ).toBe(true);
  const recipientRecord = recipient.immutableEvidenceBundle().records[0];
  expect(Object.isFrozen(recipientRecord)).toBe(true);
  expect(Object.isFrozen(recipientRecord?.normalized_result)).toBe(true);
  expect(recipientRecord?.normalized_result).toEqual({
    nested: ["entry-observed"],
  });
});
