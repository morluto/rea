import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { runDirectAnalysis } from "../../src/application/DirectAnalysis.js";
import type { DirectAnalysisDependencies } from "../../src/application/DirectAnalysisDependencies.js";
import { BinarySession } from "../../src/application/binary/BinarySession.js";
import { parseConfig } from "../../src/config/parseConfig.js";
import { createAnalysisProfile } from "../../src/domain/analysisProfile.js";
import { ok } from "../../src/domain/result.js";
import {
  createAnalysisExecution,
  type AnalysisProvider,
} from "../../src/ports/AnalysisProvider.js";
import { createTestProviderRouter } from "../fixtures/binarySession.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

// `rea decompile --snapshot` with Ghidra: the session retains the one-shot
// pseudocode as Evidence, so the CLI has a record to reuse.
const GHIDRA = { id: "ghidra", name: "Ghidra", version: "1" } as const;

const ghidraFixture: AnalysisProvider = {
  identity: () => GHIDRA,
  capabilities: () => [
    {
      provider: GHIDRA,
      operation: "procedure_pseudo_code",
      available: true,
      reason: null,
      cachePolicy: "snapshot",
      effects: {
        mutatesArtifact: false,
        launchesProcess: false,
        mayShowUi: false,
        mayAccessNetwork: false,
        mayWriteFilesystem: false,
        changesPermissions: false,
        requiresRoot: false,
      },
      limitations: [],
    },
  ],
  createClient: () => ({
    execute: async () => ok(createAnalysisExecution("int main(void);", GHIDRA)),
    close: async () => ok(null),
  }),
};

it("delivers the record a profiled one-shot session issued and admits it once", async () => {
  const directory = await createTestTempDirectory("rea-direct-reuse-");
  const path = join(directory, "fixture.com");
  await writeFile(path, Buffer.from([0xb8, 0, 0x4c, 0xcd, 0x21]));
  const session = new BinarySession(
    createTestProviderRouter(ghidraFixture, {
      resolveAnalysisProfile: async () =>
        ok({ profile: createAnalysisProfile(GHIDRA, {}) }),
    }),
  );
  const admit = vi.spyOn(session, "admitRecoveryObservation");
  let issued: string | undefined;
  const record = session.recordEvidence.bind(session);
  vi.spyOn(session, "recordEvidence").mockImplementation((evidence) => {
    issued ??= evidence.evidence_id;
    return record(evidence);
  });
  const create = () => session;
  const dependencies: DirectAnalysisDependencies = {
    readConfiguration: () => parseConfig({}),
    createBinarySession: create,
    createNativeDispatchBinarySession: create,
    createArtifactBinarySession: create,
    createNativeBinarySession: create,
    createManagedBinarySession: create,
  };

  const result = await runDirectAnalysis(
    dependencies,
    path,
    "procedure_pseudo_code",
    { procedure: "0x100" },
    { formatHint: "dos-com", snapshotPath: join(directory, "snapshot.json") },
  );

  if (!result.ok) throw new Error(JSON.stringify(result.error));
  // The CLI delivers the session's record with its own path, not a copy.
  expect(issued).toBeDefined();
  expect(result.value.evidence_id).toBe(issued);
  expect(result.value.caller_input_path).toBe(path);
  expect(admit).toHaveBeenCalledTimes(1);
});
