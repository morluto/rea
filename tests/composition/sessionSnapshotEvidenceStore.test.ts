import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it, onTestFinished } from "vitest";

import { ProjectEvidenceStore } from "../../src/application/investigation/ProjectEvidenceStore.js";
import { createAnalysisProfile } from "../../src/domain/analysisProfile.js";
import { MANAGED_STATIC_PROVIDER } from "../../src/domain/investigationProviders.js";
import { ok } from "../../src/domain/result.js";
import { ManagedStaticProvider } from "../../src/dotnet/ManagedStaticProvider.js";
import { buildManagedPeFixture } from "../../src/dotnet/ManagedPe.fixture.js";
import { createTestBinarySession } from "../fixtures/binarySession.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

/** Open one target through the real static managed reader with a project store. */
const openSession = async (directory: string, storeRoot: string) => {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "application.exe"), buildManagedPeFixture());
  const profile = createAnalysisProfile(MANAGED_STATIC_PROVIDER, {
    fixture: "store-snapshot-import",
  });
  const session = createTestBinarySession(new ManagedStaticProvider(), {
    evidenceStore: new ProjectEvidenceStore(storeRoot),
    resolveAnalysisProfile: () => Promise.resolve(ok({ profile })),
  });
  onTestFinished(async () => {
    await session.close();
  });
  const opened = await session.open(join(directory, "application.exe"));
  if (!opened.ok) throw new Error(JSON.stringify(opened));
  return session;
};

it("persists Evidence imported through a session snapshot", async () => {
  const root = await createTestTempDirectory("rea-store-snapshot-");
  const source = await openSession(
    join(root, "source"),
    join(root, "source-store"),
  );
  const observed = await source.execute("inspect_managed_artifact", {});
  if (!observed.ok) throw observed.error;
  const evidenceId = observed.value.evidenceId;
  if (evidenceId === undefined)
    throw new Error("Real managed observation has no Evidence identity");
  const record = source.evidenceById(evidenceId);
  if (record === undefined) throw new Error("Observation was not retained");
  const snapshot = source.exportAnalysisSnapshot();
  if (!snapshot.ok) throw snapshot.error;
  const closedSource = await source.close();
  expect(closedSource.ok, JSON.stringify(closedSource)).toBe(true);

  // The receiving store has never seen this record; only the import can bring it.
  const targetStoreRoot = join(root, "target-store");
  expect(new ProjectEvidenceStore(targetStoreRoot).read(evidenceId)).toBe(
    undefined,
  );
  const target = await openSession(join(root, "target"), targetStoreRoot);
  const imported = target.importAnalysisSnapshot(snapshot.value);
  expect(imported.ok, JSON.stringify(imported)).toBe(true);
  const closedTarget = await target.close();
  expect(closedTarget.ok, JSON.stringify(closedTarget)).toBe(true);

  expect(new ProjectEvidenceStore(targetStoreRoot).read(evidenceId)).toEqual(
    record,
  );
});
